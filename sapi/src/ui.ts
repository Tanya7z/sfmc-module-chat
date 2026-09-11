/** 聊天声明式页面的注册与打开入口。 */

import type { Player } from "@minecraft/server";
import { service } from "@sfmc-bds/sdk/sapi/service";
import featureUi from "./ui/feature.ui.json" with { type: "json" };
import channelsUi from "./ui/screens/channels.ui.json" with { type: "json" };
import composeUi from "./ui/screens/compose.ui.json" with { type: "json" };
import createUi from "./ui/screens/create.ui.json" with { type: "json" };
import inviteUi from "./ui/screens/invite.ui.json" with { type: "json" };
import managerUi from "./ui/screens/manager.ui.json" with { type: "json" };
import privateUi from "./ui/screens/private.ui.json" with { type: "json" };
import settingsUi from "./ui/screens/settings.ui.json" with { type: "json" };
import { preparePrivateChannel } from "./ui-services.js";

const MODULE_ID = "chat";

export async function registerChatUi(): Promise<void> {
  const result = await service.call<{ ok?: boolean; error?: string }>(
    "gui.registerFeature",
    {
      feature: featureUi,
      screens: {
        "screens/channels.ui.json": channelsUi,
        "screens/manager.ui.json": managerUi,
        "screens/settings.ui.json": settingsUi,
        "screens/create.ui.json": createUi,
        "screens/private.ui.json": privateUi,
        "screens/compose.ui.json": composeUi,
        "screens/invite.ui.json": inviteUi,
      },
    },
  );
  if (!result?.ok) throw new Error(result?.error || "聊天 UI 注册失败");
}

export function unregisterChatUi(): Promise<unknown> {
  return service.call("gui.unregisterFeature", { moduleId: MODULE_ID });
}

export function openChatUi(
  player: Player,
  screenId = "chat.channels",
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return service.call("gui.openScreen", {
    playerId: player.id,
    moduleId: MODULE_ID,
    screenId,
    params,
  });
}

export async function openChannelPanel(player: Player): Promise<void> {
  await openChatUi(player, "chat.channels");
}

export async function openPrivatePanel(
  player: Player,
  targetId?: string,
): Promise<void> {
  if (targetId) await preparePrivateChannel(player, targetId);
  await openChatUi(player, "chat.private");
}

export async function sendTeleportInvite(player: Player): Promise<void> {
  await openChatUi(player, "chat.invite");
}
