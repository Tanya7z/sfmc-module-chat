/**
 * @sfmc-bds/module-chat — 聊天管道与消息分流中枢
 */

import { Player, world } from "@minecraft/server";
import { config } from "@sfmc-bds/sdk/sapi/config";
import { db } from "@sfmc-bds/sdk/sapi/db";
import { ConfigManager, ModuleRegistry } from "@sfmc-bds/sdk/module-loader";
import {
  Command,
  debug,
  Permission,
  registerSystemMsgHandler,
} from "@sfmc-bds/sdk/sapi/runtime";
import { service } from "@sfmc-bds/sdk/sapi/service";
import {
  AVATARS_TABLE,
  CHANNELS_TABLE,
  MESSAGES_TABLE,
  broadcast,
  clearActiveChannels,
  clearPlayerChatState,
  deliverChannelMessage,
  ensureDefaultChannels,
  getActiveChannelId,
  handlePlayerChat,
  loadChannelHistory,
  loadPlayerPreferences,
  sendSystemMessage,
  sendPrivate,
  setChatStyle,
  startBridgePolling,
  stopBridgePolling,
} from "./core.js";
import {
  clearPipeline,
  registerInterceptor,
  registerObserver,
  runInterceptors,
} from "./pipeline.js";
import {
  openChannelPanel,
  openPrivatePanel,
  cycleActiveChannel,
  sendTeleportInvite,
  shareLocation,
} from "./panels.js";
import {
  clearAvatarCache,
  setAvatarGlyphsEnabled,
  warmAvatarCache,
} from "./avatar.js";

const MODULE_ID = "chat";

const unprovide: Array<() => void> = [];
const eventCleanups: Array<() => void> = [];

function findPlayer(playerId: string): Player | undefined {
  return world.getAllPlayers().find((p) => p.id === playerId);
}

async function defineTables(): Promise<void> {
  await db.defineTable(CHANNELS_TABLE, {
    id: { type: "TEXT", primary: true },
    name: { type: "TEXT", default: "" },
    type: { type: "TEXT", default: "public" },
    prefix: { type: "TEXT", default: "" },
    owner_id: { type: "TEXT", default: "" },
    allow_chat: { type: "INTEGER", default: 1 },
    slow_mode: { type: "INTEGER", default: 0 },
    is_broadcast: { type: "INTEGER", default: 0 },
    members_json: { type: "TEXT", default: "[]" },
  });
  await db.defineTable(MESSAGES_TABLE, {
    id: { type: "TEXT", primary: true },
    from_id: { type: "TEXT", default: "", index: true },
    from_name: { type: "TEXT", default: "" },
    channel_id: { type: "TEXT", default: "", index: true },
    type: { type: "TEXT", default: "chat" },
    content: { type: "TEXT", default: "" },
    attachment: { type: "TEXT", default: "" },
    created_at: { type: "INTEGER", default: 0, index: true },
    show_timestamp: { type: "INTEGER", default: 0 },
  });
  await db.defineTable(AVATARS_TABLE, {
    player_id: { type: "TEXT", primary: true },
    player_name: { type: "TEXT", default: "" },
    slot: { type: "INTEGER", default: 0 },
    skin_hash: { type: "TEXT", default: "" },
    dirty: { type: "INTEGER", default: 1 },
    updated_at: { type: "INTEGER", default: 0 },
  });
}

function registerCommands(): void {
  Command.register(
    "chat",
    "chat.use",
    (player) => {
      if (player) void openChannelPanel(player);
    },
    "打开聊天/频道面板",
    MODULE_ID,
  );
  Command.register(
    "tell",
    "chat.use",
    (player) => {
      if (player) void openPrivatePanel(player);
    },
    "打开私聊面板",
    MODULE_ID,
  );
  Command.register(
    "c",
    "chat.use",
    (player) => {
      if (!player) return;
      void cycleActiveChannel(player);
    },
    "快速切换频道",
    MODULE_ID,
  );
  Command.register(
    "lo",
    "chat.use",
    (player) => {
      if (player) void shareLocation(player);
    },
    "分享坐标",
    MODULE_ID,
  );
  Command.register(
    "tp",
    "chat.use",
    (player) => {
      if (player) void sendTeleportInvite(player);
    },
    "传送邀请",
    MODULE_ID,
  );
}

registerCommands();

