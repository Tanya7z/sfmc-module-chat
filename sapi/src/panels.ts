/** 聊天 GUI：频道订阅/管理、私聊、定位与传送邀请。 */

import { Player, world } from "@minecraft/server";
import {
  FormStatus,
  ListFormInfo,
  MenuNavigator,
  Msg,
  type Page,
  obsStr,
} from "@sfmc-bds/sdk/sapi/runtime";
import {
  type ChannelRecord,
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
} from "./core.js";

class ChatPanel {
  private readonly nav: MenuNavigator;

  constructor(private readonly player: Player) {
    this.nav = new MenuNavigator(player);
    this.registerSections();
  }

  start(section: string): Promise<void> {
    return this.nav.start(section);
  }

  private registerSections(): void {
    this.nav.section("channels", "聊天频道", (page) =>
      this.buildChannels(page),
    );
    this.nav.section("manager", "频道管理", (page) => this.buildManager(page));
    this.nav.section("settings", "频道设置", (page) =>
      this.buildSettings(page),
    );
    this.nav.section("create", "创建频道", (page) => this.buildCreate(page));
    this.nav.section("private", "私聊频道", (page) => this.buildPrivate(page));
    this.nav.section("compose", "发送私聊", (page) => this.buildCompose(page));
    this.nav.section("invite", "传送邀请", (page) => this.buildInvite(page));
  }

  private async buildChannels(page: Page): Promise<void> {
    const channels = (await getChannels()).filter(
      (channel) => channel.type !== "private" && channel.type !== "system",
    );
    const activeId = getActiveChannelId(this.player.id);
    const active = channels.find((channel) => channel.id === activeId);
    page.label(
      ListFormInfo([
        `当前发送频道：${active?.prefix ?? activeId}`,
        "点击频道可订阅、切换或取消订阅",
      ]),
    );
    page.button("频道管理", () => this.nav.go("manager"));
    page.button("私聊频道", () => this.nav.go("private"));
    for (const channel of channels) {
      const subscribed =
        channel.type === "public" || isSubscribed(this.player.id, channel.id);
      const mark = channel.id === activeId ? "§e▶" : subscribed ? "§a☑" : "§7☐";
      page.button(
        `${mark} ${channel.prefix} - ${channel.name}\n§7${getOnlineCount(channel.id)} 人在线`,
        async () => {
          if (channel.id === activeId && channel.type !== "public") {
            await toggleSubscription(this.player, channel.id);
            const publicChannel = channels.find(
              (candidate) => candidate.type === "public",
            );
            if (publicChannel)
              await setActiveChannel(this.player, publicChannel.id);
          } else {
            if (!subscribed) await toggleSubscription(this.player, channel.id);
            await setActiveChannel(this.player, channel.id);
            await loadChannelHistory(this.player, channel.id);
          }
          await this.nav.rebuild("channels");
        },
      );
    }
  }

  private async buildManager(page: Page): Promise<void> {
    const channels = await getChannels();
    page.label(ListFormInfo([`共有 ${channels.length} 个频道`]));
    page.button("创建频道", () => this.nav.go("create"));
    for (const channel of channels) {
      page.button(
        `${channel.prefix} - ${channel.name}\n§7${getOnlineCount(channel.id)} 人在线`,
        async () => {
          if (canManageChannel(this.player, channel)) {
            this.nav.state.channel = channel;
            await this.nav.rebuild("settings");
          } else {
            await setActiveChannel(this.player, channel.id);
            await loadChannelHistory(this.player, channel.id);
            await this.nav.rebuild("channels");
          }
        },
      );
    }
  }

