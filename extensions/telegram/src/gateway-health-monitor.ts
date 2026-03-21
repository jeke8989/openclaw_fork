/**
 * Gateway health monitor for Telegram bot.
 *
 * The Telegram bot runs INSIDE the gateway process. This means we cannot
 * kill-and-restart the gateway externally — that would kill the bot itself.
 * Instead, we use the gateway's built-in SIGUSR1 graceful restart mechanism:
 * the run-loop drains active work, stops channels, then restarts in-process.
 * The bot reconnects automatically after the restart cycle completes.
 *
 * All user-facing messages in Russian.
 */
import net from "node:net";
import { hostname } from "node:os";
import type { Bot } from "grammy";
import { scheduleGatewaySigusr1Restart } from "../../../src/infra/restart.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";

const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_GATEWAY_PORT = 18789;
// After SIGUSR1 restart, wait this long before checking again.
// The gateway needs time to drain, restart, and re-bind the port.
const POST_RESTART_COOLDOWN_MS = 90_000;

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

/**
 * Monitor states:
 * - "healthy": gateway is responding normally
 * - "suspect": one failed check, waiting to confirm
 * - "restarting": SIGUSR1 sent, waiting for restart cycle to complete
 */
type Phase = "healthy" | "suspect" | "restarting";

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

  let phase: Phase = "healthy";
  let restartRequestedAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const displayHost = resolveDisplayHost(params.gatewayHost);

  async function notifyAdmin(text: string): Promise<void> {
    try {
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: () => bot.api.sendMessage(Number(ownerUserId), text, { parse_mode: "Markdown" }),
      });
    } catch {
      // Best-effort — bot may be mid-restart
    }
  }

  async function doCheck(): Promise<void> {
    const now = Date.now();

    // If we recently requested a restart, skip checks until cooldown expires.
    // The gateway restart cycle (drain → stop channels → restart → rebind)
    // takes time, and the bot itself will be stopped and restarted.
    if (phase === "restarting") {
      if (now - restartRequestedAt < POST_RESTART_COOLDOWN_MS) return;
      // Cooldown expired — check if gateway came back
      const alive = await tcpProbe(gatewayPort);
      if (alive) {
        phase = "healthy";
        // Don't notify — the bot was restarted, so this is a fresh monitor instance.
        // If we're still the same instance, the restart didn't fully cycle yet.
      } else {
        // Gateway still not up after cooldown — request another restart
        restartRequestedAt = now;
        await notifyAdmin(
          `⚠️ *${displayHost}*\nGateway всё ещё недоступен после рестарта. Повторяю SIGUSR1...`,
        );
        scheduleGatewaySigusr1Restart({ reason: "health-monitor: still down after restart" });
      }
      return;
    }

    const alive = await tcpProbe(gatewayPort);

    if (alive) {
      if (phase === "suspect") {
        // Was suspect, now recovered — transient blip
        phase = "healthy";
      }
      return;
    }

    // Gateway is not responding
    if (phase === "healthy") {
      // First failure — might be transient, wait one more cycle
      phase = "suspect";
      return;
    }

    // phase === "suspect": confirmed down after two consecutive failures
    phase = "restarting";
    restartRequestedAt = now;

    await notifyAdmin(
      `⚠️ *${displayHost}*\nGateway не отвечает (порт ${gatewayPort}). Отправляю SIGUSR1 для рестарта...`,
    );

    // Request graceful in-process restart. The run-loop will:
    // 1. Drain active agent turns
    // 2. Stop all channels (including this Telegram bot)
    // 3. Restart the gateway server
    // 4. Channels come back up with fresh bot + fresh health monitor
    scheduleGatewaySigusr1Restart({
      reason: "health-monitor: gateway port unresponsive",
      delayMs: 2000,
    });
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
