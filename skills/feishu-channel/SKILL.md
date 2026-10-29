---
name: feishu-channel
version: 1.0.0
description: |
  把 DeepSeek Harness 接到飞书（长连接，无需公网 IP）的完整操作手册：
  装插件、配凭证、连上线、放行会话、排障。也覆盖"连接通但收不到消息"这类
  只有踩过才知道的坑（权限/发布/重连顺序）。
  适用场景：
  - 用户说"连接飞书""把 DSH 接到飞书""飞书机器人不回我"
  - 要换飞书应用、换 App Secret、加新设备白名单
  - 排查飞书通道的连接/收发问题
whenToUse: |
  用户提到飞书 / Lark 机器人，或要求"在飞书里遥控 DSH"、
  "飞书发消息给 agent"、"机器人没反应"时使用。做企业微信/个人微信不走这个技能。
license: MIT
---

# 飞书通道：从零接通与排障

插件位置：`<workspace>/dsh-channel-hub`（源码）→ 安装到
`~/.dsh/profiles/desktop/node_modules/dsh-channel-hub`（DSH 实际加载的副本）。
状态目录：`~/.dsh/channel-hub/`（config.json / sessions.json / logs / admin-token）。

## 一句话判断当前状态

```bash
node bin/cli.mjs status --json
```

看三个字段就够了：

| 字段 | 含义 | 不对时去 |
|---|---|---|
| `config.configured` | 有没有有效 appId | 第 2 步 |
| `console.alive` | 插件有没有被 DSH 加载 | 第 1 步 |
| `connection.state` | 长连接有没有连上 | 第 3 步 |

## 第 1 步：装进 DSH

```bash
node bin/install.mjs          # 幂等；会复制到 profile + 插 cordis.patch.yml 行
```

**装完必须重启一次 DSH**（插件行是启动时读的）。重启后 `console.alive` 才会是 true。

判断加载成功的两个证据：

```
~/.dsh/channel-hub/logs/hub-YYYY-MM-DD.log 里有：
  控制台：http://127.0.0.1:17867/?token=...
  已订阅 session/event，等待回复文本
  已挂上 approval/request 与 user-questions/request 监听器
```

## 第 2 步：配凭证（一条命令）

```bash
node bin/cli.mjs setup --app-id cli_xxx --app-secret yyy \
  --cwd "C:/Users/<你>/Documents/deepseek-harness/default-workspace"
```

它会：**真去飞书换一次 tenant_access_token**（凭证错当场报错，不写配置）→
写 `config.json` → 如果控制台在跑就立刻连接（不用重启）。

用户还没有应用时，让他去 <https://open.feishu.cn/app> 建"企业自建应用"，且必须：

1. 添加应用能力 → **机器人**
2. 权限管理：`im:message`（收发）、`im:message:send_as_bot`、`im:resource`（下载图片/语音）
3. 事件与回调 → 订阅方式 → **使用长连接接收事件**
4. 事件与回调 → 添加事件 → `im.message.receive_v1`
5. 回调配置 → 订阅方式 → **使用长连接** → 添加回调 `card.action.trigger`（审批卡按钮用）
6. 版本管理与发布 → 创建版本 → 申请发布 → 管理员通过

## 第 3 步：连上线

```bash
node bin/cli.mjs connect        # 热连，不重启 DSH
node bin/cli.mjs status         # 看到 连接 = 已连接
```

## 第 4 步：放行会话（白名单默认空 = 谁都不回）

1. 让用户在飞书里给机器人发一句话（未授权时机器人会回一段带 peer id 的引导）
2. 读 peer id —— **从日志读，不要从截图抄**（抄错一个字符就放行了错误的会话）：

```bash
grep "拒绝未授权的会话" ~/.dsh/channel-hub/logs/hub-$(date +%F).log | tail -1
```

3. 放行：

```bash
node bin/cli.mjs allow feishu:oc_xxxxxxxx
```

## 排障：按这个顺序，别跳步

| 症状 | 检查 | 结论 |
|---|---|---|
| 控制台打不开 / `console.alive=false` | profile 的 `cordis.patch.yml` 有没有 `dsh-channel-hub` 行 | 插件没加载，重装 + 重启 |
| 连接 = error，错误是 10014/10003 | 凭证 | App Secret / App ID 不对 |
| 连接一直 connecting | 版本没发布 / 订阅方式不是长连接 | 去后台发布、改订阅方式 |
| **已连接但发消息没反应，日志一条入站都没有** | 见下 | 飞书没推事件 |
| 收到消息但不回 | 白名单 / outbox | `status` 看 `pending`、日志搜 `回合执行失败` |
| 回复残缺、第二段露 `**` | 分段渲染 | 装配层改动，需重启 DSH |

### "已连接但零事件"的四种原因（按概率排序）

1. **权限不足**：只开了 `im:message.group_at_msg`（群聊 @），私聊还需要
   `im:message.p2p_msg` 或 `im:message`。**权限改完必须重新发布版本**。
2. **版本没发布 / 待发布**：事件与权限都跟着版本走。
3. **加密策略开启**：配置里要加 `adapters.feishu.encryptKey`（适配器已支持）。
4. **长连接是发布前建立的**：`status` 看 `connection.since`，早于发布时间就
   `node bin/cli.mjs disconnect && node bin/cli.mjs connect`。

判断"飞书到底推没推"，用嗅探器（4 分钟，零事件就是飞书侧问题）：

```bash
node bin/sniff.mjs 120
```

## 热重载规则（省掉重启）

- 改 `src/adapters/*` → `node bin/cli.mjs disconnect && connect` 即生效
  （适配器动态 import 带版本串）
- 改 `src/index.js` / `format.js` / `cards.js` 等装配层 → **必须重启 DSH**

## 不要做的事

- 不要在群里开 `security.allowAll`（等于让群成员都能驱动你的电脑）
- 不要从截图里抄 peer id
- 不要把 App Secret 写进 `cordis.patch.yml`（那个文件会被分享）；只放 `config.json` 或环境变量
- 不要把 App Secret 打印到对话/日志里
