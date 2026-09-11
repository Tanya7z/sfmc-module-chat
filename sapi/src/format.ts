/** 频道聊天行模板（与归档版保持一致）。 */

export type ChatLineStyle = "channel" | "broadcast" | "private";

export interface FormatChatLineOptions {
  glyph?: string;
  channelPrefix?: string;
  name?: string;
  senderName?: string;
  content: string;
  style?: ChatLineStyle;
  titlePrefix?: string;
}

/** 头像 glyph + 类型色彩 + 频道前缀 + 玩家名 + 正文。 */
export function formatChatLine(opts: FormatChatLineOptions): string {
  const style = opts.style ?? "channel";
  const glyph = opts.glyph ?? "";
  const name = opts.name ?? opts.senderName ?? "";
  const prefix = opts.channelPrefix ?? "";
  const title = opts.titlePrefix ? `${opts.titlePrefix} ` : "";

  if (style === "private") return `${glyph}§d[私信] §f${name}: ${opts.content}`;
  if (style === "broadcast") {
    return `${glyph}§a[${prefix}] ${title}${name}: ${opts.content}`;
  }
  return `${glyph}§b[${prefix}] §f${title}${name}: ${opts.content}`;
}

/**
 * 两种兼容调用：
 * - `(正文, 是否允许色码)`：清理玩家输入；
 * - `(消息类型, 正文)`：恢复归档版的定位/传送标签。
 */
export function decorateMessageContent(
  typeOrContent: string,
  contentOrColor: string | boolean = true,
): string {
  if (typeof contentOrColor === "boolean") {
    return contentOrColor ? typeOrContent : typeOrContent.replace(/§./g, "");
  }
  switch (typeOrContent) {
    case "location":
      return `§a[定位] ${contentOrColor}`;
    case "teleport_invite":
      return `§e[传送邀请] ${contentOrColor}`;
    default:
      return contentOrColor;
  }
}
