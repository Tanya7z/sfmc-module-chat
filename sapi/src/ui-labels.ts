/** 频道面板列表行文案：名称与状态分开，订阅由开关控制。 */

/** 生成频道行文案时需要的订阅/发送状态。 */
export type ChannelRowState = {
  /** 频道标题，形如「全服 - 公共频道」。 */
  title: string;
  /** 当前订阅该频道的在线人数。 */
  onlineCount: number;
  /** 玩家是否已订阅（公共频道视为始终订阅）。 */
  subscribed: boolean;
  /** 是否为当前发送频道（仅展示，发送切换走指令）。 */
  active: boolean;
  /** 是否允许取消订阅（公共频道不行）。 */
  canUnsubscribe: boolean;
};

/** 频道列表行交给声明式 UI 的字段。 */
export type ChannelRow = {
  /** 第一行：频道名。 */
  title: string;
  /** 第二行：订阅/发送状态与在线人数。 */
  status: string;
  /** 订阅开关的当前值。 */
  subscribed: boolean;
  /** 公共频道锁定订阅开关。 */
  canUnsubscribe: boolean;
};

/**
 * 根据订阅/发送状态生成频道行文案。
 * 使用场景：聊天频道面板每一行展示名称+状态，旁边只放订阅开关。
 */
export function formatChannelRow(state: ChannelRowState): ChannelRow {
  const online = `${state.onlineCount} 人在线`;
  let status: string;
  if (state.active && state.subscribed) {
    status = `当前发送 · 已订阅 · ${online}`;
  } else if (state.active) {
    status = `当前发送 · ${online}`;
  } else if (state.subscribed) {
    status = `已订阅 · ${online}`;
  } else {
    status = `未订阅 · ${online}`;
  }
  return {
    title: state.title,
    status,
    subscribed: state.subscribed,
    canUnsubscribe: state.canUnsubscribe,
  };
}
