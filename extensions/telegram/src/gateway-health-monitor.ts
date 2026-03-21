/**
 * Gateway health monitor for Telegram bot.
 * Periodically checks gateway availability, attempts auto-restart,
 * and notifies the admin via Telegram.
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
const MAX_RESTART_ATTEMPTS = 3;

export interface GatewayHealthMonitorParams {
  bot: Bot;
  ownerUserId: string;
  gatewayHost?: string;
  gatewayPort?: number;
  checkIntervalMs?: number;
  restartCommand?: string;
  abortSignal?: AbortSignal;
}

type MonitorState = {
  healthy: boolean;
  consecutiveFailures: number;
  restartAttempts: number;
  lastNotifiedAt: number;
};

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

export function startGatewayHealthMonitor(params: GatewayHealthMonitorParams): {
  stop: () => void;
} {
  const {
    bot,
    ownerUserId,
    gatewayHost = "localhost",
    gatewayPort = DEFAULT_GATEWAY_PORT,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    restartCommand,
    abortSignal,
  } = params;

  const state: MonitorState = {
    healthy: true,
    consecutiveFailures: 0,
    restartAttempts: 0,
    lastNotifiedAt: 0,
  };

  let timer: ReturnType<typeof setInterval> | null = null;

  const displayHost =
    gatewayHost === "localhost" || gatewayHost === "127.0.0.1" ? safeHostname() : gatewayHost;

  async function checkHealth(): Promise<boolean> {
    return tcpProbe(gatewayPort);
  }

  function buildRestartCommand(): string {
    if (restartCommand) return restartCommand;
    // Kill any existing openclaw gateway process, then start fresh.
    // Process is "node ... openclaw gateway run" or "openclaw gateway run".
    return [
      `fuser -k ${gatewayPort}/tcp 2>/dev/null || true`,
      `sleep 2`,
      `nohup openclaw gateway run --bind loopback --port ${gatewayPort} --force > /tmp/openclaw-gateway.log 2>&1 &`,
    ].join("; ");
  }

  async function attemptRestart(): Promise<boolean> {
    try {
      await execAsync(buildRestartCommand(), { timeout: 20000 });
      // Wait for gateway to bind the port
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await checkHealth()) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

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

  async function runCheck(): Promise<void> {
    const healthy = await checkHealth();

    if (healthy) {
      if (!state.healthy) {
        await notifyAdmin(`✅ *${displayHost}*\nGateway восстановлен и работает.`);
        state.healthy = true;
        state.consecutiveFailures = 0;
        state.restartAttempts = 0;
      }
      return;
    }

    state.consecutiveFailures++;

    // First failure — could be transient
    if (state.consecutiveFailures === 1) return;

    if (state.consecutiveFailures === 2) {
      state.healthy = false;
      await notifyAdmin(`⚠️ *${displayHost}*\nGateway не отвечает. Перезапускаю...`);

      for (let attempt = 0; attempt < MAX_RESTART_ATTEMPTS; attempt++) {
        state.restartAttempts++;
        const recovered = await attemptRestart();
        if (recovered) {
          await notifyAdmin(`✅ *${displayHost}*\nGateway успешно перезапущен.`);
          state.healthy = true;
          state.consecutiveFailures = 0;
          state.restartAttempts = 0;
          return;
        }
      }

      // Failed to restart — get last log lines for diagnosis
      let logTail = "";
      try {
        const { stdout } = await execAsync("tail -n 15 /tmp/openclaw-gateway.log 2>/dev/null", {
          timeout: 3000,
        });
        logTail = stdout.trim();
      } catch {
        // ignore
      }

      const msg = [
        `⚠️ *${displayHost}* ❌`,
        `Gateway НЕ восстановился! Требуется ручное вмешательство.`,
      ];
      if (logTail) {
        const truncated = logTail.length > 1500 ? `...${logTail.slice(-1500)}` : logTail;
        msg.push("", `Последние логи:\n\`\`\`\n${truncated}\n\`\`\``);
      }
      await notifyAdmin(msg.join("\n"));
      return;
    }

    // Ongoing failure — retry restart every 5 minutes
    const now = Date.now();
    if (now - state.lastNotifiedAt > 5 * 60_000) {
      state.lastNotifiedAt = now;
      // Try restart again
      const recovered = await attemptRestart();
      if (recovered) {
        await notifyAdmin(`✅ *${displayHost}*\nGateway восстановлен после повторного рестарта.`);
        state.healthy = true;
        state.consecutiveFailures = 0;
        state.restartAttempts = 0;
      } else {
        await notifyAdmin(
          `⚠️ *${displayHost}*\nGateway по-прежнему недоступен (${state.consecutiveFailures} проверок). Последняя попытка рестарта не помогла.`,
        );
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

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return "localhost";
  }
}
