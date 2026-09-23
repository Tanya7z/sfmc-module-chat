/**
 * 待发消息正文与附件的长度规则。
 * 使用场景：频道发言与私聊发送共用；世界聊天和表单各自决定如何展示失败原因。
 */

/** 正文最长 512、附件最长 256；空内容同样拒绝。 */
export const MAX_MESSAGE_CONTENT = 512;
/** 附件（如私聊对象 id）上限。 */
export const MAX_MESSAGE_ATTACHMENT = 256;

/**
 * 检查待发正文与附件是否超限；通过则返回 undefined。
 * 使用场景：deliverChannelMessage / sendPrivate 的发送前校验。
 */
export function outgoingContentError(
  content: string,
  attachment = "",
): string | undefined {
  if (
    !content.trim() ||
    content.length > MAX_MESSAGE_CONTENT ||
    attachment.length > MAX_MESSAGE_ATTACHMENT
  ) {
    return "消息为空或过长。";
  }
  return undefined;
}
