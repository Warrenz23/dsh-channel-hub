# 开始使用（照着做，10 分钟）

> 目标：在飞书里给机器人发一句话，你电脑上的 DSH 就开始干活。

---

## 0. 先确认你有一个飞书「自建应用」

如果还没有，去 <https://open.feishu.cn/app> 建一个（个人也能注册免费团队）：

- [ ] 创建 **企业自建应用**
- [ ] 应用里 **添加应用能力 → 机器人**
- [ ] **凭证与基础信息** 抄下 `App ID`、`App Secret`
- [ ] **权限管理** 开通三个：
      `im:message`、`im:message:send_as_bot`、`im:resource`
- [ ] **事件与回调 → 订阅方式** 选 **使用长连接接收事件**
- [ ] **事件与回调 → 添加事件**：`im.message.receive_v1`
- [ ] **事件与回调 → 回调订阅**：`card.action.trigger`
- [ ] **版本管理与发布** → 创建版本 → 申请发布（管理员审核通过后生效）

> 长连接不需要公网地址、不需要备案。这是整套方案的前提。

---

## 1. 重启一次 DSH

插件已经装好了，但正在运行的 DSH 是在安装之前启动的，**必须重启才会加载**。

- 完全退出 DeepSeek Harness（托盘图标也要退），然后重新打开。

判断有没有加载成功：看这个文件里有没有 `控制台：http://127.0.0.1:17867/?token=...`

```
C:\Users\<你>\.dsh\channel-hub\logs\hub-YYYY-MM-DD.log
```

有 → 继续第 2 步。没有 → 见文末「卡住了怎么办」。

---

## 2. 打开控制台

双击：

```
<插件目录>\bin\open-ui.cmd
```

会弹出一个没有地址栏的小窗口（Edge/Chrome 的应用窗口模式）。
（也可以命令行 `node bin/cli.mjs ui`；它自动从日志里取 token。）

---

## 3. 在页面里三步点完

- [ ] **① 填应用凭证**：粘 `App ID` / `App Secret` → 「验证并保存」
      → 页面会真的去飞书换一次 token；凭证错了当场报错（例如 `code 10014`）
- [ ] **② 连上飞书**：点「连接」→ 顶部状态从「连接中」变「已连接」
- [ ] **③ 授权你的聊天窗口**：先在飞书里给机器人**随便发一句话**
      → 页面第 3 步会自动出现 `feishu:oc_...` → 点「允许」

---

## 4. 试一句真话

在飞书里发一句有实际内容的，比如：

```
帮我看下 <你的工作区> 里有什么
```

- 先出一张「已收到，正在处理…」的卡片
- 这张卡会原地长大，变成最终答案
- 期间如果 agent 要权限，会推一张带按钮的审批卡，点「仅这次允许」

也可以直接发命令：`/help` `/status` `/new` `/stop` `/id`。

---

## 卡住了怎么办

| 现象 | 先看这里 |
|---|---|
| 日志里没有 `控制台：` | 插件没加载。看 `C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml` 里有没有 `dsh-channel-hub`；再跑一次 `node bin/install.mjs` |
| `open-ui.cmd` 说端口没响应 | DSH 没在运行，或插件没加载上；先完成第 1 步 |
| 页面说「连接失败」 | 应用没发布 / 订阅方式选错 / 凭证不对，页面会把飞书的原因原样贴出来 |
| 飞书里发消息机器人不理 | 页面第 3 步看有没有出现你的会话；没有出现说明事件没进来（回调订阅 / 长连接没开） |
| 出现了会话但显示「待允许」 | 点「允许」（等价于把它写进 `security.allowPeers`） |

体检命令（不需要 DSH 在跑）：

```
node bin/cli.mjs doctor
```

它会把九项检查一次说完：Node 版本、配置、凭证、白名单、SDK、控制台、日志目录。

---

## 文件都在哪

| 用途 | 路径 |
|---|---|
| 插件本体（DSH 加载的那份） | `C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-channel-hub` |
| 配置（页面改的就是它） | `C:\Users\<你>\.dsh\channel-hub\config.json` |
| 日志 | `C:\Users\<你>\.dsh\channel-hub\logs\hub-YYYY-MM-DD.log` |
| 会话映射 / 出站队列 | `C:\Users\<你>\.dsh\channel-hub\sessions.json`、`outbox.json` |
| 源码（你要改的话） | `<插件目录>` |

改源码之后要重新装一次：`node bin/install.mjs`，然后重启 DSH。
想彻底撤掉：`node bin/install.mjs --uninstall`。