  private async buildSettings(page: Page): Promise<void> {
    const selected = this.nav.state.channel as ChannelRecord | undefined;
    const channel = selected ? await getChannel(selected.id) : null;
    if (!channel) {
      page.label("频道数据不存在，请返回重试。");
      return;
    }
    const status = new FormStatus(page);
    const name = obsStr(channel.name);
    const prefix = obsStr(channel.prefix);
    const slowMode = obsStr(String(channel.slow_mode));
    page.label(
      ListFormInfo([
        `${channel.prefix} - ${channel.name}`,
        `类型：${channel.type}`,
        `公告板：${channel.is_broadcast ? "开启" : "关闭"}`,
        `允许发言：${channel.allow_chat ? "是" : "否"}`,
      ]),
    );
    page.textField("频道名称", name);
    page.textField("显示前缀", prefix);
    page.textField("慢速模式秒数", slowMode);
    page.button("保存名称与慢速模式", async () => {
      const seconds = Math.max(0, Number.parseInt(slowMode.getData(), 10) || 0);
      const ok = await updateChannel(this.player, channel.id, {
        name: name.getData().trim(),
        prefix: prefix.getData().trim(),
        slow_mode: seconds,
      });
      if (ok) status.ok("频道设置已保存");
      else status.fail("没有权限或保存失败");
    });
    page.button(
      `公告板模式（${channel.is_broadcast ? "开" : "关"}）`,
      async () => {
        await updateChannel(this.player, channel.id, {
          is_broadcast: channel.is_broadcast ? 0 : 1,
        });
        await this.nav.rebuild("settings");
      },
    );
    page.button(`允许发言（${channel.allow_chat ? "开" : "关"}）`, async () => {
      await updateChannel(this.player, channel.id, {
        allow_chat: channel.allow_chat ? 0 : 1,
      });
      await this.nav.rebuild("settings");
    });
    if (channel.type !== "public") {
      page.button("删除频道", () => {
        this.nav.confirm(
          "删除频道",
          `确认删除频道“${channel.name}”吗？`,
          async () => {
            await deleteChannel(this.player, channel.id);
            await this.nav.rebuild("manager");
          },
          () => this.nav.rebuild("settings"),
        );
      });
    }
  }

  private buildCreate(page: Page): void {
    const status = new FormStatus(page);
    const name = obsStr("");
    const prefix = obsStr("");
    page.textField("频道名称", name, { description: "输入频道名称" });
    page.textField("显示前缀", prefix, { description: "建议使用简短前缀" });
    page.button("创建", async () => {
      const channel = await createChannel(
        this.player,
        name.getData(),
        prefix.getData(),
      );
      if (!channel) {
        status.fail("创建失败，名称可能重复或输入为空。");
        return;
      }
      status.ok(`频道“${channel.name}”已创建并切换`);
      await this.nav.rebuild("channels");
    });
  }

  private async buildPrivate(page: Page): Promise<void> {
    const channels = await getPrivateChannels(this.player);
    page.button("新消息", () => this.nav.go("compose"));
    if (channels.length === 0) page.label(ListFormInfo(["暂无私聊频道"]));
    for (const channel of channels) {
      page.button(channel.name, async () => {
        await setActiveChannel(this.player, channel.id);
        await loadChannelHistory(this.player, channel.id);
      });
    }
  }

  private buildCompose(page: Page): void {
    const status = new FormStatus(page);
    const targetName = obsStr("");
    const content = obsStr("");
    page.textField("目标玩家", targetName);
    page.textField("消息内容", content);
    page.button("发送", async () => {
      const target = findPlayerByName(targetName.getData().trim());
      if (!target || target.id === this.player.id) {
        status.fail("未找到目标玩家");
        return;
      }
      const text = content.getData().trim();
      if (!text) {
        status.fail("消息不能为空");
        return;
      }
      const channel = await ensurePrivateChannel(this.player, target);
      await setActiveChannel(this.player, channel.id);
      await sendPrivate(this.player, target, text);
      status.ok("私聊已发送");
    });
  }

  private async buildInvite(page: Page): Promise<void> {
    const players = world
      .getAllPlayers()
      .filter((candidate) => candidate.id !== this.player.id);
    if (!players.length) {
      page.label(ListFormInfo(["当前没有其他在线玩家"]));
      return;
    }
    for (const target of players) {
      page.button(target.name, async () => {
        const loc = this.player.location;
        const location = `${this.player.dimension.id}:${Math.floor(loc.x)},${Math.floor(loc.y)},${Math.floor(loc.z)}`;
        await sendPrivate(
          this.player,
          target,
          `${this.player.name} 邀请你传送到他的位置！（${location}）`,
          "teleport_invite",
        );
        Msg.success(`已向 ${target.name} 发送传送邀请`, this.player);
      });
    }
  }
}

export async function openChannelPanel(player: Player): Promise<void> {
  await new ChatPanel(player).start("channels");
}

export async function openPrivatePanel(
  player: Player,
  targetId?: string,
): Promise<void> {
  if (targetId) {
    const target = world
      .getAllPlayers()
      .find((candidate) => candidate.id === targetId);
    if (target) await ensurePrivateChannel(player, target);
  }
  await new ChatPanel(player).start("private");
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

export async function sendTeleportInvite(player: Player): Promise<void> {
  await new ChatPanel(player).start("invite");
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
