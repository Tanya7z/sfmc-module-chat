/**
 * 频道 / 消息投递 / 广播
 */

import { Player, system, world } from "@minecraft/server";
import { db } from "@sfmc-bds/sdk/sapi/db";
import { Msg, Permission, debug } from "@sfmc-bds/sdk/sapi/runtime";
import { getAvatarGlyph } from "./avatar.js";
import { decorateMessageContent, formatChatLine } from "./format.js";
import { runObservers } from "./pipeline.js";

export const CHANNELS_TABLE = "sfmc_chat_channels";
export const MESSAGES_TABLE = "sfmc_chat_messages";
export const AVATARS_TABLE = "sfmc_chat_avatars";

const DEFAULT_CHANNEL = "global";
const activeChannel = new Map<string, string>();
const subscribedChannels = new Map<string, Set<string>>();
const slowModeTracker = new Map<string, Map<string, number>>();
let titlePrefix = "";
let colorCodes = true;
let bridgePollRunId: number | undefined;
let bridgeCursor = Date.now();
let bridgeLastTimestamp = 0;
let bridgePollInFlight = false;
const deliveredBridgeMessages = new Set<string>();

export interface ChannelRecord extends Record<string, unknown> {
  id: string;
  name: string;
  type: "public" | "custom" | "private" | "system";
  prefix: string;
  owner_id: string;
  allow_chat: number;
  slow_mode: number;
  is_broadcast: number;
  members_json?: string;
}

export interface MessageRecord extends Record<string, unknown> {
  id: string;
  from_id: string;
  from_name: string;
  channel_id: string;
  type: string;
  content: string;
  attachment: string;
  created_at: number;
  show_timestamp?: number;
}

export function setChatStyle(opts: {
  titlePrefix?: string;
  colorCodes?: boolean;
}): void {
  if (typeof opts.titlePrefix === "string") titlePrefix = opts.titlePrefix;
  if (typeof opts.colorCodes === "boolean") colorCodes = opts.colorCodes;
}

export async function ensureDefaultChannels(): Promise<void> {
  const existing = await getChannel(DEFAULT_CHANNEL);
  const broadcastChannel = await getChannel("broadcast");
  if (existing && broadcastChannel) return;
  await db.tx(async (tx) => {
    if (!existing) {
      await tx.insert(CHANNELS_TABLE, {
        id: DEFAULT_CHANNEL,
        name: "公共频道",
        type: "public",
        prefix: "PB",
        owner_id: "",
        allow_chat: 1,
        slow_mode: 0,
        is_broadcast: 0,
      });
    }
    if (!broadcastChannel) {
      await tx.insert(CHANNELS_TABLE, {
        id: "broadcast",
        name: "公告",
        type: "custom",
        prefix: "BC",
        owner_id: "",
        allow_chat: 1,
        slow_mode: 0,
        is_broadcast: 1,
      });
    }
  });
}

export async function getChannel(
  channelId: string,
): Promise<ChannelRecord | null> {
  return db.get<ChannelRecord>(CHANNELS_TABLE, channelId);
}

export async function getChannels(
  type?: ChannelRecord["type"],
): Promise<ChannelRecord[]> {
  return db.query<ChannelRecord>(CHANNELS_TABLE, {
    ...(type ? { where: { eq: ["type", type] } } : {}),
    orderBy: { field: "name", dir: "asc" },
  });
}

