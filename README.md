# @sfmc-bds/module-chat

Wave B official SFMC module: **chat**（聊天管道中枢）。

## 功能

- 公共频道、公告板、自建频道和持久私聊频道
- 频道订阅、快速切换、慢速模式、历史消息与玩家偏好持久化
- 定位、传送邀请和 QQ 双向桥接
- 归档版 PB / BC / 私信文字模板及五分钟分段时间戳
- `/c:chat`、`/c:tell` 与 `/c:tp` 打开的页面均由 `sapi/src/ui/*.ui.json` 声明，业务操作通过纯数据 service 执行

## 配置

- `title_prefix`：玩家名前的额外称号前缀，默认关闭。
- `color_codes`：是否允许消息中的 `§` 色码。
- `bridge_poll_ticks`：QQ→MC 入站消息轮询周期，默认 600 tick。
- `avatar_glyphs_enabled`：头像字形开关。当前包尚未携带旧版动态图集资源，默认关闭，避免客户端显示缺字方框。

旧版头像字形依赖单独的皮肤中继、图集烘焙和资源包部署链路；该链路完整迁移前不应开启头像字形。

## Develop

```bash
npm install
npm run typecheck
npm test
```

Install into platform:

```bash
sfmc mod install chat --from dir:. --link
```
