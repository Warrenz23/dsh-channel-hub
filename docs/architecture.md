# 架构与不变量

这份文档写给要改这个插件的人（包括三个月后的我）。它只讲**为什么这么写**和**改哪里会炸**，不讲怎么用。

## 一句话结构

```
适配器（feishu / mock）          只做收发：sendText / sendCard / updateCard + 入站回调
        ↓ ↑
入站主干（src/index.js）         白名单 → 去重 → 命令 → 卡片应答 → 排队 → 一轮对话
        ↓ ↑
内核：router（映射） · queue（串行） · bridge（会话） · cards（审批） · outbox（重试）
        ↓ ↑
DSH：agents.create/resume · agent.followup · session/event · approval/request
```

适配器不知道 DSH 存在；内核不知道飞书存在。这条边界是唯一值得守住的东西。

## DSH 侧的真实契约（照源码确认，不是文档转述）

| 事 | 结论 |
|---|---|
| 入站 | 只有 `agent.followup(userMessage)`。`inject()` 不唤醒驱动，`steer()` 只在下一个 step 边界生效 |
| 出站 | **没有投递 seam**。唯一稳定来源是 durable 的 `session/event` 里的 `assistant/message`；逐字流是进程内的、跨重启会丢 |
| 回复区间 | `followup()` 不返回消息 id，`whenIdle()` 是 whole-agent 静默。所以必须**自建区间**：投递前记 seq 基线，只认基线之后新开的 `turn/start`，在属于它的 `turn/end` 收尾 |
| 存活性 | `agents.get(id) !== agent` 时 `followup()` **静默接受、消息丢失**。每次投递前必须校验 |
| resume | 会话不存在时 `resume()` **抛错**（不是返回 undefined），所以要有 create 兜底 |
| 审批 | `ctx.waterfall(scopeTarget(agent), 'approval/request', req, () => 'unavailable')`。应答方 = `ctx.on('approval/request', h, { prepend: true })`，**return** 一个 outcome 即裁决 |
| 审批 id | 请求方内部 `randomUUID()`，**应答方拿不到**。卡片 id 必须自己造 |
| 审批兜底 | 没有 answerer 时返回 `'unavailable'`；非法返回值被规范化成 `'unavailable'`；**没有任何内建超时** |
| 提问 | 同构：`ctx.on('user-questions/request', ...)`，返回 `{ answers: [{ id, selected, custom? }] }` |

## 为什么队列在 hub 层而不是 bridge 层

`followup()` 每调一次就开一轮。两轮并发时，`whenIdle()` 无法告诉你是哪一轮静默了 —— 回复会错位（第二个问题的答案被第一轮的等待收走）。IM 天然并发（用户连发），所以**同一 peer 必须串行**。放在 hub 层是因为：命令、卡片应答、普通消息共用同一个"这个窗口当前在干什么"的概念。

## 为什么 `deliver()` 要认 turn id

基线之后出现的第一个 `turn/end` 不一定是**我们的**那一轮：用户在网页端可能正跑着一轮。所以：

1. 基线 = 投递前最后一个事件 seq；
2. 只接受基线之后新出现的 `turn/start`（`sawOurTurn`）；
3. `turn/end` 必须匹配那个 turn（有 id 就比 id，没有就退化成"start 之后的第一个 end"）。

没有这层，UI 端的并发会让聊天里收到不属于自己的答案。

## 卡片：竞速、软超时、撤卡

```
approval/request
  ├─ 是我们的会话？ ── 否 ──→ next()（把卡让给网页）
  └─ 是
       ├─ 发 IM 卡片（自造 id，登记待办）
       ├─ fork(req.signal)            ← 让网页卡的寿命可被单独撤掉
       ├─ race( next() , IM 等待 )
       └─ 谁先答谁生效；IM 赢 → abort fork（撤网页卡）；网页赢 → 回执"已在其他端处理"
```

三个必须知道的点：

1. **`prepend: true` 是硬要求。** 不加，网页的应答者排前面，它不调 `next()` 就永远轮不到你，而且没有任何报错。
2. **下游返回 `'unavailable'` 不等于"网页答了"。** 没有交互终端时它立刻返回 `'unavailable'`。把它当成"没人会答"，继续等 IM；否则卡片发出去会被瞬间判成不可用。
3. **软超时只摘卡。** 超时把卡片从聊天里删除并提示，但**不 resolve** —— 网页端仍可处理，turn 也继续挂着。替用户做授权决定是越界。

`fork(req.signal)` 依赖"`req` 在 waterfall 内共享可变"这一未文档化细节，所以整体 try/catch、可配置关闭（`behavior.dismissGuiCard`）。**升级 DSH 后必须回归**：在聊天里答一张卡，看网页卡是否收起；按网页的 Stop，看聊天卡是否撤销。

## 会话 id：确定性，不是随机

```
sessionId = "hub-" + sha1(peerKey).slice(0,12) + "-g" + generation
```

- 重启/迁移状态文件后仍然落到同一个 DSH 会话（`resume` 接得上历史）；
- `/new` 只把 generation +1，旧会话留在 DSH 里 —— 误触不丢历史；
- 前缀 `hub-` 让它在 GUI 里一眼能认出来源。

