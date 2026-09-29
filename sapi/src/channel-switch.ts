/** /c:c 按统一发送能力轮换可发送频道；私聊仍走 /c:tell。 */
export function isQuickSwitchChannel(channel: { type: string }): boolean {
  return channel.type !== "private";
}
