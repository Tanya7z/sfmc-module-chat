/** 聊天格式化纯函数。 */

/** 应用称号前缀与基础彩色格式。 */
export function formatChatLine(opts: {
  senderName: string;
  content: string;
  channelPrefix?: string;
  titlePrefix?: string;
}): string {
  const ch = opts.channelPrefix ? `§8[${opts.channelPrefix}]§r ` : "";
  const title = opts.titlePrefix ? `${opts.titlePrefix} ` : "";
  return `${ch}${title}§b${opts.senderName}§r: ${opts.content}`;
}

/** 装饰消息内容（保留 § 彩色）。 */
export function decorateMessageContent(
  content: string,
  enableColor = true,
): string {
  if (!enableColor) {
    return content.replace(/§./g, "");
  }
  return content;
}
