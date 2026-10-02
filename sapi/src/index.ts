/**
 * @sfmc-bds/module-chat — 聊天管道与消息分流中枢
 */

import { Player, world } from "@minecraft/server";
import { config } from "@sfmc-bds/sdk/sapi/config";
import { db } from "@sfmc-bds/sdk/sapi/db";
import { ModuleRegistry } from "@sfmc-bds/sdk/module-loader";
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
  ensureDefaultChannels,
  getActiveChannelId,
  getDefaultSendChannelId,
  handlePlayerChat,
  loadChannelHistory,
  loadPlayerPreferences,
  notifySendFailure,
  sendSystemMessage,
  sendPrivate,
  sendToChannel,
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
  clearAvatarCache,
  setAvatarGlyphsEnabled,
  warmAvatarCache,
} from "./avatar.js";
import {
  openChannelPanel,
  openPrivatePanel,
  registerChatUi,
  sendTeleportInvite,
  unregisterChatUi,
} from "./ui.js";
import {
  chatUiServices,
  cycleActiveChannel,
  shareLocation,
} from "./ui-services.js";

const MODULE_ID = "chat";

const unprovide: Array<() => void> = [];
const eventCleanups: Array<() => void> = [];
let systemMsgCleanup: (() => void) | undefined;
let activeLifecycle = false;

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
    forward_to_qq: { type: "INTEGER", default: 1 },
    source_game: { type: "INTEGER", default: 1 },
    source_qq: { type: "INTEGER", default: 0 },
    source_system: { type: "INTEGER", default: 0 },
    source_configured: { type: "INTEGER", default: 0 },
    slow_mode: { type: "INTEGER", default: 0 },
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
  await db.defineTable("sfmc_chat_meta", {
    id: { type: "TEXT", primary: true },
    channel_ids: { type: "TEXT", default: "[]" },
    channel_id: { type: "TEXT", default: "" },
    cursor: { type: "INTEGER", default: 0 },
    cursor_id: { type: "TEXT", default: "" },
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
      activeLifecycle = true;
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
        (await config.get<number>("bridge_poll_ticks")) ?? 600,
      );
      for (const player of world.getAllPlayers()) {
        await warmAvatarCache(player);
        await loadPlayerPreferences(player);
      }
      const removeSystemHandler = registerSystemMsgHandler((player, text) => {
        if (activeLifecycle) void sendSystemMessage(player, text);
      });
      systemMsgCleanup =
        typeof removeSystemHandler === "function"
          ? removeSystemHandler
          : () => registerSystemMsgHandler(() => {});

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
            const result = await sendPrivate(sender, target, content);
            notifySendFailure(sender, result);
            return result;
          }
          const senderId =
            typeof input.senderId === "string" ? input.senderId : undefined;
          const sender = senderId ? findPlayer(senderId) : undefined;
          if (senderId && !sender)
            return { ok: false, message: "发送者不在线。" };
          const channelId =
            typeof input.channelId === "string"
              ? input.channelId
              : await getDefaultSendChannelId();
          if (!channelId)
            return {
              ok: false,
              message: "尚未配置默认发送频道，请先在频道面板选择。",
            };
          if (sender) {
            const result = await sendToChannel(sender, channelId, content);
            notifySendFailure(sender, result);
            return result;
          }
          // 没有 senderId 才允许兼容旧调用作为全服公告；频道系统消息请用 chat.broadcast 且指定合法频道。
          if (input.channelId)
            return {
              ok: false,
              message: "系统频道消息请使用 chat.broadcast。",
            };
          return broadcast({
            content,
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

      for (const [name, handler] of Object.entries(chatUiServices)) {
        unprovide.push(service.provide(name, handler));
      }
      registerChatUi();

      debug.i("CHAT", "init pipeline ready");
    },
    cleanup() {
      activeLifecycle = false;
      systemMsgCleanup?.();
      systemMsgCleanup = undefined;
      unregisterChatUi();
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
