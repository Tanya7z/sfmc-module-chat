/**
 * 频道 / 消息投递 / 广播
 */

import { Player, world } from "@minecraft/server";
import { db } from "@sfmc-bds/sdk/sapi/db";
import { Command, Msg, debug } from "@sfmc-bds/sdk/sapi/runtime";
import { decorateMessageContent, formatChatLine } from "./format.js";
import { runObservers } from "./pipeline.js";

export const CHANNELS_TABLE = "sfmc_chat_channels";
export const MESSAGES_TABLE = "sfmc_chat_messages";
export const REDPACKETS_TABLE = "sfmc_chat_redpackets";
export const AVATARS_TABLE = "sfmc_chat_avatars";

const DEFAULT_CHANNEL = "global";
const activeChannel = new Map<string, string>();
let titlePrefix = "";
let colorCodes = true;

export function setChatStyle(opts: { titlePrefix?: string; colorCodes?: boolean }): void {
  if (typeof opts.titlePrefix === "string") titlePrefix = opts.titlePrefix;
  if (typeof opts.colorCodes === "boolean") colorCodes = opts.colorCodes;
}

export async function ensureDefaultChannels(): Promise<void> {
  const existing = await db.get<{ id: string }>(CHANNELS_TABLE, DEFAULT_CHANNEL);
  if (existing) return;
  await db.tx(async (tx) => {
    await tx.insert(CHANNELS_TABLE, {
      id: DEFAULT_CHANNEL,
      name: "公共频道",
      type: "public",
      prefix: "全服",
      owner_id: "",
      allow_chat: 1,
      slow_mode: 0,
      is_broadcast: 1,
    });
  });
}

export function getActiveChannelId(playerId: string): string {
  return activeChannel.get(playerId) || DEFAULT_CHANNEL;
}

export function setActiveChannelId(playerId: string, channelId: string): void {
  activeChannel.set(playerId, channelId);
}

/** 向玩家投递聊天渲染行（非 Msg 前缀样式）。 */
function deliverLine(player: Player, line: string): void {
  // 聊天正文需自定义格式，无法使用 Msg.* 前缀门面
  player.sendMessage(line);
}

export async function persistMessage(row: {
  fromId: string;
  fromName: string;
  channelId: string;
  type: string;
  content: string;
  attachment?: string;
}): Promise<string> {
  const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await db.tx(async (tx) => {
      await tx.insert(MESSAGES_TABLE, {
        id,
        from_id: row.fromId,
        from_name: row.fromName,
        channel_id: row.channelId,
        type: row.type,
        content: row.content,
        attachment: row.attachment ?? "",
        created_at: Date.now(),
      });
    });
  } catch (err) {
    debug.w("CHAT", `persist: ${err instanceof Error ? err.message : String(err)}`);
  }
  return id;
}

export async function deliverChannelMessage(
  sender: Player,
  channelId: string,
  content: string,
): Promise<{ ok: boolean; messageId?: string }> {
  const channel = await db.get<{
    id: string;
    prefix?: string;
    allow_chat?: number;
    name?: string;
  }>(CHANNELS_TABLE, channelId);
  if (channel && channel.allow_chat === 0) {
    Msg.error("当前频道禁止发言。", sender);
    return { ok: false };
  }

  const text = decorateMessageContent(content, colorCodes);
  const formatted = formatChatLine({
    senderName: sender.name,
    content: text,
    channelPrefix: channel?.prefix || channel?.name || channelId,
    titlePrefix,
  });

  const messageId = await persistMessage({
    fromId: sender.id,
    fromName: sender.name,
    channelId,
    type: "chat",
    content: text,
  });

  for (const p of world.getAllPlayers()) {
    deliverLine(p, formatted);
  }

  await runObservers({
    player: sender,
    message: text,
    channelId,
    formatted,
  });

  return { ok: true, messageId };
}

export async function sendPrivate(
  sender: Player,
  target: Player,
  content: string,
): Promise<{ ok: boolean; messageId?: string }> {
  const text = decorateMessageContent(content, colorCodes);
  const toTarget = `§d[私聊] §b${sender.name}§r → 你: ${text}`;
  const toSelf = `§d[私聊] 你 → §b${target.name}§r: ${text}`;
  deliverLine(target, toTarget);
  deliverLine(sender, toSelf);
  const messageId = await persistMessage({
    fromId: sender.id,
    fromName: sender.name,
    channelId: `pm:${target.id}`,
    type: "private",
    content: text,
    attachment: target.id,
  });
  return { ok: true, messageId };
}

export async function broadcast(opts: {
  content: string;
  prefix?: string;
  channelId?: string;
}): Promise<{ ok: boolean }> {
  const prefix = opts.prefix ? `§6[${opts.prefix}]§r ` : "§6[广播]§r ";
  const line = `${prefix}${decorateMessageContent(opts.content, colorCodes)}`;
  for (const p of world.getAllPlayers()) deliverLine(p, line);
  if (opts.channelId) {
    await persistMessage({
      fromId: "system",
      fromName: "SYSTEM",
      channelId: opts.channelId,
      type: "broadcast",
      content: opts.content,
    });
  }
  return { ok: true };
}

export async function handlePlayerChat(player: Player, message: string): Promise<void> {
  const channelId = getActiveChannelId(player.id);
  await deliverChannelMessage(player, channelId, message);
}

/** 命令路由：若已注册则交给 Command.trigger（仅首 token）。 */
export function tryDispatchCommand(player: Player, message: string): boolean {
  const name = message.slice(1).trim().split(/\s+/)[0];
  if (!name) return false;
  if (!Command.has(name)) return false;
  Command.trigger(player, name);
  return true;
}

export function findPlayerByName(name: string): Player | undefined {
  const lower = name.toLowerCase();
  return world.getAllPlayers().find((p) => p.name.toLowerCase() === lower);
}

export function clearActiveChannels(): void {
  activeChannel.clear();
}
