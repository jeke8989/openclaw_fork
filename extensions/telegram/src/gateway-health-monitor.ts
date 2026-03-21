/**
 * Gateway health monitor for Telegram bot.
 * Periodically checks gateway availability via TCP probe,
 * attempts auto-restart on failure, and notifies admin via Telegram.
 * All user-facing messages in Russian.
 */
import { exec } from "node:child_process";
import net from "node:net";
import { hostname } from "node:os";
import { promisify } from "node:util";
import type { Bot } from "grammy";
import { withTelegramApiErrorLogging } from "./api-logging.js";

const execAsync = promisify(exec);

const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_GATEWAY_PORT = 18789;
// After all restart attempts fail, wait this long before trying again.
const RETRY_COOLDOWN_MS = 10 * 60_000;

export interface GatewayHealthMonitorParams {
  bot: Bot;
  ownerUserId: string;
  gatewayHost?: string;
  gatewayPort?: number;
  checkIntervalMs?: number;
  restartCommand?: string;
  abortSignal?: AbortSignal;
}

/** TCP connect probe — works without root and without ss/netstat. */
function tcpProbe(port: number, host = "127.0.0.1", timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Monitor states:
 * - "healthy": gateway is responding
 * - "suspect": first failure detected, waiting to confirm
 * - "restarting": actively trying to restart
 * - "failed": all restart attempts exhausted, in cooldown
 */
type Phase = "healthy" | "suspect" | "restarting" | "failed";

export function startGatewayHealthMonitor(params: GatewayHealthMonitorParams): {
  stop: () => void;
} {
  const {
    bot,
    ownerUserId,
    gatewayPort = DEFAULT_GATEWAY_PORT,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    restartCommand,
    abortSignal,
  } = params;

  let phase: Phase = "healthy";
  let failedSince = 0;
  let lastRestartAttemptAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  // Guard against overlapping checks (restart takes time)
  let checking = false;

  const displayHost = resolveDisplayHost(params.gatewayHost);

  async function notifyAdmin(text: string): Promise<void> {
    try {
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: () => bot.api.sendMessage(Number(ownerUserId), text, { parse_mode: "Markdown" }),
      });
    } catch {
      // Best-effort
    }
  }

  function buildKillCommand(): string {
    // Use --force flag on openclaw gateway run, which internally uses lsof to
    // find and kill stale listeners. As fallback, try lsof + kill manually.
    return [
      // Try lsof-based kill (works on most Linux)
      `lsof -nP -iTCP:${gatewayPort} -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null || true`,
      // Fallback: fuser
      `fuser -k ${gatewayPort}/tcp 2>/dev/null || true`,
    ].join("; ");
  }

  function buildRestartCommand(): string {
    if (restartCommand) return restartCommand;
    return [
      buildKillCommand(),
      `sleep 2`,
      // --force handles any remaining stale locks/listeners
      `nohup openclaw gateway run --bind loopback --port ${gatewayPort} --force > /tmp/openclaw-gateway.log 2>&1 &`,
    ].join("; ");
  }

  async function attemptRestart(): Promise<boolean> {
    try {
      await execAsync(buildRestartCommand(), { timeout: 30000 });
      // Poll up to 15 seconds for gateway to come up
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        if (await tcpProbe(gatewayPort)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async function getLogTail(): Promise<string> {
    try {
      const { stdout } = await execAsync("tail -n 15 /tmp/openclaw-gateway.log 2>/dev/null", {
        timeout: 3000,
      });
      return stdout.trim();
    } catch {
      return "";
    }
  }

  async function runCheck(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      await doCheck();
    } finally {
      checking = false;
    }
  }

  async function doCheck(): Promise<void> {
    const alive = await tcpProbe(gatewayPort);

    // -- Gateway is up --
    if (alive) {
      if (phase !== "healthy") {
        await notifyAdmin(`✅ *${displayHost}*\nGateway восстановлен и работает.`);
      }
      phase = "healthy";
      failedSince = 0;
      return;
    }

    // -- Gateway is down --
    const now = Date.now();

    switch (phase) {
      case "healthy":
        // First failure — might be transient, wait one more cycle
        phase = "suspect";
        failedSince = now;
        return;

      case "suspect": {
        // Confirmed down — attempt restart
        phase = "restarting";
        await notifyAdmin(
          `⚠️ *${displayHost}*\nGateway не отвечает (порт ${gatewayPort}). Перезапускаю...`,
        );

        const recovered = await attemptRestart();
        lastRestartAttemptAt = Date.now();

        if (recovered) {
          await notifyAdmin(`✅ *${displayHost}*\nGateway успешно перезапущен.`);
          phase = "healthy";
          failedSince = 0;
        } else {
          phase = "failed";
          const logTail = await getLogTail();
          const msg = [
            `❌ *${displayHost}*\nGateway не удалось перезапустить.`,
            `Следующая попытка через 10 мин.`,
          ];
          if (logTail) {
            const t = logTail.length > 1500 ? `...${logTail.slice(-1500)}` : logTail;
            msg.push("", `Логи:\n\`\`\`\n${t}\n\`\`\``);
          }
          await notifyAdmin(msg.join("\n"));
        }
        return;
      }

      case "restarting":
        // Still in restart process (shouldn't happen due to `checking` guard)
        return;

      case "failed": {
        // In cooldown — only retry after RETRY_COOLDOWN_MS
        if (now - lastRestartAttemptAt < RETRY_COOLDOWN_MS) return;

        // Try again silently (no spam)
        const recovered = await attemptRestart();
        lastRestartAttemptAt = Date.now();

        if (recovered) {
          await notifyAdmin(`✅ *${displayHost}*\nGateway восстановлен после повторного рестарта.`);
          phase = "healthy";
          failedSince = 0;
        }
        // If still failed — stay in "failed" phase, try again after next cooldown.
        // No notification to avoid spam.
        return;
      }
    }
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  if (abortSignal) {
    abortSignal.addEventListener("abort", stop, { once: true });
  }

  timer = setInterval(() => {
    void runCheck();
  }, checkIntervalMs);

  return { stop };
}

function resolveDisplayHost(gatewayHost?: string): string {
  if (gatewayHost && gatewayHost !== "localhost" && gatewayHost !== "127.0.0.1") {
    return gatewayHost;
  }
  try {
    return hostname();
  } catch {
    return "localhost";
  }
}