export async function createChannel(
  owner: Player,
  name: string,
  prefix: string,
): Promise<ChannelRecord | null> {
  const normalizedName = name.trim();
  const normalizedPrefix = prefix.trim();
  if (
    !normalizedName ||
    !normalizedPrefix ||
    normalizedName.length > 32 ||
    normalizedPrefix.length > 12
  )
    return null;
  const duplicate = (await getChannels()).some(
    (channel) => channel.name.toLowerCase() === normalizedName.toLowerCase(),
  );
  if (duplicate) return null;
  const channel: ChannelRecord = {
    id: `ch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: normalizedName,
    type: "custom",
    prefix: normalizedPrefix,
    owner_id: owner.id,
    allow_chat: 1,
    slow_mode: 0,
    is_broadcast: 0,
    members_json: "[]",
  };
  await db.tx(async (tx) => await tx.insert(CHANNELS_TABLE, channel));
  await setActiveChannel(owner, channel.id);
  return channel;
}

export async function updateChannel(
  actor: Player,
  channelId: string,
  patch: Partial<
    Pick<
      ChannelRecord,
      "name" | "prefix" | "allow_chat" | "slow_mode" | "is_broadcast"
    >
  >,
): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (!channel || !canManageChannel(actor, channel)) return false;
  await db.tx(async (tx) => await tx.update(CHANNELS_TABLE, channelId, patch));
  return true;
}

export async function deleteChannel(
  actor: Player,
  channelId: string,
): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (
    !channel ||
    channel.type === "public" ||
    !canManageChannel(actor, channel)
  )
    return false;
  await db.tx(async (tx) => await tx.delete(CHANNELS_TABLE, channelId));
  for (const ids of subscribedChannels.values()) ids.delete(channelId);
  for (const player of world.getAllPlayers()) {
    if (getActiveChannelId(player.id) !== channelId) continue;
    setActiveChannelId(player.id, DEFAULT_CHANNEL);
    await persistPlayerPreferences(player);
  }
  return true;
}

export function canManageChannel(
  player: Player,
  channel: ChannelRecord,
): boolean {
  return (
    channel.owner_id === player.id || Permission.check(player, "chat.admin")
  );
}

export function getActiveChannelId(playerId: string): string {
  return activeChannel.get(playerId) || DEFAULT_CHANNEL;
}

export function setActiveChannelId(playerId: string, channelId: string): void {
  activeChannel.set(playerId, channelId);
  ensureSubscribed(playerId, channelId);
}

export async function setActiveChannel(
  player: Player,
  channelId: string,
): Promise<void> {
  const channel = await getChannel(channelId);
  if (!channel || !canAccessChannel(player, channel)) {
    Msg.error("你无权访问该频道。", player);
    return;
  }
  setActiveChannelId(player.id, channelId);
  await persistPlayerPreferences(player);
}

export function isSubscribed(playerId: string, channelId: string): boolean {
  return subscribedChannels.get(playerId)?.has(channelId) ?? false;
}

export function getSubscribedChannelIds(playerId: string): string[] {
  return [...(subscribedChannels.get(playerId) ?? [])];
}

export async function toggleSubscription(
  player: Player,
  channelId: string,
): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (!channel || !canAccessChannel(player, channel)) return false;
  const ids = subscribedChannels.get(player.id) ?? new Set<string>();
  subscribedChannels.set(player.id, ids);
  if (ids.has(channelId)) {
    if (channelId === DEFAULT_CHANNEL) return true;
    ids.delete(channelId);
  } else {
    ids.add(channelId);
  }
  await persistPlayerPreferences(player);
  return ids.has(channelId);
}

export function getOnlineCount(channelId: string): number {
  return world
    .getAllPlayers()
    .filter((player) => isSubscribed(player.id, channelId)).length;
}

export async function loadPlayerPreferences(player: Player): Promise<void> {
  try {
    const rows = await db.query<{
      active_channel?: string;
      subscribed_channels?: string;
    }>("sfmc_players", {
      where: { eq: ["id", player.id] },
      limit: 1,
    });
    const row = rows[0];
    const available = new Map(
      (await getChannels()).map((channel) => [channel.id, channel]),
    );
    const ids = new Set<string>([DEFAULT_CHANNEL]);
    if (row?.subscribed_channels) {
      const stored = JSON.parse(row.subscribed_channels) as unknown;
      if (Array.isArray(stored)) {
        for (const id of stored) {
          const channel = typeof id === "string" ? available.get(id) : null;
          if (channel && canAccessChannel(player, channel)) ids.add(id);
        }
      }
    }
    subscribedChannels.set(player.id, ids);
    const preferred = row?.active_channel || DEFAULT_CHANNEL;
    const preferredChannel = available.get(preferred);
    activeChannel.set(
      player.id,
      preferredChannel && canAccessChannel(player, preferredChannel)
        ? preferred
        : DEFAULT_CHANNEL,
    );
  } catch (err) {
    debug.w(
      "CHAT",
      `load prefs: ${err instanceof Error ? err.message : String(err)}`,
    );
    subscribedChannels.set(player.id, new Set([DEFAULT_CHANNEL]));
    activeChannel.set(player.id, DEFAULT_CHANNEL);
  }
}

async function persistPlayerPreferences(player: Player): Promise<void> {
  try {
    const key = player.id;
    const existing = await db.get<{ id: string }>("sfmc_players", key);
    const values = {
      active_channel: getActiveChannelId(player.id),
      subscribed_channels: JSON.stringify(getSubscribedChannelIds(player.id)),
      updated_at: Date.now(),
    };
    await db.tx(async (tx) => {
      if (existing) await tx.update("sfmc_players", key, values);
      else
        await tx.insert("sfmc_players", {
          id: player.id,
          name: player.name,
          ...values,
        });
    });
  } catch (err) {
    debug.w(
      "CHAT",
      `persist prefs: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 轮询并投递 QQ→MC 入站消息；仅消费 qq_ 来源，避免消息回环。 */
export function startBridgePolling(
  channelId: string,
  intervalTicks = 600,
): void {
  stopBridgePolling();
  const normalizedChannelId = channelId.trim();
  if (!normalizedChannelId) return;
  bridgeCursor = Date.now();
  bridgeLastTimestamp = 0;
  deliveredBridgeMessages.clear();
  bridgePollRunId = system.runInterval(
    () => {
      void pollBridgeMessages(normalizedChannelId);
    },
    Math.max(20, Math.floor(intervalTicks)),
  );
}

export function stopBridgePolling(): void {
  if (bridgePollRunId !== undefined) system.clearRun(bridgePollRunId);
  bridgePollRunId = undefined;
  bridgeLastTimestamp = 0;
  bridgePollInFlight = false;
  deliveredBridgeMessages.clear();
}

async function pollBridgeMessages(channelId: string): Promise<void> {
  if (bridgePollInFlight) return;
  bridgePollInFlight = true;
  try {
    const channel = await getChannel(channelId);
    if (!channel) return;
    const rows = await db.query<MessageRecord>(MESSAGES_TABLE, {
      where: { eq: ["channel_id", channelId] },
      orderBy: { field: "created_at", dir: "desc" },
      limit: 100,
    });
    const incoming = rows
      .filter(
        (row) =>
          row.from_id.startsWith("qq_") &&
          row.created_at >= bridgeCursor &&
          !deliveredBridgeMessages.has(row.id),
      )
      .reverse();
    for (const row of incoming) {
      const line = formatChatLine({
        glyph: getAvatarGlyph(),
        senderName: row.from_name,
        content: decorateMessageContent(
          row.type,
          decorateMessageContent(row.content, colorCodes),
        ),
        channelPrefix: channel.prefix || channel.name || channelId,
        titlePrefix,
        style: channel.is_broadcast ? "broadcast" : "channel",
      });
      for (const player of world.getAllPlayers()) {
        if (!isSubscribed(player.id, channelId)) continue;
        if (
          !channel.is_broadcast &&
          row.created_at - bridgeLastTimestamp > 5 * 60 * 1000
        ) {
          deliverLine(player, `§7${formatTimestamp(row.created_at)}`);
        }
        deliverLine(player, line);
      }
      if (row.created_at - bridgeLastTimestamp > 5 * 60 * 1000) {
        bridgeLastTimestamp = row.created_at;
      }
      deliveredBridgeMessages.add(row.id);
      bridgeCursor = Math.max(bridgeCursor, row.created_at);
    }
    if (deliveredBridgeMessages.size > 500) deliveredBridgeMessages.clear();
  } catch (err) {
    debug.w(
      "CHAT",
      `bridge poll: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    bridgePollInFlight = false;
  }
}

function ensureSubscribed(playerId: string, channelId: string): void {
  const ids = subscribedChannels.get(playerId) ?? new Set<string>();
  ids.add(DEFAULT_CHANNEL);
  ids.add(channelId);
  subscribedChannels.set(playerId, ids);
}

/** 向玩家投递聊天渲染行（非 Msg 前缀样式）。 */
function deliverLine(player: Player, line: string): void {
  // 聊天正文需自定义格式，无法使用 Msg.* 前缀门面
  // eslint-disable-next-line @sfmc-bds/no-player-send-message -- 频道模板不能附加 Msg 门面前缀
  player.sendMessage(line);
}

export async function persistMessage(row: {
  fromId: string;
  fromName: string;
  channelId: string;
  type: string;
  content: string;
  attachment?: string;
  showTimestamp?: boolean;
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
        show_timestamp: row.showTimestamp ? 1 : 0,
      });
    });
  } catch (err) {
    debug.w(
      "CHAT",
      `persist: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return id;
}

export async function deliverChannelMessage(
  sender: Player,
  channelId: string,
  content: string,
  type = "chat",
  attachment = "",
): Promise<{ ok: boolean; messageId?: string }> {
  if (!content.trim() || content.length > 512 || attachment.length > 256) {
    Msg.error("消息为空或过长。", sender);
    return { ok: false };
  }
  const channel = await getChannel(channelId);
  if (!channel) {
    Msg.error("频道不存在。", sender);
    return { ok: false };
  }
  if (channel.allow_chat === 0) {
    Msg.error("当前频道禁止发言。", sender);
    return { ok: false };
  }
  if (channel.is_broadcast && !canManageChannel(sender, channel)) {
    Msg.error("该频道为公告板，只有频道所有者或管理员可以发言。", sender);
    return { ok: false };
  }
  if (channel.slow_mode > 0) {
    const last = slowModeTracker.get(sender.id)?.get(channel.id) ?? 0;
    const remaining = channel.slow_mode - (Date.now() - last) / 1000;
    if (remaining > 0) {
      Msg.warning(`慢速模式中，请等待 ${Math.ceil(remaining)} 秒。`, sender);
      return { ok: false };
    }
  }

  const text = decorateMessageContent(content, colorCodes);
  const display = decorateMessageContent(type, text);
  const recent = await db.query<MessageRecord>(MESSAGES_TABLE, {
    where: { eq: ["channel_id", channelId] },
    orderBy: { field: "created_at", dir: "desc" },
    limit: 1,
  });
  const showTimestamp =
    !recent[0] || Date.now() - recent[0].created_at > 5 * 60 * 1000;
  const formatted = formatChatLine({
    glyph: getAvatarGlyph(sender.id),
    senderName: sender.name,
    content: display,
    channelPrefix: channel.prefix || channel.name || channelId,
    titlePrefix,
    style: channel.is_broadcast ? "broadcast" : "channel",
  });

  const messageId = await persistMessage({
    fromId: sender.id,
    fromName: sender.name,
    channelId,
    type,
    content: text,
    attachment,
    showTimestamp,
  });

  ensureSubscribed(sender.id, channel.id);
  for (const player of world.getAllPlayers()) {
    if (!isSubscribed(player.id, channel.id)) continue;
    if (showTimestamp && !channel.is_broadcast)
      deliverLine(player, `§7${formatTimestamp(Date.now())}`);
    deliverLine(player, formatted);
  }
  if (channel.slow_mode > 0) {
    const tracker = slowModeTracker.get(sender.id) ?? new Map<string, number>();
    tracker.set(channel.id, Date.now());
    slowModeTracker.set(sender.id, tracker);
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
  type = "private",
  attachment = "",
): Promise<{ ok: boolean; messageId?: string }> {
  if (!content.trim() || content.length > 512 || attachment.length > 256) {
    Msg.error("消息为空或过长。", sender);
    return { ok: false };
  }
  const channel = await ensurePrivateChannel(sender, target);
  const text = decorateMessageContent(content, colorCodes);
  const display = decorateMessageContent(type, text);
  const recent = await db.query<MessageRecord>(MESSAGES_TABLE, {
    where: { eq: ["channel_id", channel.id] },
    orderBy: { field: "created_at", dir: "desc" },
    limit: 1,
  });
  const showTimestamp =
    !recent[0] || Date.now() - recent[0].created_at > 5 * 60 * 1000;
  const toTarget = formatChatLine({
    glyph: getAvatarGlyph(sender.id),
    channelPrefix: "私聊",
    name: sender.name,
    content: display,
    style: "private",
  });
  const toSelf = formatChatLine({
    glyph: getAvatarGlyph(target.id),
    channelPrefix: "私聊",
    name: target.name,
    content: display,
    style: "private",
  });
  for (const [recipient, line] of [
    [target, toTarget],
    [sender, toSelf],
  ] as const) {
    if (showTimestamp)
      deliverLine(recipient, `§7${formatTimestamp(Date.now())}`);
    deliverLine(recipient, line);
  }
  const messageId = await persistMessage({
    fromId: sender.id,
    fromName: sender.name,
    channelId: channel.id,
    type,
    content: text,
    attachment: attachment || target.id,
    showTimestamp,
  });
  return { ok: true, messageId };
}

export async function ensurePrivateChannel(
  a: Player,
  b: Player,
): Promise<ChannelRecord> {
  const ids = [a.id, b.id].sort();
  const channelId = `priv_${ids[0]}_${ids[1]}`;
  const existing = await getChannel(channelId);
  if (existing) return existing;
  const channel: ChannelRecord = {
    id: channelId,
    name: `${a.name} 与 ${b.name} 的私聊`,
    type: "private",
    prefix: "私聊",
    owner_id: a.id,
    allow_chat: 1,
    slow_mode: 0,
    is_broadcast: 0,
    members_json: JSON.stringify(ids),
  };
  await db.tx(async (tx) => await tx.insert(CHANNELS_TABLE, channel));
  ensureSubscribed(a.id, channelId);
  ensureSubscribed(b.id, channelId);
  return channel;
}

export async function getPrivateChannels(
  player: Player,
): Promise<ChannelRecord[]> {
  return (await getChannels("private")).filter((channel) =>
    isPrivateParticipant(channel, player.id),
  );
}

function isPrivateParticipant(
  channel: ChannelRecord,
  playerId: string,
): boolean {
  try {
    const members = JSON.parse(channel.members_json || "[]") as unknown;
    if (Array.isArray(members) && members.length > 0) {
      return members.includes(playerId);
    }
  } catch {
    /* 兼容归档频道，继续按旧 ID 格式精确分段判断 */
  }
  return (
    channel.id.startsWith("priv_") &&
    channel.id.slice(5).split("_").includes(playerId)
  );
}

function canAccessChannel(player: Player, channel: ChannelRecord): boolean {
  if (channel.type === "private") {
    return isPrivateParticipant(channel, player.id);
  }
  if (channel.type === "system") return channel.owner_id === player.id;
  return true;
}

export async function cycleChannel(
  player: Player,
): Promise<ChannelRecord | null> {
  const channels = (await getChannels()).filter(
    (channel) => channel.type !== "private" && channel.type !== "system",
  );
  if (channels.length === 0) return null;
  const currentIndex = channels.findIndex(
    (channel) => channel.id === getActiveChannelId(player.id),
  );
  const next = channels[(currentIndex + 1) % channels.length] ?? channels[0];
  await setActiveChannel(player, next.id);
  return next;
}

export async function loadChannelHistory(
  player: Player,
  channelId: string,
): Promise<void> {
  const channel = await getChannel(channelId);
  if (!channel || !canAccessChannel(player, channel)) return;
  const retention = channel.is_broadcast
    ? Number.MAX_SAFE_INTEGER
    : channel.type === "private"
      ? 30 * 24 * 60 * 60 * 1000
      : channel.type === "system"
        ? 24 * 60 * 60 * 1000
        : 7 * 24 * 60 * 60 * 1000;
  const rows = await db.query<MessageRecord>(MESSAGES_TABLE, {
    where: { eq: ["channel_id", channelId] },
    orderBy: { field: "created_at", dir: "desc" },
    limit: 50,
  });
  const history = rows
    .filter((row) => row.created_at >= Date.now() - retention)
    .reverse();
  if (history.length === 0) {
    deliverLine(player, `§7--- §f${channel.prefix} §7频道暂无历史消息 ---`);
    return;
  }
  deliverLine(player, `§7--- §f${channel.prefix} §7频道历史消息 ---`);
  for (const row of history) {
    if (row.show_timestamp && !channel.is_broadcast) {
      deliverLine(player, `§7${formatTimestamp(row.created_at)}`);
    }
    deliverLine(
      player,
      formatChatLine({
        glyph: getAvatarGlyph(row.from_id),
        senderName: row.from_name,
        content: decorateMessageContent(
          row.type,
          decorateMessageContent(row.content, colorCodes),
        ),
        channelPrefix: channel.prefix,
        titlePrefix,
        style: channel.type === "private" ? "private" : "channel",
      }),
    );
  }
  deliverLine(player, `§7--- 以上为历史消息，共 ${history.length} 条 ---`);
  deliverLine(player, "§7/c:lo §8发送定位 §7| /c:tp §8传送邀请");
}

export async function sendSystemMessage(
  player: Player,
  content: string,
): Promise<void> {
  const channelId = `sys_${player.id}`;
  if (!(await getChannel(channelId))) {
    await db.tx(
      async (tx) =>
        await tx.insert(CHANNELS_TABLE, {
          id: channelId,
          name: "系统消息",
          type: "system",
          prefix: "SYS",
          owner_id: player.id,
          allow_chat: 0,
          slow_mode: 0,
          is_broadcast: 0,
        }),
    );
  }
  await persistMessage({
    fromId: "system",
    fromName: "SYS",
    channelId,
    type: "system",
    content,
  });
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

export async function handlePlayerChat(
  player: Player,
  message: string,
): Promise<void> {
  const channelId = getActiveChannelId(player.id);
  await deliverChannelMessage(player, channelId, message);
}

export function findPlayerByName(name: string): Player | undefined {
  const lower = name.toLowerCase();
  return world.getAllPlayers().find((p) => p.name.toLowerCase() === lower);
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function clearActiveChannels(): void {
  activeChannel.clear();
  subscribedChannels.clear();
  slowModeTracker.clear();
}

export function clearPlayerChatState(playerId: string): void {
  activeChannel.delete(playerId);
  subscribedChannels.delete(playerId);
  slowModeTracker.delete(playerId);
}
