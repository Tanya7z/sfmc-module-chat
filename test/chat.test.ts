import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
