import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { decorateMessageContent, formatChatLine } from "../sapi/src/format.ts";
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

  it("恢复频道、公告板与私信文字模板", () => {
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
        channelPrefix: "BC",
        name: "Ada",
        content: "公告",
        style: "broadcast",
      }),
      "头§a[BC] Ada: 公告",
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
  it("manifest、feature 与页面文件保持一致", () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../sapi/manifest.json", import.meta.url)),
        "utf8",
      ),
    ) as {
      requires: string[];
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
    assert.ok(manifest.requires.includes("gui"));
    assert.deepEqual(
      manifest.services.requires.map((item) => item.name).sort(),
      ["gui.openScreen", "gui.registerFeature", "gui.unregisterFeature"],
    );
    const provided = new Set(
      manifest.services.provides.map((item) => item.name),
    );
    for (const name of [
      "chat.ui.channels",
      "chat.ui.selectChannel",
      "chat.ui.manager",
      "chat.ui.channel",
      "chat.ui.saveChannel",
      "chat.ui.toggleBroadcast",
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
});
