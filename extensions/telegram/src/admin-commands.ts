/**
 * Admin commands for Telegram bot: /setkey, /settoken, /gw, /gwrestart, /logs
 * Bot is personal (single-user) — no invite or multi-user management.
 * All user-facing messages in Russian.
 */
import { exec } from "node:child_process";
import net from "node:net";
import { hostname } from "node:os";
import { promisify } from "node:util";
import type { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { writeOAuthCredentials } from "../../../src/plugins/provider-auth-helpers.js";
import {
  setAnthropicApiKey,
  setOpenaiApiKey,
  setGeminiApiKey,
  setOpenrouterApiKey,
  setMistralApiKey,
  setXaiApiKey,
} from "../../../src/plugins/provider-auth-storage.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";

const execAsync = promisify(exec);

/** TCP connect probe — works without root, no ss/netstat needed. */
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

export interface AdminCommandsParams {
  bot: Bot;
  cfg: OpenClawConfig;
  ownerUserId: string;
  accountId: string;
  botUsername: string;
}

/**
 * Register admin commands on the grammy bot instance.
 * Only the ownerUserId can execute admin commands.
 */
export function registerAdminCommands(params: AdminCommandsParams): void {
  const { bot, ownerUserId } = params;

  function isOwner(ctx: { from?: { id: number } }): boolean {
    return ctx.from?.id != null && String(ctx.from.id) === ownerUserId;
  }

  // /setkey <provider> <key> — update provider API key
  bot.command("setkey", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Только администратор может менять API-ключи.");
      return;
    }

    // Immediately delete the message containing the API key for security
    try {
      await ctx.deleteMessage();
    } catch {
      // May fail if bot lacks delete permissions — continue anyway
    }

    const input = ctx.match?.trim();
    if (!input) {
      const supported = Object.keys(PROVIDER_KEY_SETTERS).join(", ");
      await ctx.reply(
        `Использование: /setkey <провайдер> <ключ>\n\nПоддерживаемые провайдеры: ${supported}\n\nПример: /setkey openai sk-xxxxxxxx\n\n⚠️ Сообщение с ключом будет автоматически удалено.`,
      );
      return;
    }

    const spaceIdx = input.indexOf(" ");
    if (spaceIdx === -1) {
      await ctx.reply("Укажите провайдер и ключ через пробел.\nПример: /setkey openai sk-xxxxxxxx");
      return;
    }

    const providerName = input.slice(0, spaceIdx).toLowerCase();
    const apiKey = input.slice(spaceIdx + 1).trim();

    if (!apiKey) {
      await ctx.reply("API-ключ не может быть пустым.");
      return;
    }

    const setter = PROVIDER_KEY_SETTERS[providerName];
    if (!setter) {
      const supported = Object.keys(PROVIDER_KEY_SETTERS).join(", ");
      await ctx.reply(
        `Неизвестный провайдер: "${providerName}"\n\nПоддерживаемые провайдеры: ${supported}`,
      );
      return;
    }

    try {
      await setter(apiKey);
      await ctx.reply(`✅ API-ключ для *${providerName}* успешно обновлён.`, {
        parse_mode: "Markdown",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Ошибка при обновлении ключа: ${message}`);
    }
  });

  // /settoken <provider> <access_token> [refresh_token] [expires] — update OAuth token
  bot.command("settoken", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Только администратор может обновлять OAuth-токены.");
      return;
    }

    // Immediately delete the message containing the token for security
    try {
      await ctx.deleteMessage();
    } catch {
      // May fail if bot lacks delete permissions — continue anyway
    }

    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply(
        [
          "Использование: /settoken <провайдер> <access_token> [refresh_token] [expires]",
          "",
          "Поддерживаемые провайдеры: anthropic, openai",
          "",
          "Примеры:",
          "/settoken anthropic sk-ant-oat-xxxx",
          "/settoken anthropic sk-ant-oat-xxxx rt-xxxx 1720000000",
          "",
          "expires — unix timestamp (секунды).",
          "⚠️ Сообщение с токеном будет автоматически удалено.",
        ].join("\n"),
      );
      return;
    }

    const parts = input.split(/\s+/);
    const providerName = parts[0]?.toLowerCase();
    const accessToken = parts[1];
    const refreshToken = parts[2];
    const expiresRaw = parts[3];

    if (!providerName || !accessToken) {
      await ctx.reply(
        "Укажите провайдер и access_token.\nПример: /settoken anthropic sk-ant-oat-xxxx",
      );
      return;
    }

    if (!OAUTH_PROVIDERS.has(providerName)) {
      await ctx.reply(
        `Неизвестный провайдер: "${providerName}"\n\nПоддерживаемые провайдеры для OAuth: ${Array.from(OAUTH_PROVIDERS).join(", ")}`,
      );
      return;
    }

    const expires = expiresRaw ? Number(expiresRaw) : 0;
    if (expiresRaw && (!Number.isFinite(expires) || expires <= 0)) {
      await ctx.reply("expires должен быть положительным числом (unix timestamp в секундах).");
      return;
    }

    try {
      await writeOAuthCredentials(providerName, {
        access: accessToken,
        refresh: refreshToken ?? "",
        expires,
      });
      await ctx.reply(`✅ OAuth-токен для *${providerName}* успешно обновлён.`, {
        parse_mode: "Markdown",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Ошибка при обновлении OAuth-токена: ${message}`);
    }
  });
  const gwPort = process.env.OPENCLAW_GATEWAY_PORT
    ? Number(process.env.OPENCLAW_GATEWAY_PORT)
    : 18789;
  const gwHost = process.env.OPENCLAW_GATEWAY_HOST || getHostname();

  // /gw — check gateway status
  bot.command("gw", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Только администратор может проверять статус gateway.");
      return;
    }

    try {
      const listening = await tcpProbe(gwPort);

      const sysInfo = await collectSystemInfo();

      const status = listening ? "✅ Работает" : "❌ Не отвечает";
      const lines = [`*${gwHost}* — Gateway`, `Статус: ${status} (порт ${gwPort})`];
      if (sysInfo.uptime) lines.push(`Аптайм: ${sysInfo.uptime}`);
      if (sysInfo.memory) lines.push(`Память: ${sysInfo.memory}`);
      if (sysInfo.disk) lines.push(`Диск: ${sysInfo.disk}`);

      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Ошибка проверки: ${message}`);
    }
  });

  // /gwrestart — force restart gateway
  bot.command("gwrestart", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Только администратор может перезапускать gateway.");
      return;
    }

    await ctx.reply(`⏳ *${gwHost}*\nПерезапускаю gateway...`, { parse_mode: "Markdown" });

    const restartCmd =
      process.env.OPENCLAW_GATEWAY_RESTART_CMD ??
      [
        // Kill via lsof (most reliable), then fuser as fallback
        `lsof -nP -iTCP:${gwPort} -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null || true`,
        `fuser -k ${gwPort}/tcp 2>/dev/null || true`,
        `sleep 2`,
        `nohup openclaw gateway run --bind loopback --port ${gwPort} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      ].join("; ");

    try {
      await execAsync(restartCmd, { timeout: 20000 });

      // Poll until gateway is up (up to 10 seconds)
      let up = false;
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await tcpProbe(gwPort)) {
          up = true;
          break;
        }
      }

      if (up) {
        await ctx.reply(`✅ *${gwHost}*\nGateway успешно перезапущен.`, {
          parse_mode: "Markdown",
        });
      } else {
        // Show last log lines to help diagnose
        let logTail = "";
        try {
          const { stdout: logs } = await execAsync(
            "tail -n 10 /tmp/openclaw-gateway.log 2>/dev/null",
            { timeout: 3000 },
          );
          logTail = logs.trim();
        } catch {
          // ignore
        }

        const msg = [`❌ *${gwHost}*\nGateway не поднялся после рестарта.`];
        if (logTail) {
          msg.push(`\n\`\`\`\n${logTail.slice(-1500)}\n\`\`\``);
        }
        await ctx.reply(msg.join(""), { parse_mode: "Markdown" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Ошибка перезапуска: ${message}`);
    }
  });

  // /logs [N] — show last N lines of gateway log (default: 30)
  bot.command("logs", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Только администратор может просматривать логи.");
      return;
    }

    const countStr = ctx.match?.trim();
    const count = countStr ? Math.min(Number(countStr) || 30, 100) : 30;

    try {
      const { stdout } = await execAsync(`tail -n ${count} /tmp/openclaw-gateway.log 2>&1`, {
        timeout: 5000,
      });
      const logText = stdout.trim() || "(пусто)";
      // Telegram message limit is 4096 chars
      const truncated = logText.length > 3900 ? `...${logText.slice(-3900)}` : logText;
      await ctx.reply(`📋 Последние ${count} строк:\n\`\`\`\n${truncated}\n\`\`\``, {
        parse_mode: "Markdown",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Не удалось прочитать логи: ${message}`);
    }
  });
}

/**
 * Check if a Telegram user ID is the owner/admin.
 */
export function isOwnerUser(userId: string | number, ownerUserId: string): boolean {
  return String(userId) === ownerUserId;
}

/** Map of supported provider names to their key-setter functions. */
const PROVIDER_KEY_SETTERS: Record<string, (key: string) => void | Promise<void>> = {
  anthropic: (key) => setAnthropicApiKey(key),
  openai: (key) => setOpenaiApiKey(key),
  gemini: (key) => setGeminiApiKey(key),
  google: (key) => setGeminiApiKey(key),
  openrouter: (key) => setOpenrouterApiKey(key),
  mistral: (key) => setMistralApiKey(key),
  xai: (key) => setXaiApiKey(key),
};

/** Providers that support OAuth token flow. */
const OAUTH_PROVIDERS = new Set(["anthropic", "openai"]);

async function collectSystemInfo(): Promise<{ uptime: string; memory: string; disk: string }> {
  let uptime = "";
  let memory = "";
  let disk = "";
  try {
    const { stdout } = await execAsync("uptime -p 2>/dev/null || uptime", { timeout: 3000 });
    uptime = stdout.trim();
  } catch {
    // ignore
  }
  try {
    const { stdout } = await execAsync(`free -h 2>/dev/null | awk '/^Mem:/{print $3"/"$2}'`, {
      timeout: 3000,
    });
    memory = stdout.trim();
  } catch {
    // ignore
  }
  try {
    const { stdout } = await execAsync(
      `df -h / 2>/dev/null | awk 'NR==2{print $3"/"$2" ("$5" used)"}'`,
      { timeout: 3000 },
    );
    disk = stdout.trim();
  } catch {
    // ignore
  }
  return { uptime, memory, disk };
}

function getHostname(): string {
  try {
    return hostname();
  } catch {
    return "localhost";
  }
}
