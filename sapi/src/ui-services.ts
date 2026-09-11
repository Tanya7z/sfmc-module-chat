/** 聊天声明式页面使用的纯数据 service 适配层。 */

import { Player, world } from "@minecraft/server";
import { Msg } from "@sfmc-bds/sdk/sapi/runtime";
import {
  canManageChannel,
  createChannel,
  cycleChannel,
  deleteChannel,
  deliverChannelMessage,
  ensurePrivateChannel,
  findPlayerByName,
  getActiveChannelId,
  getChannel,
  getChannels,
  getOnlineCount,
  getPrivateChannels,
  isSubscribed,
  loadChannelHistory,
  sendPrivate,
  setActiveChannel,
  toggleSubscription,
  updateChannel,
  type ChannelRecord,
} from "./core.js";

function player(input: Record<string, unknown>): Player {
  const playerId = String(input.playerId ?? "");
  const found = world
    .getAllPlayers()
    .find((candidate) => candidate.id === playerId);
  if (!found) throw new Error("玩家不在线");
  return found;
}

function channelLabel(
  channel: ChannelRecord,
  actor: Player,
  activeId: string,
): string {
  const subscribed =
    channel.type === "public" || isSubscribed(actor.id, channel.id);
  const mark = channel.id === activeId ? "§e▶" : subscribed ? "§a☑" : "§7☐";
  return `${mark} ${channel.prefix} - ${channel.name}\n§7${getOnlineCount(channel.id)} 人在线`;
}

async function channels(input: Record<string, unknown>) {
  const actor = player(input);
  const activeId = getActiveChannelId(actor.id);
  const rows = (await getChannels()).filter(
    (channel) => channel.type !== "private" && channel.type !== "system",
  );
  const active = rows.find((channel) => channel.id === activeId);
  return {
    activeLabel: active ? `${active.prefix} - ${active.name}` : activeId,
    items: rows.map((channel) => ({
      id: channel.id,
      label: channelLabel(channel, actor, activeId),
    })),
  };
}

async function selectChannel(input: Record<string, unknown>) {
  const actor = player(input);
  const channelId = String(input.channelId ?? "");
  const rows = (await getChannels()).filter(
    (channel) => channel.type !== "private" && channel.type !== "system",
  );
  const channel = rows.find((candidate) => candidate.id === channelId);
  if (!channel) throw new Error("频道不存在");

  if (
    channel.id === getActiveChannelId(actor.id) &&
    channel.type !== "public"
  ) {
    await toggleSubscription(actor, channel.id);
    const fallback = rows.find((candidate) => candidate.type === "public");
    if (fallback) {
      await setActiveChannel(actor, fallback.id);
      await loadChannelHistory(actor, fallback.id);
    }
  } else {
    if (!isSubscribed(actor.id, channel.id))
      await toggleSubscription(actor, channel.id);
    await setActiveChannel(actor, channel.id);
    await loadChannelHistory(actor, channel.id);
  }
  return { ok: true };
}

async function manager(input: Record<string, unknown>) {
  const actor = player(input);
  const rows = await getChannels();
  return {
    count: rows.length,
    items: rows.map((channel) => ({
      id: channel.id,
      label: `${channel.prefix} - ${channel.name}\n§7${getOnlineCount(channel.id)} 人在线`,
      canManage: canManageChannel(actor, channel),
    })),
  };
}

async function managedChannel(
  input: Record<string, unknown>,
): Promise<{ actor: Player; channel: ChannelRecord }> {
  const actor = player(input);
  const channel = await getChannel(String(input.channelId ?? ""));
  if (!channel) throw new Error("频道不存在");
  if (!canManageChannel(actor, channel)) throw new Error("没有频道管理权限");
  return { actor, channel };
}

async function channelDetail(input: Record<string, unknown>) {
  const { channel } = await managedChannel(input);
  return {
    id: channel.id,
    name: channel.name,
    prefix: channel.prefix,
    type: channel.type,
    slowMode: channel.slow_mode,
    broadcastText: channel.is_broadcast ? "开启" : "关闭",
    allowChatText: channel.allow_chat ? "是" : "否",
    canDelete: channel.type !== "public",
  };
}

async function saveChannel(input: Record<string, unknown>) {
  const { actor, channel } = await managedChannel(input);
  const patch: Partial<Pick<ChannelRecord, "name" | "prefix" | "slow_mode">> =
    {};
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const prefix = typeof input.prefix === "string" ? input.prefix.trim() : "";
  const slowMode =
    typeof input.slowMode === "string" ? input.slowMode.trim() : "";

  if (name) {
    if (name.length > 32) throw new Error("频道名称最长 32 字");
    patch.name = name;
  }
  if (prefix) {
    if (prefix.length > 12) throw new Error("显示前缀最长 12 字");
    patch.prefix = prefix;
  }
  if (slowMode) {
    const seconds = Number(slowMode);
    if (!Number.isInteger(seconds) || seconds < 0)
      throw new Error("慢速模式必须是非负整数秒");
    patch.slow_mode = seconds;
  }
  if (Object.keys(patch).length === 0) throw new Error("没有可保存的修改");
  if (!(await updateChannel(actor, channel.id, patch)))
    throw new Error("频道保存失败");
  return { ok: true };
}

