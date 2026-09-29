/**
 * 频道 / 消息投递 / 广播
 */

import { Player, system, world } from "@minecraft/server";
import { db } from "@sfmc-bds/sdk/sapi/db";
import { Msg, Permission, debug } from "@sfmc-bds/sdk/sapi/runtime";
import { getAvatarGlyph } from "./avatar.js";
import { isQuickSwitchChannel } from "./channel-switch.js";
import { decorateMessageContent, formatChatLine } from "./format.js";
import { runObservers } from "./pipeline.js";
import { outgoingContentError } from "./send-validate.js";

export { outgoingContentError };

export const CHANNELS_TABLE = "sfmc_chat_channels";
export const MESSAGES_TABLE = "sfmc_chat_messages";
export const AVATARS_TABLE = "sfmc_chat_avatars";
const CHANNEL_SEED_TABLE = "sfmc_chat_meta";

const DEFAULT_CHANNEL = "ch_global";
const QQ_CHANNEL = "ch_qq";
const activeChannel = new Map<string, string>();
const subscribedChannels = new Map<string, Set<string>>();
const slowModeTracker = new Map<string, Map<string, number>>();
let titlePrefix = "";
let colorCodes = true;
let bridgePollRunId: number | undefined;
let bridgeRetryRunId: number | undefined;
let bridgeCursor = 0;
let bridgeCursorId = "";
let bridgeLastTimestamp = 0;
let bridgePollInFlightGeneration = -1;
let bridgeGeneration = 0;
const deliveredBridgeMessages = new Set<string>();
const sendLocks = new Set<string>();
const bridgeCursorTable = "sfmc_chat_meta";
const bridgeCursorKey = "qq-cursor-v1";

