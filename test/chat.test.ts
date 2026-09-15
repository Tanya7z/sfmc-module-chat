import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { decorateMessageContent, formatChatLine } from "../sapi/src/format.ts";
import { formatChannelRow } from "../sapi/src/ui-labels.ts";
import {
  clearPipeline,
  interceptorCount,
  registerInterceptor,
  registerObserver,
  observerCount,
} from "../sapi/src/pipeline.ts";

describe("chat format", () => {
  it("formatChatLine", () => {
    const line = formatChatLine({
      senderName: "Ada",
      content: "hi",
      channelPrefix: "全服",
    });
    assert.match(line, /Ada/);
    assert.match(line, /hi/);
  });

  it("decorateMessageContent 可剥离彩色", () => {
    assert.equal(decorateMessageContent("§a绿", false), "绿");
  });

  it("恢复频道与私信文字模板", () => {
    assert.equal(
      formatChatLine({
        glyph: "头",
        channelPrefix: "PB",
        name: "Ada",
        content: "hi",
      }),
      "头§b[PB] §fAda: hi",
    );
    assert.equal(
      formatChatLine({
        glyph: "头",
        channelPrefix: "私聊",
        name: "Ada",
        content: "hi",
        style: "private",
      }),
      "头§d[私信] §fAda: hi",
    );
  });

  it("恢复定位与传送邀请标签", () => {
    assert.equal(decorateMessageContent("location", "1,2,3"), "§a[定位] 1,2,3");
    assert.equal(
      decorateMessageContent("teleport_invite", "来玩"),
      "§e[传送邀请] 来玩",
    );
  });
});

describe("chat pipeline", () => {
  it("注册拦截器与观察者", () => {
    clearPipeline();
    assert.equal(
      registerInterceptor({
        id: "qa",
        priority: 10,
        handler: () => false,
      }).ok,
      true,
    );
    assert.equal(
      registerObserver({
        id: "sounds",
        handler: () => undefined,
      }).ok,
      true,
    );
    assert.equal(interceptorCount(), 1);
    assert.equal(observerCount(), 1);
    clearPipeline();
  });
});

describe("chat 声明式 UI", () => {
  it("频道行文案把发送状态和订阅状态分开写", () => {
    assert.deepEqual(
      formatChannelRow({
        title: "全服 - 公共",
        onlineCount: 3,
        subscribed: true,
        active: true,
        canUnsubscribe: false,
      }),
      {
        title: "全服 - 公共",
        status: "当前发送 · 已订阅 · 3 人在线",
        subscribed: true,
        canUnsubscribe: false,
      },
    );
    assert.equal(
      formatChannelRow({
        title: "工会 - 工会",
        onlineCount: 1,
        subscribed: false,
        active: false,
        canUnsubscribe: true,
      }).status,
      "未订阅 · 1 人在线",
    );
  });

  it("manifest、feature 与页面文件保持一致", () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../sapi/manifest.json", import.meta.url)),
        "utf8",
      ),
    ) as {
      requires: string[];
      permissions: string[];
      services: {
        provides: Array<{ name: string }>;
        requires: Array<{ name: string }>;
      };
    };
    const feature = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../sapi/src/ui/feature.ui.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as { moduleId: string; screens: Array<{ id: string; file: string }> };

    assert.equal(feature.moduleId, "chat");
    assert.deepEqual(manifest.requires, []);
    assert.deepEqual(manifest.services.requires, []);
    assert.ok(!manifest.permissions.some((item) => item.startsWith("service:gui.")));
    const provided = new Set(
      manifest.services.provides.map((item) => item.name),
    );
    for (const name of [
      "chat.ui.channels",
      "chat.ui.setSubscribed",
      "chat.ui.manager",
      "chat.ui.channel",
      "chat.ui.saveChannel",
      "chat.ui.toggleAllowChat",
      "chat.ui.deleteChannel",
      "chat.ui.createChannel",
      "chat.ui.privateChannels",
      "chat.ui.activatePrivate",
      "chat.ui.compose",
      "chat.ui.onlinePlayers",
      "chat.ui.invite",
    ]) {
      assert.ok(provided.has(name), `manifest 缺少 ${name}`);
    }
    for (const screen of feature.screens) {
      const document = JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL(`../sapi/src/ui/${screen.file}`, import.meta.url),
          ),
          "utf8",
        ),
      ) as { id: string };
      assert.equal(document.id, screen.id);
    }
  });

  it("频道设置开关使用独立布尔状态，并按当前值提交", () => {
    const settings = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../sapi/src/ui/screens/settings.ui.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as {
      state: Record<string, { type: string }>;
      body: Array<{
        id?: string;
        type?: string;
        bind?: string;
        trigger?: { action?: string; input?: Record<string, string> };
      }>;
    };
    assert.equal(settings.state.allowChat?.type, "boolean");
    assert.ok(!settings.state.isBroadcast);
    const broadcast = settings.body.find((node) => node.id === "broadcast");
    const allowChat = settings.body.find((node) => node.id === "allow-chat");
    assert.equal(broadcast, undefined);
    assert.equal(allowChat?.bind, "state.allowChat");
    assert.equal(allowChat?.trigger?.input?.allowChat, "{{state.allowChat}}");
  });

  it("发起私聊用在线玩家下拉而不是文本框", () => {
    const compose = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../sapi/src/ui/screens/compose.ui.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as {
      load?: Record<string, unknown>;
      body: Array<{
        id?: string;
        type?: string;
        bind?: string;
        options?: { source?: string };
      }>;
      actions: { send: { call: { input: Record<string, string> } } };
    };
    const target = compose.body.find((node) => node.id === "target");
    assert.equal(target?.type, "dropdown");
    assert.equal(target?.bind, "state.targetId");
    assert.equal(target?.options?.source, "data.players.items");
    assert.ok(compose.load && "players" in compose.load);
    assert.equal(
      compose.actions.send.call.input.targetId,
      "{{state.targetId}}",
    );
  });
});
