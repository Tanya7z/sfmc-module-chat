/**
 * 聊天 GUI 面板（MenuNavigator，经 service 打开）
 */

import { Player, world } from "@minecraft/server";
import { FormStatus, MenuNavigator, Msg, obsStr } from "@sfmc-bds/sdk/sapi/runtime";
import {
  deliverChannelMessage,
  findPlayerByName,
  getActiveChannelId,
  sendPrivate,
  setActiveChannelId,
} from "./core.js";
import { claimRedPacket, sendRedPacket } from "./redpacket.js";

export async function openChannelPanel(player: Player): Promise<void> {
  const nav = new MenuNavigator(player);
  const active = getActiveChannelId(player.id);
  nav.section("channels", "频道面板", (page) => {
    page.header("频道");
    page.label(`当前频道: §e${active}`);
    page.button("切换到公共频道", () => {
      setActiveChannelId(player.id, "global");
      Msg.success("已切换到公共频道", player);
      void nav.rebuild();
    });
    page.button("关闭", () => nav.leave(() => undefined));
  });
  await nav.start("channels");
}

export async function openPrivatePanel(
  player: Player,
  targetId?: string,
): Promise<void> {
  const nav = new MenuNavigator(player);
  const targetName = obsStr("");
  const content = obsStr("");
  if (targetId) {
    const t = world.getAllPlayers().find((p) => p.id === targetId);
    if (t) targetName.setData(t.name);
  }
  nav.section("pm", "私聊", (page) => {
    const status = new FormStatus(page);
    page.textField("目标玩家", targetName, { description: "玩家名" });
    page.textField("消息内容", content, { description: "说点什么…" });
    page.button("发送", async () => {
      await nav.runTask(status, async () => {
        const target = findPlayerByName(targetName.getData().trim());
        if (!target) throw new Error("未找到目标玩家");
        const text = content.getData().trim();
        if (!text) throw new Error("消息不能为空");
        await sendPrivate(player, target, text);
        status.ok("已发送");
      });
    });
  });
  await nav.start("pm");
}

export async function openRedPacketPanel(player: Player): Promise<void> {
  const nav = new MenuNavigator(player);
  const amountObs = obsStr("100");
  const countObs = obsStr("5");
  nav.section("hb", "红包", (page) => {
    const status = new FormStatus(page);
    page.header("发红包 / 领红包");
    page.textField("总金额", amountObs);
    page.textField("份数", countObs);
    page.button("发送红包", async () => {
      await nav.runTask(status, async () => {
        const amount = parseInt(amountObs.getData(), 10);
        const count = parseInt(countObs.getData(), 10);
        const r = await sendRedPacket(player, amount, count);
        if (!r.ok) throw new Error("发送失败");
        status.ok(`已发送 ${r.id}`);
      });
    });
    page.button("领取最近红包", async () => {
      await nav.runTask(status, async () => {
        const r = await claimRedPacket(player);
        if (!r.ok) throw new Error("领取失败");
        status.ok("领取成功");
      });
    });
  });
  await nav.start("hb");
}

export async function shareLocation(player: Player): Promise<void> {
  const loc = player.location;
  const dim = player.dimension.id;
  const text = `📍 坐标 §e${Math.floor(loc.x)}, ${Math.floor(loc.y)}, ${Math.floor(loc.z)} §7@ ${dim}`;
  await deliverChannelMessage(player, getActiveChannelId(player.id), text);
}

export async function sendTeleportInvite(player: Player): Promise<void> {
  const text = `§a[传送邀请] §f点击传送至 §b${player.name}§f（请使用服务器传送插件或管理员协助）`;
  await deliverChannelMessage(player, getActiveChannelId(player.id), text);
  Msg.tips("已发送传送邀请到当前频道", player);
}