ModuleRegistry.register({
  id: MODULE_ID,
  afterWorldLoad: false,
  lifecycle: {
    registerPermissions() {
      Permission.register("chat.use", Permission.Member);
      Permission.register("chat.admin", Permission.OP);
    },
    registerEvents() {
      // 独占接管原生聊天
      const cb = world.beforeEvents.chatSend.subscribe((event) => {
        const player = event.sender;
        const message = event.message;

        // 始终取消原生广播，由本模块管道接管
        event.cancel = true;

        void (async () => {
          const consumed = await runInterceptors(player, message);
          if (consumed) return;
          await handlePlayerChat(player, message);
        })();
      });
      eventCleanups.push(() => {
        try {
          world.beforeEvents.chatSend.unsubscribe(cb);
        } catch {
          /* ignore */
        }
      });

      const leaveCb = world.afterEvents.playerLeave.subscribe((event) => {
        clearPlayerChatState(event.playerId);
      });
      eventCleanups.push(() => {
        try {
          world.afterEvents.playerLeave.unsubscribe(leaveCb);
        } catch {
          /* ignore */
        }
      });

      const spawnCb = world.afterEvents.playerSpawn.subscribe((event) => {
        if (!event.initialSpawn) return;
        void (async () => {
          await warmAvatarCache(event.player);
          await loadPlayerPreferences(event.player);
          await loadChannelHistory(
            event.player,
            getActiveChannelId(event.player.id),
          );
        })();
      });
      eventCleanups.push(() => {
        try {
          world.afterEvents.playerSpawn.unsubscribe(spawnCb);
        } catch {
          /* ignore */
        }
      });
    },
    async init() {
      const prefix = await config.get<string>("title_prefix");
      const colors = await config.get<boolean>("color_codes");
      setChatStyle({
        titlePrefix: typeof prefix === "string" ? prefix : "",
        colorCodes: typeof colors === "boolean" ? colors : true,
      });
      setAvatarGlyphsEnabled(
        (await config.get<boolean>("avatar_glyphs_enabled")) === true,
      );

      await defineTables();
      await ensureDefaultChannels();
      startBridgePolling(
        ConfigManager.getSetting("bridge_channel_id", ""),
        (await config.get<number>("bridge_poll_ticks")) ?? 600,
      );
      for (const player of world.getAllPlayers()) {
        await warmAvatarCache(player);
        await loadPlayerPreferences(player);
      }
      registerSystemMsgHandler((player, text) => {
        void sendSystemMessage(player, text);
      });

      unprovide.push(
        service.provide("chat.openChannelPanel", async (input) => {
          const p = findPlayer(String(input.playerId ?? ""));
          if (!p) return { ok: false };
          await openChannelPanel(p);
          return { ok: true };
        }),
      );
      unprovide.push(
        service.provide("chat.openPrivatePanel", async (input) => {
          const p = findPlayer(String(input.playerId ?? ""));
          if (!p) return { ok: false };
          await openPrivatePanel(
            p,
            typeof input.targetId === "string" ? input.targetId : undefined,
          );
          return { ok: true };
        }),
      );
      unprovide.push(
        service.provide("chat.send", async (input) => {
          const content = String(input.content ?? "");
          if (!content) return { ok: false };
          const targetId =
            typeof input.targetPlayerId === "string"
              ? input.targetPlayerId
              : undefined;
          if (targetId) {
            const sender = findPlayer(String(input.senderId ?? ""));
            const target = findPlayer(targetId);
            if (!sender || !target) return { ok: false };
            return sendPrivate(sender, target, content);
          }
          const sender = findPlayer(String(input.senderId ?? ""));
          const channelId = String(input.channelId ?? "global");
          if (sender) {
            return deliverChannelMessage(sender, channelId, content);
          }
          // 系统代发
          return broadcast({
            content,
            channelId,
            prefix: String(input.senderName ?? "系统"),
          });
        }),
      );
      unprovide.push(
        service.provide("chat.broadcast", (input) =>
          broadcast({
            content: String(input.content ?? ""),
            prefix: typeof input.prefix === "string" ? input.prefix : undefined,
            channelId:
              typeof input.channelId === "string" ? input.channelId : undefined,
          }),
        ),
      );
      unprovide.push(
        service.provide("chat.registerInterceptor", (input) =>
          registerInterceptor({
            id: String(input.id ?? ""),
            priority: typeof input.priority === "number" ? input.priority : 100,
            handler: input.handler as never,
          }),
        ),
      );
      unprovide.push(
        service.provide("chat.onMessage", (input) =>
          registerObserver({
            id: String(input.id ?? ""),
            handler: input.handler as never,
          }),
        ),
      );

      // 弱挂载到 gui（若可用）
      void service
        .call("gui.registerMenuItem", {
          id: "chat.channel",
          title: "聊天频道",
          order: 20,
          category: "general",
          permission: "chat.use",
          handler: (player: Player) => {
            void openChannelPanel(player);
          },
        } as unknown as Record<string, unknown>)
        .catch(() => undefined);

      debug.i("CHAT", "init pipeline ready");
    },
    cleanup() {
      for (const off of unprovide.splice(0, unprovide.length)) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      for (const c of eventCleanups.splice(0, eventCleanups.length)) c();
      clearPipeline();
      clearActiveChannels();
      clearAvatarCache();
      stopBridgePolling();
      debug.i("CHAT", "cleanup");
    },
  },
});
