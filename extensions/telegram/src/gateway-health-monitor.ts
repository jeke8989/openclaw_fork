/**
 * Gateway health monitor for Telegram bot.
 * Periodically checks gateway availability, attempts auto-restart,
 * and notifies the admin via Telegram.
 * All user-facing messages in Russian.
 */
import { exec } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import type { Bot } from "grammy";
import { withTelegramApiErrorLogging } from "./api-logging.js";

const execAsync = promisify(exec);

const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_GATEWAY_PORT = 18789;
const MAX_RESTART_ATTEMPTS = 2;

export interface GatewayHealthMonitorParams {
  bot: Bot;
  ownerUserId: string;
  /** Gateway host for display in notifications. */
  gatewayHost?: string;
  /** Gateway port to check (default: 18789). */
  gatewayPort?: number;
  /** Check interval in ms (default: 60000). */
  checkIntervalMs?: number;
  /** Custom restart command. Default: pkill + nohup openclaw gateway run. */
  restartCommand?: string;
  /** AbortSignal to stop the monitor. */
  abortSignal?: AbortSignal;
}

type MonitorState = {
  healthy: boolean;
  consecutiveFailures: number;
  restartAttempts: number;
  lastNotifiedAt: number;
};

/**
 * Start the gateway health monitor. Returns a stop function.
 */
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
    gatewayHost === "localhost" || gatewayHost === "127.0.0.1" ? getHostname() : gatewayHost;

  async function checkHealth(): Promise<boolean> {
    try {
      // Check if anything is listening on the gateway port
      const { stdout } = await execAsync(
        `ss -tlnp 2>/dev/null | grep -q ':${gatewayPort}' && echo ok || echo fail`,
        { timeout: 5000 },
      );
      return stdout.trim() === "ok";
    } catch {
      return false;
    }
  }

  async function attemptRestart(): Promise<boolean> {
    const cmd =
      restartCommand ??
      `pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1; nohup openclaw gateway run --bind loopback --port ${gatewayPort} --force > /tmp/openclaw-gateway.log 2>&1 &`;
    try {
      await execAsync(cmd, { timeout: 15000 });
      // Wait a bit then verify
      await new Promise((r) => setTimeout(r, 3000));
      return await checkHealth();
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
      // Best-effort notification
    }
  }

  async function runCheck(): Promise<void> {
    const healthy = await checkHealth();

    if (healthy) {
      if (!state.healthy) {
        // Recovered
        await notifyAdmin(`✅ *${displayHost}*\nGateway восстановлен и работает.`);
        state.healthy = true;
        state.consecutiveFailures = 0;
        state.restartAttempts = 0;
      }
      return;
    }

    // Unhealthy
    state.consecutiveFailures++;

    if (state.consecutiveFailures === 1) {
      // First failure — could be transient, wait for next check
      return;
    }

    if (state.consecutiveFailures === 2) {
      // Confirmed down — notify and try restart
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

      // All restart attempts failed
      await notifyAdmin(
        `⚠️ *${displayHost}* ❌\nGateway НЕ восстановился! Требуется ручное вмешательство.`,
      );
      return;
    }

    // Subsequent failures — notify every 10 minutes max
    const now = Date.now();
    if (now - state.lastNotifiedAt > 10 * 60_000) {
      state.lastNotifiedAt = now;
      await notifyAdmin(
        `⚠️ *${displayHost}*\nGateway по-прежнему недоступен (${state.consecutiveFailures} проверок подряд).`,
      );
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

  // Start periodic checks (delay first check by one interval)
  timer = setInterval(() => {
    void runCheck();
  }, checkIntervalMs);

  return { stop };
}

function getHostname(): string {
  try {
    return hostname();
  } catch {
    return "localhost";
  }
}
