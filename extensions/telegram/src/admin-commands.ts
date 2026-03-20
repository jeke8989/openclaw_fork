/**
 * Admin commands for Telegram bot: /setkey, /settoken
 * Bot is personal (single-user) — no invite or multi-user management.
 * All user-facing messages in Russian.
 */
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
