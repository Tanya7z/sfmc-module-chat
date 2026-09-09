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
