# @sfmc-bds/module-chat

Wave B official SFMC module: **chat**（聊天管道中枢）。

## 功能

- 公共频道、自建频道（可全体禁言，仅频道主和管理员可发言）和持久私聊频道
- 频道订阅、快速切换、慢速模式、历史消息与玩家偏好持久化
- 定位、传送邀请和 QQ 双向桥接
- 频道与私信文字模板及五分钟分段时间戳
- `/c:chat`、`/c:tell` 与 `/c:tp` 打开的页面均由 `sapi/src/ui/*.ui.json` 声明，业务操作通过纯数据 service 执行

## 配置

每个非私聊频道的设置页可单独开关「转发到 QQ」，新建普通频道默认开启。转发时使用频道自己的显示前缀。QQ 群消息进入启用了 QQ 来源的频道；初始 QQ 频道仅预设开启 QQ 来源、关闭游戏输入，管理员可以按通用规则修改。

所有频道 ID 必须以 `ch` 开头。初始频道（`ch_global`、`ch_qq`）、玩家频道和私聊频道都通过同一个 `ensureChannel` 入口校验并创建；初始名称、来源和默认订阅映射是预设数据，不带额外删除保护或管理权限。删除初始频道后不会重新补建。

升级时会在启动阶段通过事务将旧 ID 改为 `ch_` 加旧 ID，同时迁移消息、玩家当前频道、订阅和默认频道映射。历史消息 ID 保持不变。ID 冲突或无法确认旧私聊受众时会回滚并停止初始化，不自动合并频道或删除历史。外部调用方若保存了旧频道 ID，需要同步更新。

- `title_prefix`：玩家名前的额外称号前缀，默认关闭。
- `color_codes`：是否允许消息中的 `§` 色码。
- `bridge_poll_ticks`：QQ→MC 入站消息轮询周期，默认 600 tick。
- `avatar_glyphs_enabled`：头像字形开关。当前包尚未携带旧版动态图集资源，默认关闭，避免客户端显示缺字方框。

旧版头像字形依赖单独的皮肤中继、图集烘焙和资源包部署链路；该链路完整迁移前不应开启头像字形。

## Develop

```bash
pnpm install
pnpm run typecheck
pnpm run test
```

Install into platform:

```bash
sfmc mod install chat --from dir:. --link
```