async function toggleChannelFlag(
  input: Record<string, unknown>,
  field: "is_broadcast" | "allow_chat",
) {
  const { actor, channel } = await managedChannel(input);
  const next = channel[field] ? 0 : 1;
  if (!(await updateChannel(actor, channel.id, { [field]: next }))) {
    throw new Error("频道设置更新失败");
  }
  return { ok: true, value: next };
}

async function removeChannel(input: Record<string, unknown>) {
  const { actor, channel } = await managedChannel(input);
  if (!(await deleteChannel(actor, channel.id)))
    throw new Error("频道删除失败");
  return { ok: true };
}

async function create(input: Record<string, unknown>) {
  const actor = player(input);
  const channel = await createChannel(
    actor,
    String(input.name ?? ""),
    String(input.prefix ?? ""),
  );
  if (!channel) throw new Error("创建失败，名称可能重复或输入为空");
  return { id: channel.id, name: channel.name };
}

async function privateChannels(input: Record<string, unknown>) {
  const actor = player(input);
  return {
    items: (await getPrivateChannels(actor)).map((channel) => ({
      id: channel.id,
      name: channel.name,
    })),
  };
}

async function activatePrivate(input: Record<string, unknown>) {
  const actor = player(input);
  const channelId = String(input.channelId ?? "");
  const channel = (await getPrivateChannels(actor)).find(
    (candidate) => candidate.id === channelId,
  );
  if (!channel) throw new Error("私聊频道不存在");
  await setActiveChannel(actor, channel.id);
  await loadChannelHistory(actor, channel.id);
  return { ok: true, name: channel.name };
}

async function compose(input: Record<string, unknown>) {
  const actor = player(input);
  const target = findPlayerByName(String(input.targetName ?? "").trim());
  if (!target || target.id === actor.id) throw new Error("未找到目标玩家");
  const content = String(input.content ?? "").trim();
  if (!content) throw new Error("消息不能为空");
  const channel = await ensurePrivateChannel(actor, target);
  await setActiveChannel(actor, channel.id);
  await sendPrivate(actor, target, content);
  return { ok: true, targetName: target.name };
}

function onlinePlayers(input: Record<string, unknown>) {
  const actor = player(input);
  return {
    items: world
      .getAllPlayers()
      .filter((candidate) => candidate.id !== actor.id)
      .map((candidate) => ({ id: candidate.id, name: candidate.name })),
  };
}

async function invite(input: Record<string, unknown>) {
  const actor = player(input);
  const target = world
    .getAllPlayers()
    .find((candidate) => candidate.id === String(input.targetId ?? ""));
  if (!target || target.id === actor.id) throw new Error("目标玩家不在线");
  const loc = actor.location;
  const location = `${actor.dimension.id}:${Math.floor(loc.x)},${Math.floor(loc.y)},${Math.floor(loc.z)}`;
  await sendPrivate(
    actor,
    target,
    `${actor.name} 邀请你传送到他的位置！（${location}）`,
    "teleport_invite",
  );
  return { ok: true, targetName: target.name };
}

export async function preparePrivateChannel(
  actor: Player,
  targetId: string,
): Promise<void> {
  const target = world
    .getAllPlayers()
    .find((candidate) => candidate.id === targetId);
  if (target && target.id !== actor.id)
    await ensurePrivateChannel(actor, target);
}

export async function shareLocation(player: Player): Promise<void> {
  const loc = player.location;
  const content = `${player.dimension.id}:${Math.floor(loc.x)},${Math.floor(loc.y)},${Math.floor(loc.z)}`;
  await deliverChannelMessage(
    player,
    getActiveChannelId(player.id),
    content,
    "location",
  );
}

export async function cycleActiveChannel(player: Player): Promise<void> {
  const next = await cycleChannel(player);
  if (!next) {
    Msg.warning("没有可切换的频道", player);
    return;
  }
  Msg.success(`已切换到 ${next.prefix} - ${next.name}`, player);
  await loadChannelHistory(player, next.id);
}

export const chatUiServices: Record<
  string,
  (input: Record<string, unknown>) => unknown | Promise<unknown>
> = {
  "chat.ui.channels": channels,
  "chat.ui.selectChannel": selectChannel,
  "chat.ui.manager": manager,
  "chat.ui.channel": channelDetail,
  "chat.ui.saveChannel": saveChannel,
  "chat.ui.toggleBroadcast": (input) =>
    toggleChannelFlag(input, "is_broadcast"),
  "chat.ui.toggleAllowChat": (input) => toggleChannelFlag(input, "allow_chat"),
  "chat.ui.deleteChannel": removeChannel,
  "chat.ui.createChannel": create,
  "chat.ui.privateChannels": privateChannels,
  "chat.ui.activatePrivate": activatePrivate,
  "chat.ui.compose": compose,
  "chat.ui.onlinePlayers": onlinePlayers,
  "chat.ui.invite": invite,
};