export interface ChannelRecord extends Record<string, unknown> {
  id: string;
  name: string;
  type: "public" | "custom" | "private" | "system";
  prefix: string;
  owner_id: string;
  /**
   * 是否允许普通成员发言。0 为全体禁言：仅频道主和 chat.admin 仍可发言。
   * 使用场景：频道设置「允许发言」开关；投递前校验发言资格。
   */
  allow_chat: number;
  forward_to_qq: number;
  source_game: number;
  source_qq: number;
  source_system: number;
  source_configured: number;
  slow_mode: number;
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

type ChannelSources = { game: number; qq: number; system: number };

/** 所有频道使用同一创建入口，权限由频道字段决定。 */
async function ensureChannel(options: {
  id: string;
  name: string;
  type: ChannelRecord["type"];
  prefix: string;
  ownerId: string;
  sources: ChannelSources;
  membersJson?: string;
  /**
   * 是否把本频道发言转发到 QQ。未传时与游戏内发言开关一致。
   * 私聊必须显式传 0：设置页不管理私聊，默认打开会把私聊推到群里。
   */
  forwardToQQ?: number;
}): Promise<ChannelRecord> {
  if (!options.id.startsWith("ch")) throw new Error("频道 ID 必须以 ch 开头。");
  const existing = await getChannel(options.id);
  if (existing) return existing;
  const channel: ChannelRecord = {
    id: options.id,
    name: options.name,
    type: options.type,
    prefix: options.prefix,
    owner_id: options.ownerId,
    allow_chat: options.sources.game,
    forward_to_qq: options.forwardToQQ ?? options.sources.game,
    source_game: options.sources.game,
    source_qq: options.sources.qq,
    source_system: options.sources.system,
    source_configured: 1,
    slow_mode: 0,
    members_json: options.membersJson ?? "[]",
  };
  await db.tx(async (tx) => await tx.insert(CHANNELS_TABLE, channel));
  return channel;
}

export async function ensureDefaultChannels(): Promise<void> {
  await migrateChannelIds();
  const seed = await db.get<{ id: string }>(CHANNEL_SEED_TABLE, "initial-v1");
  if (!seed) {
    if (!(await getChannel(DEFAULT_CHANNEL))) {
      await ensureChannel({
        id: DEFAULT_CHANNEL,
        name: "公共频道",
        type: "custom",
        prefix: "PB",
        ownerId: "",
        sources: { game: 1, qq: 0, system: 0 },
      });
    }
    if (!(await getChannel(QQ_CHANNEL))) {
      await ensureChannel({
        id: QQ_CHANNEL,
        name: "QQ 群聊",
        type: "custom",
        prefix: "QQ",
        ownerId: "",
        sources: { game: 0, qq: 1, system: 0 },
      });
    }
    await db.tx(async (tx) =>
      tx.insert(CHANNEL_SEED_TABLE, { id: "initial-v1" }),
    );
    await db.tx(async (tx) =>
      tx.insert(CHANNEL_SEED_TABLE, {
        id: "default-subscriptions",
        channel_ids: JSON.stringify([DEFAULT_CHANNEL, QQ_CHANNEL]),
      }),
    );
  }
  const defaultSubscriptions = await db.get<{ id: string }>(
    CHANNEL_SEED_TABLE,
    "default-subscriptions",
  );
  if (!defaultSubscriptions) {
    await db.tx(async (tx) =>
      tx.insert(CHANNEL_SEED_TABLE, {
        id: "default-subscriptions",
        channel_ids: JSON.stringify([DEFAULT_CHANNEL, QQ_CHANNEL]),
      }),
    );
  }
  const defaultSend = await db.get<{ id: string }>(
    CHANNEL_SEED_TABLE,
    "default-send-channel",
  );
  if (!defaultSend && (await getChannel(DEFAULT_CHANNEL))) {
    await db.tx(async (tx) =>
      tx.insert(CHANNEL_SEED_TABLE, {
        id: "default-send-channel",
        channel_id: DEFAULT_CHANNEL,
      }),
    );
  }
  const sysAudienceMigration = await db.get<{ id: string }>(
    CHANNEL_SEED_TABLE,
    "sys-audience-v1",
  );
  if (!sysAudienceMigration) {
    for (const channel of await getChannels()) {
      if (
        channel.type !== "system" ||
        !channel.owner_id ||
        (channel.members_json && channel.members_json !== "[]")
      )
        continue;
      await db.tx(async (tx) =>
        tx.update(CHANNELS_TABLE, channel.id, {
          members_json: JSON.stringify([channel.owner_id]),
        }),
      );
    }
    await db.tx(async (tx) =>
      tx.insert(CHANNEL_SEED_TABLE, { id: "sys-audience-v1" }),
    );
  }
  // 旧记录在建列时得到默认值；只迁移一次，之后保留管理员的设置。
  for (const channel of await getChannels()) {
    if (channel.source_configured === 1) continue;
    const sources =
      channel.id === QQ_CHANNEL
        ? { game: 0, qq: 1, system: 0 }
        : channel.type === "system"
          ? { game: 0, qq: 0, system: 1 }
          : { game: 1, qq: 0, system: 0 };
    await db.tx(
      async (tx) =>
        await tx.update(CHANNELS_TABLE, channel.id, {
          source_game: sources.game,
          source_qq: sources.qq,
          source_system: sources.system,
          source_configured: 1,
          ...(channel.id === DEFAULT_CHANNEL || channel.id === QQ_CHANNEL
            ? { type: "custom" }
            : {}),
        }),
    );
  }
}

/** 原子迁移旧频道 ID 及引用；只改标识，不删除历史或改变权限。 */
async function migrateChannelIds(): Promise<void> {
  const channels = await getChannels();
  if (channels.every((channel) => channel.id.startsWith("ch"))) return;
  await db.tx(async (tx) => {
    const current = await tx.query<ChannelRecord>(CHANNELS_TABLE);
    const occupied = new Set(current.map((channel) => channel.id));
    const mapping = new Map<string, string>();
    for (const channel of current) {
      if (channel.id.startsWith("ch")) continue;
      const next = `ch_${channel.id}`;
      if (occupied.has(next))
        throw new Error(`频道 ID 迁移冲突：${channel.id} → ${next}`);
      occupied.add(next);
      mapping.set(channel.id, next);
    }
    for (const channel of current) {
      const next = mapping.get(channel.id);
      if (!next) continue;
      // 旧私聊曾把成员编码在 ID 中；改名之前显式保存受众。
      let members = channel.members_json;
      if (channel.type === "private") {
        const parsed: unknown = members ? JSON.parse(members) : [];
        if (!Array.isArray(parsed))
          throw new Error("私聊成员数据无效，停止迁移。");
        if (parsed.length === 0) {
          if (!channel.id.startsWith("priv_"))
            throw new Error("无法识别旧私聊成员，停止迁移。");
          const legacyMembers = channel.id.slice(5).split("_");
          if (legacyMembers.length !== 2 || legacyMembers.some((id) => !id))
            throw new Error("旧私聊成员不明确，停止迁移。");
          members = JSON.stringify(legacyMembers);
        }
      }
      await tx.update(CHANNELS_TABLE, channel.id, {
        id: next,
        ...(members ? { members_json: members } : {}),
      });
      for (const message of await tx.query<MessageRecord>(MESSAGES_TABLE, {
        where: { eq: ["channel_id", channel.id] },
      })) {
        await tx.update(MESSAGES_TABLE, message.id, { channel_id: next });
      }
    }
    const remap = (id: string) => mapping.get(id) ?? id;
    const remapList = (raw: string): string => {
      const ids: unknown = JSON.parse(raw);
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
        throw new Error("频道引用列表无效，停止迁移。");
      return JSON.stringify(ids.map(remap));
    };
    for (const player of await tx.query<{
      id: string;
      active_channel?: string;
      subscribed_channels?: string;
    }>("sfmc_players")) {
      const patch: Record<string, string> = {};
      if (player.active_channel && mapping.has(player.active_channel))
        patch.active_channel = remap(player.active_channel);
      if (player.subscribed_channels) {
        const updated = remapList(player.subscribed_channels);
        if (updated !== player.subscribed_channels)
          patch.subscribed_channels = updated;
      }
      if (Object.keys(patch).length)
        await tx.update("sfmc_players", player.id, patch);
    }
    for (const meta of await tx.query<{
      id: string;
      channel_id?: string;
      channel_ids?: string;
    }>(CHANNEL_SEED_TABLE)) {
      const patch: Record<string, string> = {};
      if (meta.channel_id && mapping.has(meta.channel_id))
        patch.channel_id = remap(meta.channel_id);
      if (meta.channel_ids) {
        const updated = remapList(meta.channel_ids);
        if (updated !== meta.channel_ids) patch.channel_ids = updated;
      }
      if (Object.keys(patch).length)
        await tx.update(CHANNEL_SEED_TABLE, meta.id, patch);
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
  const channel = await ensureChannel({
    id: `ch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: normalizedName,
    type: "custom",
    prefix: normalizedPrefix,
    ownerId: owner.id,
    sources: { game: 1, qq: 0, system: 0 },
  });
  await setActiveChannel(owner, channel.id);
  return channel;
}

export async function updateChannel(
  actor: Player,
  channelId: string,
  patch: Partial<
    Pick<
      ChannelRecord,
      | "name"
      | "prefix"
      | "allow_chat"
      | "forward_to_qq"
      | "slow_mode"
      | "source_game"
      | "source_qq"
      | "source_system"
      | "source_configured"
    >
  >,
): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (!channel || !canManageChannel(actor, channel)) return false;
  if (typeof patch.name === "string") {
    const normalizedName = patch.name.trim();
    if (!normalizedName || normalizedName.length > 32) return false;
    const duplicate = (await getChannels()).some(
      (candidate) =>
        candidate.id !== channelId &&
        candidate.name.trim().toLocaleLowerCase() ===
          normalizedName.toLocaleLowerCase(),
    );
    if (duplicate) return false;
    patch = { ...patch, name: normalizedName };
  }
  await db.tx(async (tx) => await tx.update(CHANNELS_TABLE, channelId, patch));
  if (patch.source_game === 0 || patch.allow_chat === 0) {
    for (const player of world.getAllPlayers()) {
      if (getActiveChannelId(player.id) !== channelId) continue;
      const fallback = await selectSendableChannel(player, channelId);
      const previous = channelId;
      if (fallback) activeChannel.set(player.id, fallback.id);
      else activeChannel.delete(player.id);
      try {
        await persistPlayerPreferences(player);
      } catch {
        activeChannel.set(player.id, previous);
        return false;
      }
    }
  }
  return true;
}

export async function deleteChannel(
  actor: Player,
  channelId: string,
): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (!channel || !canManageChannel(actor, channel)) return false;
  await db.tx(async (tx) => await tx.delete(CHANNELS_TABLE, channelId));
  const defaultSend = await db.get<{ id: string; channel_id: string }>(
    CHANNEL_SEED_TABLE,
    "default-send-channel",
  );
  if (defaultSend?.channel_id === channelId) {
    await db.tx(async (tx) =>
      tx.update(CHANNEL_SEED_TABLE, "default-send-channel", { channel_id: "" }),
    );
  }
  for (const ids of subscribedChannels.values()) ids.delete(channelId);
  for (const player of world.getAllPlayers()) {
    if (getActiveChannelId(player.id) !== channelId) continue;
    const fallback = await selectSendableChannel(player, channelId);
    if (fallback) activeChannel.set(player.id, fallback.id);
    else activeChannel.delete(player.id);
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
  return activeChannel.get(playerId) || "";
}

export function setActiveChannelId(playerId: string, channelId: string): void {
  activeChannel.set(playerId, channelId);
}

export async function setActiveChannel(
  player: Player,
  channelId: string,
): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (
    !channel ||
    !canAccessChannel(player, channel) ||
    !canSendToChannel(player, channel)
  ) {
    return false;
  }
  const previous = getActiveChannelId(player.id);
  activeChannel.set(player.id, channelId);
  try {
    await persistPlayerPreferences(player);
  } catch {
    if (previous) activeChannel.set(player.id, previous);
    else activeChannel.delete(player.id);
    return false;
  }
  return true;
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
  const wasSubscribed = ids.has(channelId);
  if (wasSubscribed) {
    ids.delete(channelId);
  } else {
    ids.add(channelId);
  }
  try {
    await persistPlayerPreferences(player);
  } catch {
    if (wasSubscribed) ids.add(channelId);
    else ids.delete(channelId);
    return wasSubscribed;
  }
  if (!ids.has(channelId) && getActiveChannelId(player.id) === channelId) {
    const previousActive = channelId;
    const fallback = await selectSendableChannel(player, channelId);
    if (fallback) activeChannel.set(player.id, fallback.id);
    else activeChannel.delete(player.id);
    try {
      await persistPlayerPreferences(player);
    } catch {
      activeChannel.set(player.id, previousActive);
      ids.add(channelId);
      return true;
    }
  }
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
    const ids = new Set<string>();
    let hasStoredSubscriptions = false;
    if (row?.subscribed_channels) {
      const stored = JSON.parse(row.subscribed_channels) as unknown;
      if (Array.isArray(stored)) {
        hasStoredSubscriptions = true;
        for (const id of stored) {
          const channel = typeof id === "string" ? available.get(id) : null;
          if (channel && canAccessChannel(player, channel)) ids.add(id);
        }
      }
    }
    // 首次偏好采用配置的默认订阅映射；已保存列表（含空列表）原样恢复。
    if (!hasStoredSubscriptions) {
      const defaults = (
        await db.get<{ id: string; channel_ids: string }>(
          CHANNEL_SEED_TABLE,
          "default-subscriptions",
        )
      )?.channel_ids;
      const configured = defaults ? (JSON.parse(defaults) as unknown) : [];
      if (Array.isArray(configured)) {
        for (const id of configured) {
          const channel =
            typeof id === "string" ? available.get(id) : undefined;
          if (channel && canAccessChannel(player, channel)) ids.add(channel.id);
        }
      }
    }
    subscribedChannels.set(player.id, ids);
    const preferred = row?.active_channel || "";
    const preferredChannel = available.get(preferred);
    const preferredOk =
      preferredChannel &&
      canAccessChannel(player, preferredChannel) &&
      canSendToChannel(player, preferredChannel);
    const fallbackId = [...ids].find((id) => {
      const channel = available.get(id);
      return channel && canSendToChannel(player, channel);
    });
    const selected = preferredOk ? preferred : fallbackId || "";
    if (selected) activeChannel.set(player.id, selected);
    else activeChannel.delete(player.id);
  } catch (err) {
    debug.w(
      "CHAT",
      `load prefs: ${err instanceof Error ? err.message : String(err)}`,
    );
    subscribedChannels.set(player.id, new Set());
    activeChannel.delete(player.id);
  }
}

async function persistPlayerPreferences(player: Player): Promise<void> {
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
}

async function selectSendableChannel(
  player: Player,
  exceptId = "",
): Promise<ChannelRecord | null> {
  const channels = await getChannels();
  return (
    channels.find(
      (channel) =>
        channel.id !== exceptId &&
        isSubscribed(player.id, channel.id) &&
        canAccessChannel(player, channel) &&
        canSendToChannel(player, channel),
    ) ?? null
  );
}

export async function getDefaultSendChannelId(): Promise<string> {
  const configured = await db.get<{ id: string; channel_id: string }>(
    CHANNEL_SEED_TABLE,
    "default-send-channel",
  );
  return configured?.channel_id ?? "";
}

/** 轮询并投递 QQ→MC 入站消息；仅消费 qq_ 来源，避免消息回环。 */
export function startBridgePolling(intervalTicks = 600): void {
  stopBridgePolling();
  const generation = bridgeGeneration;
  void (async () => {
    const saved = await db.get<{
      id: string;
      cursor: number;
      cursor_id: string;
    }>(bridgeCursorTable, bridgeCursorKey);
    if (generation !== bridgeGeneration) return;
    if (saved) {
      bridgeCursor = saved.cursor;
      bridgeCursorId = saved.cursor_id;
    } else {
      // 首次启用从最近一页 QQ 消息的末尾开始，避免旧历史轰炸；此后进度持久化。
      const channels = (await getChannels()).filter(
        (channel) => channel.source_qq === 1,
      );
      const latest: MessageRecord[] = [];
      for (const channel of channels) {
        if (generation !== bridgeGeneration) return;
        latest.push(
          ...(await db.query<MessageRecord>(MESSAGES_TABLE, {
            where: {
              and: [
                { eq: ["channel_id", channel.id] },
                { like: ["from_id", "qq_%"] },
              ],
            },
            orderBy: [
              { field: "created_at", dir: "desc" },
              { field: "id", dir: "desc" },
            ],
            limit: 1,
          })),
        );
      }
      latest.sort(
        (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
      );
      const newest = latest.at(-1);
      bridgeCursor = newest?.created_at ?? Date.now();
      bridgeCursorId = newest?.id ?? "";
      await db.tx(async (tx) =>
        tx.insert(bridgeCursorTable, {
          id: bridgeCursorKey,
          cursor: bridgeCursor,
          cursor_id: bridgeCursorId,
        }),
      );
    }
    if (generation !== bridgeGeneration) return;
    bridgeLastTimestamp = 0;
    deliveredBridgeMessages.clear();
    bridgePollRunId = system.runInterval(
      () => {
        void pollBridgeMessages(generation);
      },
      Math.max(20, Math.floor(intervalTicks)),
    );
  })().catch((err) => {
    if (generation !== bridgeGeneration) return;
    debug.w(
      "CHAT",
      `bridge init: ${err instanceof Error ? err.message : String(err)}`,
    );
    bridgeRetryRunId = system.runTimeout(
      () => {
        bridgeRetryRunId = undefined;
        if (generation === bridgeGeneration) startBridgePolling(intervalTicks);
      },
      Math.max(20, Math.floor(intervalTicks)),
    );
  });
}

export function stopBridgePolling(): void {
  bridgeGeneration++;
  if (bridgePollRunId !== undefined) system.clearRun(bridgePollRunId);
  if (bridgeRetryRunId !== undefined) system.clearRun(bridgeRetryRunId);
  bridgePollRunId = undefined;
  bridgeRetryRunId = undefined;
  bridgeLastTimestamp = 0;
  bridgePollInFlightGeneration = -1;
  deliveredBridgeMessages.clear();
}

async function pollBridgeMessages(generation: number): Promise<void> {
  if (
    generation !== bridgeGeneration ||
    bridgePollInFlightGeneration === generation
  )
    return;
  bridgePollInFlightGeneration = generation;
  try {
    const channels = (await getChannels()).filter(
      (item) => item.source_qq === 1,
    );
    while (true) {
      if (generation !== bridgeGeneration) return;
      const rows = await db.query<MessageRecord>(MESSAGES_TABLE, {
        where: {
          and: [
            { in: ["channel_id", channels.map((channel) => channel.id)] },
            { like: ["from_id", "qq_%"] },
            {
              or: [
                { gt: ["created_at", bridgeCursor] },
                {
                  and: [
                    { eq: ["created_at", bridgeCursor] },
                    { gt: ["id", bridgeCursorId] },
                  ],
                },
              ],
            },
          ],
        },
        orderBy: [
          { field: "created_at", dir: "asc" },
          { field: "id", dir: "asc" },
        ],
        limit: 100,
      });
      if (generation !== bridgeGeneration) return;
      if (!rows.length) break;
      for (const row of rows) {
        if (generation !== bridgeGeneration) return;
        const channel = channels.find((item) => item.id === row.channel_id);
        if (
          !channel ||
          !row.from_id.startsWith("qq_") ||
          deliveredBridgeMessages.has(row.id)
        )
          continue;
        const line = formatChatLine({
          glyph: getAvatarGlyph(),
          senderName: row.from_name,
          content: decorateMessageContent(
            row.type,
            decorateMessageContent(row.content, colorCodes),
          ),
          channelPrefix: channel.prefix || channel.name || channel.id,
          titlePrefix,
          style: "channel",
        });
        for (const player of world.getAllPlayers()) {
          if (!isSubscribed(player.id, channel.id)) continue;
          if (row.created_at - bridgeLastTimestamp > 5 * 60 * 1000) {
            deliverLine(player, `§7${formatTimestamp(row.created_at)}`);
          }
          deliverLine(player, line);
        }
        if (row.created_at - bridgeLastTimestamp > 5 * 60 * 1000)
          bridgeLastTimestamp = row.created_at;
        if (generation !== bridgeGeneration) return;
        await db.tx(async (tx) =>
          tx.update(bridgeCursorTable, bridgeCursorKey, {
            cursor: row.created_at,
            cursor_id: row.id,
          }),
        );
        if (generation !== bridgeGeneration) return;
        deliveredBridgeMessages.add(row.id);
        bridgeCursor = row.created_at;
        bridgeCursorId = row.id;
      }
      if (rows.length < 100) break;
    }
    if (deliveredBridgeMessages.size > 500) deliveredBridgeMessages.clear();
  } catch (err) {
    debug.w(
      "CHAT",
      `bridge poll: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (bridgePollInFlightGeneration === generation)
      bridgePollInFlightGeneration = -1;
  }
}

/** 把玩家加入指定频道的订阅。不补回公共频道或 QQ，避免取消订阅被立刻加回。 */
function ensureSubscribed(playerId: string, channelId: string): void {
  const ids = subscribedChannels.get(playerId) ?? new Set<string>();
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
}): Promise<string | null> {
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
    return null;
  }
  return id;
}

/**
 * 发送结果：失败时带可展示文案，由调用方决定写到表单还是聊天。
 * 使用场景：世界聊天走 Msg；私聊表单 onError 走 FormStatus。
 */
export type ChatSendResult =
  | { ok: true; messageId?: string }
  | { ok: false; message: string; tone?: "warning" };

/** 世界聊天 / 命令侧展示发送失败；表单路径应 throw，不要走这里。 */
export function notifySendFailure(
  player: Player,
  result: ChatSendResult,
): void {
  if (result.ok) return;
  if (result.tone === "warning") Msg.warning(result.message, player);
  else Msg.error(result.message, player);
}

function sendRejected(
  message: string,
  tone?: "warning",
): { ok: false; message: string; tone?: "warning" } {
  return tone === "warning"
    ? { ok: false, message, tone: "warning" }
    : { ok: false, message };
}

export async function deliverChannelMessage(
  sender: Player,
  channelId: string,
  content: string,
  type = "chat",
  attachment = "",
): Promise<ChatSendResult> {
  const contentError = outgoingContentError(content, attachment);
  if (contentError) return sendRejected(contentError);
  const channel = await getChannel(channelId);
  if (!channel) {
    return sendRejected("频道不存在。");
  }
  if (!canAccessChannel(sender, channel))
    return sendRejected("你无权访问该频道。");
  // 全体禁言：普通成员不能说，频道主和管理员仍可发言。
  if (channel.source_game !== 1)
    return sendRejected("此频道未启用游戏内输入。");
  if (channel.allow_chat === 0 && !canManageChannel(sender, channel)) {
    return sendRejected("当前频道已全体禁言，只有频道主或管理员可以发言。");
  }
  const lockKey = `${sender.id}:${channel.id}`;
  if (sendLocks.has(lockKey))
    return sendRejected("消息正在发送，请稍后重试。", "warning");
  sendLocks.add(lockKey);
  const now = Date.now();
  try {
    if (channel.slow_mode > 0) {
      const last = slowModeTracker.get(sender.id)?.get(channel.id) ?? 0;
      const remaining = channel.slow_mode - (now - last) / 1000;
      if (remaining > 0) {
        return sendRejected(
          `慢速模式中，请等待 ${Math.ceil(remaining)} 秒。`,
          "warning",
        );
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
      style: "channel",
    });

    let messageId: string | null;
    messageId = await persistMessage({
      fromId: sender.id,
      fromName: sender.name,
      channelId,
      type,
      content: text,
      attachment,
      showTimestamp,
    });
    if (!messageId) {
      return sendRejected("消息存档失败，未发送。");
    }

    for (const player of world.getAllPlayers()) {
      if (!isSubscribed(player.id, channel.id)) continue;
      if (showTimestamp)
        deliverLine(player, `§7${formatTimestamp(Date.now())}`);
      deliverLine(player, formatted);
    }
    if (channel.slow_mode > 0) {
      const tracker =
        slowModeTracker.get(sender.id) ?? new Map<string, number>();
      tracker.set(channel.id, now);
      slowModeTracker.set(sender.id, tracker);
    }

    await runObservers({
      player: sender,
      message: text,
      channelId,
      formatted,
    });
    return { ok: true, messageId };
  } finally {
    sendLocks.delete(lockKey);
  }
}

/** 按目标频道类型分派发送；私聊永远以成员投递，不依赖订阅列表。 */
export async function sendToChannel(
  sender: Player,
  channelId: string,
  content: string,
  type = "chat",
  attachment = "",
): Promise<ChatSendResult> {
  const channel = await getChannel(channelId);
  if (!channel) return sendRejected("频道不存在。");
  if (channel.type !== "private")
    return deliverChannelMessage(sender, channelId, content, type, attachment);
  if (!isPrivateParticipant(channel, sender.id))
    return sendRejected("你无权访问该私聊。");
  const target = world
    .getAllPlayers()
    .find(
      (candidate) =>
        candidate.id !== sender.id &&
        isPrivateParticipant(channel, candidate.id),
    );
  if (!target)
    return sendRejected("私聊对象当前不在线，消息未发送。", "warning");
  return sendPrivate(sender, target, content, type, attachment);
}

export async function sendPrivate(
  sender: Player,
  target: Player,
  content: string,
  type = "private",
  attachment = "",
): Promise<ChatSendResult> {
  const contentError = outgoingContentError(content, attachment);
  if (contentError) return sendRejected(contentError);
  const channel = await ensurePrivateChannel(sender, target);
  if (
    !isPrivateParticipant(channel, sender.id) ||
    !isPrivateParticipant(channel, target.id)
  ) {
    return sendRejected("你无权访问该私聊。");
  }
  const lockKey = `private:${channel.id}`;
  if (sendLocks.has(lockKey))
    return sendRejected("私聊消息正在发送，请稍后重试。", "warning");
  sendLocks.add(lockKey);
  try {
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
    const messageId = await persistMessage({
      fromId: sender.id,
      fromName: sender.name,
      channelId: channel.id,
      type,
      content: text,
      attachment: attachment || target.id,
      showTimestamp,
    });
    if (!messageId) return sendRejected("私聊消息存档失败，未发送。");
    for (const [recipient, line] of [
      [target, toTarget],
      [sender, toSelf],
    ] as const) {
      if (showTimestamp)
        deliverLine(recipient, `§7${formatTimestamp(Date.now())}`);
      deliverLine(recipient, line);
    }
    return { ok: true, messageId };
  } finally {
    sendLocks.delete(lockKey);
  }
}

export async function ensurePrivateChannel(
  a: Player,
  b: Player,
): Promise<ChannelRecord> {
  const ids = [a.id, b.id].sort();
  const channelId = `ch_priv_${ids[0]}_${ids[1]}`;
  const existing = await getChannel(channelId);
  if (existing) return existing;
  const channel = await ensureChannel({
    id: channelId,
    name: `${a.name} 与 ${b.name} 的私聊`,
    type: "private",
    prefix: "私聊",
    ownerId: a.id,
    sources: { game: 1, qq: 0, system: 0 },
    forwardToQQ: 0,
    membersJson: JSON.stringify(ids),
  });
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
    /* 无效受众不允许访问。旧 ID 的受众由启动迁移显式保存。 */
  }
  return false;
}

function canAccessChannel(player: Player, channel: ChannelRecord): boolean {
  if (channel.members_json && channel.members_json !== "[]") {
    try {
      const members = JSON.parse(channel.members_json) as unknown;
      if (Array.isArray(members)) return members.includes(player.id);
    } catch {
      /* 兼容旧私聊 ID */
    }
  }
  if (channel.type === "private")
    return isPrivateParticipant(channel, player.id);
  return true;
}

export function canSendToChannel(
  player: Player,
  channel: ChannelRecord,
): boolean {
  return (
    channel.source_game === 1 &&
    (channel.allow_chat !== 0 || canManageChannel(player, channel))
  );
}

export async function cycleChannel(
  player: Player,
): Promise<ChannelRecord | null> {
  const channels = (await getChannels()).filter(
    (channel) =>
      isQuickSwitchChannel(channel) &&
      isSubscribed(player.id, channel.id) &&
      canAccessChannel(player, channel) &&
      canSendToChannel(player, channel),
  );
  if (channels.length === 0) return null;
  const currentIndex = channels.findIndex(
    (channel) => channel.id === getActiveChannelId(player.id),
  );
  const next = channels[(currentIndex + 1) % channels.length] ?? channels[0];
  if (!(await setActiveChannel(player, next.id))) return null;
  return next;
}

export async function loadChannelHistory(
  player: Player,
  channelId: string,
): Promise<void> {
  const channel = await getChannel(channelId);
  if (!channel || !canAccessChannel(player, channel)) return;
  const retention =
    channel.type === "private"
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
    if (row.show_timestamp) {
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
  const channel = (await getChannels()).find((candidate) => {
    if (
      candidate.source_system !== 1 ||
      !candidate.members_json ||
      candidate.members_json === "[]"
    )
      return false;
    try {
      const audience = JSON.parse(candidate.members_json) as unknown;
      return (
        Array.isArray(audience) &&
        audience.length === 1 &&
        audience[0] === player.id
      );
    } catch {
      return false;
    }
  });
  if (!channel) return;
  if (channel.source_system !== 1) return;
  if (!canAccessChannel(player, channel)) return;
  const messageId = await persistMessage({
    fromId: "system",
    fromName: "SYS",
    channelId: channel.id,
    type: "system",
    content,
  });
  if (!messageId) return;
  // Msg.* 已经把内容发给玩家；此回调只负责存档，避免重复显示。
}

export async function broadcast(opts: {
  content: string;
  prefix?: string;
  channelId?: string;
}): Promise<{ ok: boolean }> {
  const channel = opts.channelId ? await getChannel(opts.channelId) : null;
  if (opts.channelId && (!channel || channel.source_system !== 1))
    return { ok: false };
  const prefix = opts.prefix ? `§6[${opts.prefix}]§r ` : "§6[广播]§r ";
  const line = `${prefix}${decorateMessageContent(opts.content, colorCodes)}`;
  if (opts.channelId && channel) {
    if (!isSystemAudienceAllowed(channel)) return { ok: false };
    const messageId = await persistMessage({
      fromId: "system",
      fromName: "SYSTEM",
      channelId: opts.channelId,
      type: "broadcast",
      content: opts.content,
    });
    if (!messageId) return { ok: false };
    for (const p of world.getAllPlayers()) {
      if (isSubscribed(p.id, channel.id) && canAccessChannel(p, channel))
        deliverLine(p, line);
    }
  } else {
    for (const p of world.getAllPlayers()) deliverLine(p, line);
  }
  return { ok: true };
}

function isSystemAudienceAllowed(channel: ChannelRecord): boolean {
  if (!channel.members_json || channel.members_json === "[]") return true;
  try {
    const members = JSON.parse(channel.members_json) as unknown;
    return Array.isArray(members) && members.length > 0;
  } catch {
    return false;
  }
}

export async function handlePlayerChat(
  player: Player,
  message: string,
): Promise<void> {
  const channelId = getActiveChannelId(player.id);
  if (!channelId) {
    Msg.warning("尚未选择发送频道，请先在频道面板选择。", player);
    return;
  }
  const result = await sendToChannel(player, channelId, message);
  notifySendFailure(player, result);
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
  sendLocks.clear();
}

export function clearPlayerChatState(playerId: string): void {
  activeChannel.delete(playerId);
  subscribedChannels.delete(playerId);
  slowModeTracker.delete(playerId);
}
