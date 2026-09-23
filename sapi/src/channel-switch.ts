/** /c:c 可轮换：公共/自建频道，以及当前玩家自己的 SYS；私聊仍走 /c:tell。 */
export function isQuickSwitchChannel(
  channel: { type: string; owner_id: string },
  playerId: string,
): boolean {
  if (channel.type === "private") return false;
  if (channel.type === "system") return channel.owner_id === playerId;
  return true;
}
