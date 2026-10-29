# 变更记录

## 0.2.0 — 2026-10-30

**首个可用版本**：飞书长连接打通，含可视化配置。

### 新增

- **可视化控制台**（`src/admin.js` + `src/admin.html`，`0.0.0.0` 之外只监听 `127.0.0.1`）
  - 三步向导：填凭证（真去换 token 验真）→ 连接 → 放行会话
  - 热连接：改凭证/改白名单**不用重启 DSH**
  - 状态与日志内嵌；SSE 实时刷新
  - token 落盘（`admin-token`），重启后地址不变
  - 鉴权：`x-hub-token` + 同源 `Origin` 校验；跨站请求一律 401
- **图片 / 语音 / 文件入站**（`src/media.js`）
  - 图片过 `attachments.admitPromptContent()` 变成 durable 附件
  - 语音：有 `speechToText` 就转写；没有就存成附件 + 明确告知 agent
  - 三条降级路径都有用户可见的说明，不丢消息
- **审批卡 / 提问卡**（`src/cards.js`）
  - `approval/request` + `user-questions/request` 双 waterfall，`prepend: true`
  - 与网页端竞速：谁先答谁生效；网页先答时回执"已在其他端处理"
  - 软超时只摘卡、不替用户裁决
  - 卡片按钮走 `card.action.trigger` 回调
- **会话与出站**
  - 确定性 session id（`hub-<hash>-g<代次>`），重启后 resume 回同一会话
  - `/new` 只加代次，不删会话
  - 同窗口严格串行队列；出站失败进磁盘队列指数退避
  - 一条"会长大"的进度卡：进度、中间状态、最终答案落在同一张卡上
- **CLI**（`bin/cli.mjs`）
  - 人用：`ui` / `doctor` / `init` / `config` / `allow`
  - 脚本与 agent 用：`status --json` / `setup` / `connect` / `disconnect`
- **诊断工具** `bin/sniff.mjs`：原始事件嗅探，区分"飞书没推"和"推了没接住"
- **技能** `skills/feishu-channel/SKILL.md`：装/配/排障的操作手册

### 修复

- `start()` 里把 `startWs()`/`startWebhook()` 当局部函数调用 → `ReferenceError`（适配器对象方法必须经 `adapter.` 调）
- 配置不全时 `hub.start()` 不执行，导致 `session/event` 未订阅 —— 控制台现场补配置后回合永远等不到回复。拆成 `startCore()`（幂等）与 `startAdapters()`
- 长连接模式未把 `encryptKey` 传给 `EventDispatcher`，应用开加密策略时静默收不到事件
- 分段回复的后续段落当纯文本发送，暴露 `**markdown**` 星号
- 飞书卡片 markdown 不支持 `#` 标题与表格 → 适配器层做方言转换（标题转粗体、表格转列表），并跳过代码块
- 控制台 token 每次重启变化 → 落盘固定

### 已知边界

- 个人微信不做（无官方机器人 API）；企业微信适配器未实现
- 表情包 / 合并转发消息 / 卡片内资源：飞书接口本身不提供下载
- 语音转写依赖 DSH 实验性 `speechToText` 服务，桌面版默认未挂载

## 0.1.0 — 2026-10-30

- 项目初始化：内核（路由 / 队列 / 桥 / 出站）+ 飞书适配器骨架 + 假宿主测试