**不要**改成随机 id：那会让"用户换了个网络重连"变成"机器人失忆"。

## 出站：一条卡片，两次机会

`progressCards` 打开时，一轮对话只发一条消息：

```
sendCard(进度卡) → PATCH(进度) → PATCH(最终答案)
```

PATCH 失败才降级成重新发送；分段时先复用进度卡承载第一段，其余按 text/card 顺序发。这样在手机上看到的是"一张卡从处理中变成答案"，而不是一串"正在处理…"。

## 失败姿态

| 场景 | 行为 |
|---|---|
| 配置不全 | 不启动适配器，逐条记 error 日志，**不抛到宿主** |
| 适配器启动失败 | 记 error，其它适配器照常启动 |
| 发送失败 | 进磁盘 outbox，指数退避最多 6 次，超限记 warn 丢弃 |
| 回合超时 | 交回已有文本 + 一句说明，不判死 |
| 回合报错 | 卡片标题变红，把宿主给的原因原样贴出来 |
| 插件卸载 | 排空队列（5s 上限）→ 关适配器 → 撤监听 → 关日志 |

一个 IM 插件最严重的故障是"让整个 DSH 起不来"或"静默不回"。两者都被上面这些兜住。

## 媒体：入站二进制怎么变成 prompt

DSH 的消息块只认 **durable 附件引用**，裸 base64 进不了消息。所以图片必须过
`ctx.attachments.admitPromptContent()`（输入 `{type:'image', mediaType, data: canonical base64}`，
输出 `{type:'image', attachment: ref}`），文件必须**先** `saveFile()` 拿到 ref 再当
`{type:'file', attachment}` 传。

`src/media.js` 是这个转换的唯一入口，三条降级路径都必须有话说：

| 情况 | 行为 |
|---|---|
| 宿主没挂 `attachments` | 图片丢弃 + 一句"宿主没有附件服务"，文字部分照常执行 |
| 图片超过本地硬闸 / 宿主拒收 | 丢掉图片 + 说明原因，**不丢整条消息** |
| 有 `speechToText` | 语音转写成文字，作为普通 text 块 |
| 没有 `speechToText` / 转写抛错 | 音频存成 file 块 + 一句"这是用户发来的语音，读不了请让用户改发文字" |

最后一个选择是刻意的：**不要假装听懂了**。宁可让 agent 知道"这里有一段语音但我读不了"，
也不要让用户以为自己的语音已经被理解。

平台侧还有一层闸：飞书的资源下载是独立接口（`im.v1.messageResource.get`，必须带 `type`
参数、需要 `im:resource` 权限），所以那边有 `mediaMaxBytes` 的流式截断，避免 90MB 的视频
把内存打满。

## 控制台：为什么是本地网页，不是 DSH 面板

"在 DSH 里加一个设置面板"要走客户端插件（需要构建浏览器 bundle、注入 client UI 包），
而且**装好的那一刻面板还不存在** —— 用户第一次打开时配置是全空的，这正是最需要界面的时刻。

所以控制台是插件自己在 `127.0.0.1:17867` 起的一个网页：零构建、页面同源、`bin/cli.mjs ui` 直接打开。
它只做四件事：**验证凭证 / 起停连接 / 放行会话 / 看状态与日志**。

本机服务也按公网服务的标准写：

| 风险 | 处理 |
|---|---|
| 别的网站对你的 localhost 发 POST（CSRF） | 带 `Origin` 的请求必须同源，否则 401 |
| 别的本机进程直接调 API | 所有 `/api/*` 要 `x-hub-token`（页面内联、日志里也打印一次） |
| 凭证泄露 | 接口只回打码值；`config.json` 以 0600 写 |
| 页面脚本注入 | 页面里不拼 HTML 字符串进 innerHTML 渲染用户数据（peerKey 走 textContent） |

### 一个真实踩到的坑：事件订阅必须早于"连接"

最初 `hub.start()` 把「订阅 `session/event`」和「启动适配器」绑在一起，而 `apply()` 在
配置不全时干脆不调 `start()`。于是控制台现场补齐配置、现场点连接之后，飞书那边消息
进得来、agent 也跑了，但**回合永远等不到 `turn/end`** —— 因为出站订阅压根没挂上。

现在拆成 `startCore()`（幂等：订阅事件 + 挂审批监听）和 `startAdapters()`：
核心无条件先接通，适配器等配置齐了再起。`test/apply.test.js` 里有专门守着这条的用例。

## 测试策略

`test/fake-host.js` 按宿主源码实现了被用到的契约（`session/event` 的 emit 形状、审批 waterfall 的 fail-closed 兜底、`agents.create/resume/get`、`followup` 的丢消息行为）。测试全部离线跑：

- `unit.test.js` —— 分段、卡片构造、路由、队列、配置合并
- `interactive.test.js` —— 审批/提问的七种路径（含 GUI 抢先、signal 中止、软超时）
- `bridge.test.js` —— 回合区间、错误收尾、cancel、存活校验
- `hub.test.js` —— 端到端：白名单、去重、命令、`/new`、按钮点卡、失败回执
- `apply.test.js` —— 真实插件入口 + 飞书消息解析

宿主形状变了，这些测试会先红 —— 这是它们存在的意义，不要为了让它们变绿去改断言。
