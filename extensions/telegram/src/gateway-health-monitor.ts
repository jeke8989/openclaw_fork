/**
 * Gateway health monitor for Telegram bot.
 *
 * The Telegram bot runs INSIDE the gateway process. This means:
 * 1. If the bot can run a check, the gateway process is alive by definition.
 * 2. We CANNOT auto-restart the gateway — it causes infinite restart loops.
 *
 * This monitor only sends notifications to the admin when the gateway RPC
 * port stops responding. Auto-restart is intentionally NOT included.
 * Use /gwrestart manually if needed.
 *
 * All user-facing messages in Russian.
 */
import net from "node:net";
import { hostname } from "node:os";
import type { Bot } from "grammy";
import { withTelegramApiErrorLogging } from "./api-logging.js";

const DEFAULT_CHECK_INTERVAL_MS = 120_000;
const DEFAULT_GATEWAY_PORT = 18789;
// Don't send more than one "down" notification per this interval.
const NOTIFICATION_COOLDOWN_MS = 30 * 60_000;

export interface GatewayHealthMonitorParams {
  bot: Bot;
  ownerUserId: string;
  gatewayHost?: string;
  gatewayPort?: number;
  checkIntervalMs?: number;
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

export function startGatewayHealthMonitor(params: GatewayHealthMonitorParams): {
  stop: () => void;
} {
  const {
    bot,
    ownerUserId,
    gatewayPort = DEFAULT_GATEWAY_PORT,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    abortSignal,
  } = params;

  let wasHealthy = true;
  let lastDownNotifiedAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

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

  async function doCheck(): Promise<void> {
    const alive = await tcpProbe(gatewayPort);
    const now = Date.now();

    if (alive) {
      if (!wasHealthy) {
        await notifyAdmin(`✅ *${displayHost}*\nGateway (порт ${gatewayPort}) снова отвечает.`);
        wasHealthy = true;
      }
      return;
    }

    // Port is not responding — notify (with cooldown to avoid spam)
    if (wasHealthy || now - lastDownNotifiedAt > NOTIFICATION_COOLDOWN_MS) {
      wasHealthy = false;
      lastDownNotifiedAt = now;
      await notifyAdmin(
        [
          `⚠️ *${displayHost}*`,
          `Gateway не отвечает на порту ${gatewayPort}.`,
          `Используйте /gwrestart для перезапуска.`,
        ].join("\n"),
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

  timer = setInterval(() => {
    void doCheck();
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
