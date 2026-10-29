# dsh-channel-hub

**把飞书变成 DeepSeek Harness 的远程控制台。** 在手机上发一句话，电脑上的 DSH agent 就开始干活；进度、审批、长输出，全在聊天窗口里完成。

不需要公网 IP，不需要内网穿透，不需要独立桥接进程 —— 飞书的 **WebSocket 长连接**从你电脑主动连出去，事件顺着这条连接回来。

> 只想先把东西跑起来？看 **[docs/quickstart.md](docs/quickstart.md)**（照着勾选，10 分钟）。
> 想发给别人用？看 **[docs/distribute.md](docs/distribute.md)**（打包、发布、上架、避坑）。

## 对 agent 说一句话就行

装好之后，插件自带一个 DSH 技能 `feishu-channel`。以后你只要说：

> 「帮我连接飞书」/「飞书机器人不回我了」/「换个飞书应用」

agent 会按顺序自己跑（全部支持 `--json` + 退出码，不需要解析人话）：

```bash
node bin/cli.mjs status --json      # 判断卡在哪一步
node bin/cli.mjs setup --app-id … --app-secret …   # 验凭证、写配置、触发连接
node bin/cli.mjs allow feishu:oc_…  # 放行你的会话
```

```
飞书手机端 ──┐                                    ┌── DSH agent（本机）
             ├─ 长连接（官方 API） ── dsh-channel-hub ┤
飞书桌面端 ──┘      收/发消息、卡片、按钮            └── 会话 / 工具 / 审批
```

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| 图形化控制台 | 浏览器里填凭证 → 点连接 → 一键授权，不用改 JSON、不用重启第二次 |
| 聊天即会话 | 一个飞书聊天窗口 = 一个 DSH 会话，重启后自动接上历史 |
| 图片 | 发图给机器人，图片经宿主准入变成 durable 附件，agent 真的能看到 |
| 语音 | 有转写服务就转成文字；没有就存成音频附件 + 明确告诉 agent"这是一段语音" |
| 文件 | PDF/代码/表格等按附件转交，不猜内容 |
| 进度可见 | 一条"会变大"的卡片：从「已收到」长成最终答案，不刷屏 |
| 审批卡 | agent 要权限时推一张带按钮的卡片，点一下即可；也可回 `1` / `2` |
| 提问卡 | `ask_user_question` 变成一个可点的选择卡 |
| 长输出分段 | 按段落切开、**不切断代码块**，代码用卡片渲染 markdown |
| 命令 | `/new` `/status` `/stop` `/approve` `/deny` `/id` `/help`，不消耗模型回合 |
| 不丢消息 | 平台重投去重、同一窗口严格串行、出站失败进磁盘队列指数退避 |
| 默认安全 | 白名单为空 = 谁都不回；不授权的人只会收到一段引导 |

---

## 为什么又写一个

参考了两个已有的微信通道插件（见文末）。它们都证明了一件事：DSH 没有现成的 channel seam，**入站适配器 + 会话映射 + 出站订阅**这三块必须自己写。我认同这个判断，但在三处做了不同的取舍：

1. **内核与平台解耦。** 两个参考实现都把"微信"写进了主干。这里把会话路由、串行队列、回合等待、审批竞速、出站重试全部放进内核，适配器只剩三个方法（`sendText` / `sendCard` / `updateCard`）+ 一个入站回调。换平台不用碰内核。
2. **一条会长的卡片，而不是连发多条"正在处理"。** 进度、中间状态、最终答案都落在同一张卡上（飞书支持 `PATCH` 卡片），会话窗口干净得多。
3. **不替你决定。** 审批卡超时只把卡片从聊天里撤下，**不 resolve** —— 网页端仍然可以处理。这是刻意的：IM 不该替人做授权决定。

