/**
 * Admin commands for Telegram bot: /invite, /users, /block, /unblock
 * Owner notifications on new user pairing
 */
import type { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  readChannelAllowFromStore,
  addChannelAllowFromStoreEntry,
  removeChannelAllowFromStoreEntry,
} from "../../../src/pairing/pairing-store.js";
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

  // Helper: check if sender is the owner
  function isOwner(ctx: { from?: { id: number } }): boolean {
    return ctx.from?.id != null && String(ctx.from.id) === ownerUserId;
  }

  // /invite — generate a deep link for inviting users
  bot.command("invite", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Only the owner can generate invite links.");
      return;
    }

    const inviteCode = generateInviteCode();
    const link = `https://t.me/${botUsername}?start=invite_${inviteCode}`;

    await ctx.reply(
      `Invite link (share with new user):\n\n${link}\n\nThe user will be auto-approved when they click this link.`,
    );
  });

  // /users — list all authorized users
  bot.command("users", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Only the owner can view the user list.");
      return;
    }

    try {
      const entries = await readChannelAllowFromStore("telegram", process.env, accountId);

      if (!entries || entries.length === 0) {
        await ctx.reply("No authorized users found (besides config allowFrom).");
        return;
      }

      const userList = entries.map((id: string, i: number) => `${i + 1}. \`${id}\``).join("\n");
      await ctx.reply(
        `Authorized users (${entries.length}):\n\n${userList}\n\nOwner: \`${ownerUserId}\``,
        { parse_mode: "Markdown" },
      );
    } catch {
      await ctx.reply("Error reading user list.");
    }
  });

  // /block <userId> — remove user from allowlist
  bot.command("block", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Only the owner can block users.");
      return;
    }

    const userId = ctx.match?.trim();
    if (!userId) {
      await ctx.reply("Usage: /block <user_id>\nExample: /block 123456789");
      return;
    }

    if (userId === ownerUserId) {
      await ctx.reply("You cannot block yourself.");
      return;
    }

    try {
      await removeChannelAllowFromStoreEntry({
        channel: "telegram",
        id: userId,
        accountId,
      });
      await ctx.reply(`User \`${userId}\` has been blocked (removed from allowlist).`, {
        parse_mode: "Markdown",
      });
    } catch {
      await ctx.reply(`Error blocking user ${userId}.`);
    }
  });

  // /unblock <userId> — add user back to allowlist
  bot.command("unblock", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Only the owner can unblock users.");
      return;
    }

    const userId = ctx.match?.trim();
    if (!userId) {
      await ctx.reply("Usage: /unblock <user_id>\nExample: /unblock 123456789");
      return;
    }

    try {
      await addChannelAllowFromStoreEntry({
        channel: "telegram",
        id: userId,
        accountId,
      });
      await ctx.reply(`User \`${userId}\` has been unblocked (added to allowlist).`, {
        parse_mode: "Markdown",
      });
    } catch {
      await ctx.reply(`Error unblocking user ${userId}.`);
    }
  });

  // /role — show the user their role
  bot.command("role", async (ctx) => {
    if (isOwner(ctx)) {
      await ctx.reply("Your role: *Admin* (owner)\n\nYou can manage users, skills, and settings.", {
        parse_mode: "Markdown",
      });
    } else {
      await ctx.reply(
        "Your role: *User*\n\nYou can use all available skills and chat with the assistant. Skill management is admin-only.",
        {
          parse_mode: "Markdown",
        },
      );
    }
  });

  // Handle /start with invite deep link parameter
  bot.command("start", async (ctx) => {
    const param = ctx.match?.trim();

    if (param && param.startsWith("invite_")) {
      const senderId = ctx.from?.id;
      if (!senderId) return;

      const senderIdStr = String(senderId);
      const firstName = ctx.from?.first_name ?? "";
      const lastName = ctx.from?.last_name ?? "";
      const username = ctx.from?.username ?? "";
      const displayName =
        [firstName, lastName].filter(Boolean).join(" ") || username || senderIdStr;

      try {
        await addChannelAllowFromStoreEntry({
          channel: "telegram",
          id: senderIdStr,
          accountId,
        });

        await ctx.reply("Welcome! You have been approved. Send a message to start chatting.");

        // Notify owner about the new user
        await notifyOwnerNewUser({
          bot,
          ownerUserId,
          userId: senderIdStr,
          displayName,
          username,
          method: "invite link",
        });
      } catch {
        await ctx.reply("Something went wrong. Please try again or contact the admin.");
      }
      return;
    }

    // Default /start handler
    await ctx.reply(
      "Hello! I'm your AI assistant powered by Claude.\n\nIf you don't have access yet, ask the admin for an invite link.",
    );
  });
}

/**
 * Send notification to owner when a new user is approved (via pairing or invite).
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
    `New user registered via ${method}:`,
    `Name: ${displayName}${usernameStr}`,
    `ID: \`${userId}\``,
    ``,
    `To block: /block ${userId}`,
  ].join("\n");

  try {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(Number(ownerUserId), text, { parse_mode: "Markdown" }),
    });
  } catch {
    // Owner notification is best-effort
  }
}

/**
 * Check if a Telegram user ID is the owner/admin.
 * Exported for use in other modules to gate admin-only features (e.g., skill management).
 */
export function isOwnerUser(userId: string | number, ownerUserId: string): boolean {
  return String(userId) === ownerUserId;
}

function generateInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}
