/**
 * Admin commands for Telegram bot: /invite, /users, /block, /unblock, /role, /setkey
 * Owner notifications on new user pairing
 * All user-facing messages in Russian
 */
import type { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  readChannelAllowFromStore,
  addChannelAllowFromStoreEntry,
  removeChannelAllowFromStoreEntry,
} from "../../../src/pairing/pairing-store.js";
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
  const { bot, ownerUserId, accountId, botUsername } = params;

  function isOwner(ctx: { from?: { id: number } }): boolean {
    return ctx.from?.id != null && String(ctx.from.id) === ownerUserId;
  }

  // /invite — создать ссылку-приглашение
  bot.command("invite", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Только администратор может создавать ссылки-приглашения.");
      return;
    }

    const inviteCode = generateInviteCode();
    const resolvedBotUsername = botUsername || ctx.me?.username || "";
    const link = `https://t.me/${resolvedBotUsername}?start=invite_${inviteCode}`;

    await ctx.reply(
      `Ссылка-приглашение (отправьте новому пользователю):\n\n${link}\n\nПользователь будет автоматически одобрен при переходе по ссылке.`,
    );
  });

  // /users — список пользователей
  bot.command("users", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Только администратор может просматривать список пользователей.");
      return;
    }

    try {
      const entries = await readChannelAllowFromStore("telegram", process.env, accountId);

      if (!entries || entries.length === 0) {
        await ctx.reply("Авторизованных пользователей не найдено.");
        return;
      }

      const userList = entries.map((id: string, i: number) => `${i + 1}. \`${id}\``).join("\n");
      await ctx.reply(
        `Авторизованные пользователи (${entries.length}):\n\n${userList}\n\nАдмин: \`${ownerUserId}\``,
        { parse_mode: "Markdown" },
      );
    } catch {
      await ctx.reply("Ошибка при чтении списка пользователей.");
    }
  });

  // /block <userId> — заблокировать пользователя
  bot.command("block", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Только администратор может блокировать пользователей.");
      return;
    }

    const userId = ctx.match?.trim();
    if (!userId) {
      await ctx.reply("Использование: /block <user_id>\nПример: /block 123456789");
      return;
    }

    if (userId === ownerUserId) {
      await ctx.reply("Вы не можете заблокировать себя.");
      return;
    }

    try {
      await removeChannelAllowFromStoreEntry({
        channel: "telegram",
        id: userId,
        accountId,
      });
      await ctx.reply(`Пользователь \`${userId}\` заблокирован (удалён из списка доступа).`, {
        parse_mode: "Markdown",
      });
    } catch {
      await ctx.reply(`Ошибка при блокировке пользователя ${userId}.`);
    }
  });

  // /unblock <userId> — разблокировать пользователя
  bot.command("unblock", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Только администратор может разблокировать пользователей.");
      return;
    }

    const userId = ctx.match?.trim();
    if (!userId) {
      await ctx.reply("Использование: /unblock <user_id>\nПример: /unblock 123456789");
      return;
    }

    try {
      await addChannelAllowFromStoreEntry({
        channel: "telegram",
        id: userId,
        accountId,
      });
      await ctx.reply(`Пользователь \`${userId}\` разблокирован (добавлен в список доступа).`, {
        parse_mode: "Markdown",
      });
    } catch {
      await ctx.reply(`Ошибка при разблокировке пользователя ${userId}.`);
    }
  });

  // /role — узнать свою роль
  bot.command("role", async (ctx) => {
    if (isOwner(ctx)) {
      await ctx.reply(
        "Ваша роль: *Администратор*\n\nВы можете управлять пользователями, скиллами и настройками.",
        { parse_mode: "Markdown" },
      );
    } else {
      await ctx.reply(
        "Ваша роль: *Пользователь*\n\nВы можете использовать все доступные скиллы и общаться с ассистентом. Управление скиллами доступно только администратору.",
        { parse_mode: "Markdown" },
      );
    }
  });

  // /setkey <provider> <key> — обновить API-ключ провайдера
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

  // Handle /start with invite deep link — use hears to avoid conflicting with grammy internals
  bot.hears(/^\/start\s+invite_\w+/, async (ctx) => {
    const senderId = ctx.from?.id;
    if (!senderId) return;

    const senderIdStr = String(senderId);
    const firstName = ctx.from?.first_name ?? "";
    const lastName = ctx.from?.last_name ?? "";
    const username = ctx.from?.username ?? "";
    const displayName = [firstName, lastName].filter(Boolean).join(" ") || username || senderIdStr;

    try {
      await addChannelAllowFromStoreEntry({
        channel: "telegram",
        id: senderIdStr,
        accountId,
      });

      await ctx.reply("Добро пожаловать! Вы одобрены. Отправьте сообщение, чтобы начать общение.");

      // Уведомить админа о новом пользователе
      await notifyOwnerNewUser({
        bot,
        ownerUserId,
        userId: senderIdStr,
        displayName,
        username,
        method: "ссылке-приглашению",
      });
    } catch {
      await ctx.reply("Произошла ошибка. Попробуйте снова или свяжитесь с администратором.");
    }
  });
}

/**
 * Уведомление админу о новом пользователе.
 */
export async function notifyOwnerNewUser(params: {
  bot: Bot;
  ownerUserId: string;
  userId: string;
  displayName: string;
  username: string;
  method: string;
}): Promise<void> {
  const { bot, ownerUserId, userId, displayName, username, method } = params;
  const usernameStr = username ? ` (@${username})` : "";
  const text = [
    `Новый пользователь зарегистрирован по ${method}:`,
    `Имя: ${displayName}${usernameStr}`,
    `ID: \`${userId}\``,
    ``,
    `Заблокировать: /block ${userId}`,
  ].join("\n");

  try {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(Number(ownerUserId), text, { parse_mode: "Markdown" }),
    });
  } catch {
    // Best-effort notification
  }
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

function generateInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}