另外，它**不做个人微信**。个人微信没有官方机器人 API，参考实现走的是逆向的 iLink/ClawBot 协议，有封号风险；这条边界我选择不越（理由见 [已知边界](#已知边界)）。

---

## 5 分钟上手（飞书）

### 1. 建一个企业自建应用

1. 打开 <https://open.feishu.cn/app> → **创建企业自建应用**（个人也能注册免费团队）
2. 进入应用 → **添加应用能力** → 勾选 **机器人**
3. **凭证与基础信息** 里抄下 `App ID` 和 `App Secret`

### 2. 开权限、开长连接、订事件

| 位置 | 要做什么 |
|---|---|
| 权限管理 | 搜索并开通：`im:message`（收发消息）、`im:message:send_as_bot`（以机器人身份发送）、**`im:resource`（下载图片/语音/文件，发图必须开）** |
| 事件与回调 → 订阅方式 | 选 **使用长连接接收事件**（不是"将事件发送至开发者服务器"） |
| 事件与回调 → 添加事件 | `im.message.receive_v1`（接收消息） |
| 事件与回调 → 回调订阅 | `card.action.trigger`（卡片按钮点击） |
| 版本管理与发布 | 创建版本 → 申请发布（企业管理员审核通过后生效） |

> 长连接模式**不需要**填公网地址、不需要备案、不需要 ngrok。这正是选飞书的原因。

### 3. 装进 DSH

**官方方式**（有 `dsh` 命令行时优先用它，它会自动装包 + 写 patch + 链接依赖）：

```bash
dsh plugin add /path/to/dsh-channel-hub   # 本地目录
dsh plugin add dsh-channel-hub            # 已发布到 npm
dsh plugin add github:you/dsh-channel-hub # GitHub
```

**脚本方式**（没有 `dsh` 命令行、或桌面版直接给了文件夹时）：

```bash
# 在插件目录里执行（Node 22.13+）
node bin/install.mjs
```

它会做三件事（幂等，可以重复跑）：

- 把插件复制进 `~/.dsh/profiles/desktop/node_modules/dsh-channel-hub`
- 往 `~/.dsh/profiles/desktop/cordis.patch.yml` 插一行（已存在就跳过）
- 生成配置模板 `~/.dsh/channel-hub/config.json`

> 两条路线**只用选一条**，都跑会重复插行（patch 里有 `disabled` 守卫，但没必要）。

### 4. 打开控制台，三步点完

重启一次 DSH（让插件加载），然后：

```bash
node bin/cli.mjs ui
```

它会用 Edge/Chrome 的「应用窗口」模式打开（没有地址栏和标签页，像一个独立的小浮窗），
地址是 `http://127.0.0.1:17867/?token=...`。三步点完就通了：

| 步骤 | 你做什么 | 页面做什么 |
|---|---|---|
| 1 填凭证 | 粘 App ID / App Secret，点「验证并保存」 | 真的去飞书换一次 `tenant_access_token`，凭证错了当场告诉你错在哪；顺手把机器人名字取回来显示 |
| 2 连上飞书 | 点「连接」 | 起 WebSocket 长连接，状态从「连接中」变「已连接」；断开重连也在这里看 |
| 3 授权自己 | 在飞书里给机器人随便发一句话，回到页面点「允许」 | 页面自动列出"谁来找过你"，点一下就把 peer 写进白名单，**立即生效** |

全程**不用重启第二次、不用手改 JSON**。想手改也行 —— 页面改的就是同一个 `config.json`。

> 页面只监听 `127.0.0.1`，所有 `/api/*` 都要 token（内联在页面里，也打印在日志），
> 带 `Origin` 的跨站请求一律拒绝。它是本机管理面，不是一个公网服务。

### 5. 之后

再发一句话就开始干活了。日常想改配置、看状态、放行新设备，都进这个页面。
命令行也还在：`node bin/cli.mjs doctor`（体检）/ `allow <peer>` / `config`。

---

## 配置项

配置文件：`~/.dsh/channel-hub/config.json`。优先级 **环境变量 > config.json > cordis.patch.yml**。
（控制台页面写的就是这个文件，两者等价。）

| 键 | 默认 | 说明 |
|---|---|---|
| `admin.enabled` | `true` | 是否起本地控制台 |
| `admin.port` | `17867` | 控制台端口（只监听 127.0.0.1） |

| 键 | 默认 | 说明 |
|---|---|---|
| `adapters.feishu.enabled` | `false` | 打开飞书通道 |
| `adapters.feishu.appId` / `appSecret` | — | 飞书应用凭证（建议只放这里，别写进 yml） |
| `adapters.feishu.mode` | `"ws"` | `ws` 长连接（推荐，无需公网）/ `webhook` 回调 |
| `adapters.feishu.port` / `host` / `path` | `17866` / `127.0.0.1` / `/feishu/event` | 仅 webhook 模式 |
| `adapters.feishu.allowedChatTypes` | `["p2p","group"]` | 允许的会话类型 |
| `adapters.feishu.groupMentionOnly` | `true` | 群聊里只在被 @ 或提到"助手/机器人"时才理 |
| `adapters.feishu.mediaMaxBytes` | `20971520` | 单个图片/语音/文件下载上限，超了就跳过并说明 |
| `security.allowPeers` | `[]` | 允许的聊天窗口，`feishu:oc_xxx`。**空 = 谁都不回** |
| `security.allowAll` | `false` | 放开所有人（不建议在群聊里开） |
| `agent.cwd` | 进程 cwd | agent 的工作目录（会话创建后不可变，换目录请 `/new`） |
| `agent.provider` / `model` | 宿主默认 | 给这个通道单独指定模型 |
| `behavior.progressCards` | `true` | 用"会长的卡片"代替连发消息 |
| `behavior.progressAfterMs` | `25000` | 多久没结果就更新一次进度 |
| `behavior.maxTurnMs` | `1800000` | 单轮上限（30 分钟），超时交回已有文本 |
| `behavior.allowApprovalCards` | `true` | 是否在聊天里应答审批 |
| `behavior.allowQuestions` | `true` | 是否在聊天里应答提问 |
| `behavior.dismissGuiCard` | `true` | 聊天里答完后收起网页上的卡（依赖一个未文档化细节，可关） |
| `behavior.cardTimeoutMs` | `1800000` | 卡片软超时（只摘卡，不裁决） |
| `behavior.journal` | `true` | 收发原文按天写 `journal/` |
| `behavior.media.images` | `true` | 是否把图片转给 agent |
| `behavior.media.files` | `true` | 是否把文件转给 agent |
| `behavior.media.audio` | `true` | 是否处理语音（转写或存附件） |
| `behavior.media.imageMaxBytes` | `10485760` | 单张图片本地硬闸（比宿主限制更早拦一层） |

环境变量：`DSH_HUB_FEISHU_APP_ID`、`DSH_HUB_FEISHU_APP_SECRET`、`DSH_HUB_FEISHU_MODE`、`DSH_HUB_CWD`、`DSH_HUB_ALLOW_ALL=1`、`DSH_HUB_STATE_DIR`。

---

## 聊天里能用的命令

| 命令 | 作用 |
|---|---|
| `/id` | 显示当前窗口的 peer id（配白名单用） |
| `/new` | 开新会话（旧会话保留，不删除） |
| `/status` | 会话、待处理卡片、出站队列、通道状态 |
| `/stop` | 中断正在执行的那一轮 |
| `/approve` / `/deny` | 处理审批卡；只有一张卡时 ID 可省略 |
| `/help` | 命令表 |

除命令外的任何文字都会交给 agent。

---

## 数据放在哪

```
~/.dsh/channel-hub/
├── config.json            凭证与开关（0600）
├── sessions.json          peer → 会话映射（不含消息内容）
├── outbox.json            发送失败的待重试消息
├── logs/hub-YYYY-MM-DD.log
└── journal/journal-YYYY-MM-DD.jsonl   收发原文（可关）
```

删掉 `sessions.json` 不会删除 DSH 里的会话，只是下次会重新开一个。

---

## 排障

**先跑体检：**

```bash
node bin/cli.mjs doctor
```

九项检查：Node 版本、配置文件、适配器开关、凭证、连接模式、白名单、SDK 可加载、状态目录可写。退出码非 0 才是有问题。

**常见五种"机器人不理我"：**

| 现象 | 原因 | 处理 |
|---|---|---|
| 发消息毫无反应，日志也没有行 | 插件没加载 | 看 `~/.dsh/profiles/desktop/cordis.patch.yml` 里有没有 `dsh-channel-hub`；重跑 `node bin/install.mjs` |
| 打不开控制台 | DSH 没运行，或端口被占 | `node bin/cli.mjs ui` 会先说清楚；端口冲突改 `admin.port` |
| 页面显示"连接失败" | 应用没发布 / 订阅方式选错 / 凭证不对 | 页面会把飞书返回的原因原样贴出来（例如 `code 10014`） |
| 日志有"拒绝未授权的会话" | 白名单没有这个窗口 | 控制台第 3 步点「允许」，或 `node bin/cli.mjs allow feishu:oc_xxx` |
| 收到消息但没回复 | agent 卡在工具里，或模型报错 | `/status` 看是否"正在执行"，`/stop` 中断；日志里搜 `回合执行失败` |

**日志里搜什么：** `dsh-channel-hub:` 前缀；`已订阅 session/event`（出站通路装上了）；`会话就绪`（会话建好了）；`出站发送失败`（网络/频控）。

---

## 已知边界

- **个人微信不做。** 个人微信没有官方机器人通道，现有方案依赖逆向协议（iLink/ClawBot），协议随时可能变、账号有封禁风险。要"微信"，正确路径是**企业微信自建应用**（有官方 API、需要企业资质）。内核已经平台无关，加一个 `adapters/wecom.js` 就能接上；这是 roadmap，不是做不到。
- **媒体覆盖到"能用"，不是"全支持"。** 图片（png/jpg/gif/webp）、语音（ogg/opus）、文件（任意类型，按附件转交）都通了；**表情包、合并转发消息、卡片里的资源**飞书接口本身就不给下载，会回一句说明。视频按"文件"转交，能不能看交给模型。
- **语音转写取决于宿主。** DSH 的 `speechToText` 是实验性可选服务，桌面版默认 profile 里**没有**；没挂的时候就退回"音频附件 + 文字说明"（agent 知道这是语音，读不了会让你改发文字）。想开就装 `@deepseek-ai/dsh-experimental-voice-input-bundle`（带本地 sensevoice），插件会自动用上。
- **一个窗口一个会话。** 同一窗口的消息严格串行 —— 连发三条会排队，而不是并发三轮（并发会让回复错位）。队列上限 8 条，超了会明确告诉你。
- **`dismissGuiCard` 依赖未文档化细节。** 它就地替换 `req.signal` 来撤掉网页卡片；DSH 升级后需要回归验证「聊天里答了，网页卡会不会收」。不想承担这个风险就设 `false`（代价是网页上会留一张待处理卡）。
- **群聊默认谨慎。** `groupMentionOnly: true`：群里没被点到就不理，避免机器人在群里自言自语。

---

## 开发

```bash
npm install            # 只依赖 @larksuiteoapi/node-sdk
npm test               # 79 个用例，全部离线（假宿主 + 内存通道 + 本地控制台）
node bin/demo.mjs      # 看一遍完整链路：消息 → 进度卡 → 权限 → 答案
```

测试里没有 true integration test（不会拉起真实 DSH），但 `test/fake-host.js` 按宿主源码实现了被用到的契约：`ctx.on('session/event')`、`approval/request` 的 waterfall 语义、`agents.create/resume/get`、`followup` 的丢弃行为。宿主形状变了，这些测试会先红。

目录：

```
src/index.js       装配 + 入站主干（白名单 → 去重 → 命令 → 卡片 → agent）
src/admin.js       本地控制台：HTTP 路由、token/Origin 校验、SSE、凭证验真
src/admin.html     控制台页面（零构建，原生 JS，三步向导）
src/bridge.js      DSH 会话桥：attach / followup / 从 session/event 取回复
src/cards.js       审批与提问的应答方（waterfall + 竞速 + 软超时）
src/router.js      peer → 会话映射，确定性 session id，`/new` 换代次
src/queue.js       同一窗口串行队列
src/outbox.js      出站重试（磁盘队列）
src/media.js       图片/语音/文件 → durable 附件
src/format.js      分段、卡片构造、纯文本降级
src/adapters/      feishu.js（长连接/webhook）、mock.js（测试与演示）
```

---

## 参考项目

- [wangx-wx/dsh-channel-wechat](https://github.com/wangx-wx/dsh-channel-wechat) —— 微信 iLink 通道，工程化程度很高；它的 `docs/recon/` 是对 DSH 接入面最好的公开勘察，本项目的会话桥与审批卡设计大量参考了它的事实结论。
- [panqing0313/dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin) —— 另一个微信通道实现，胜在功能密度（语音、贴纸、记忆、主动开口）。

两者都是**微信**方向；本项目选**飞书**，是因为个人微信没有官方机器人 API，而飞书的长连接让"本机 DSH + 手机聊天"这件事零门槛成立。

## License

MIT
