# 发给别人用 / 发布

这份文档只讲"怎么让第二个人装上它"，以及发布前必须做和绝不能做的事。

---

## 一、别人怎么装（三条路，从简单到正式）

### 路线 A：拿到文件夹直接装（最快，适合私下分享）

对方拿到 `dsh-channel-hub` 整个目录（含 `node_modules`），在目录里执行：

```bash
npm install          # 如果没带 node_modules
node bin/install.mjs # 复制进 profile + 插 patch 行
```

然后重启 DSH，`node bin/cli.mjs ui` 打开控制台，填 App ID / Secret。

**注意**：这条路线要求对方也有 Node 22.13+，且 profile 在默认位置
（`~/.dsh/profiles/desktop`）；不在默认位置用 `--profile <dir>`。

### 路线 B：`dsh plugin add`（官方推荐）

```bash
dsh plugin add /path/to/dsh-channel-hub     # 本地目录
dsh plugin add dsh-channel-hub              # 已发布到 npm
dsh plugin add github:you/dsh-channel-hub   # GitHub
```

用这条路线时**不要**再跑 `install.mjs` —— `dsh plugin add` 已经做了
"装包 + 写 patch + pnpm 链接"三件事，两个都跑会重复插行（虽然 patch 里有
`disabled` 守卫，但没必要）。

装完同样需要重启 DSH。

### 顺带装技能（可选但强烈建议）

`install.mjs` 会把 `skills/feishu-channel/SKILL.md` 复制到 `~/.dsh/skills/`，
这样**换任何工作区**，agent 都认得"连接飞书"这个请求（DSH 的技能搜索路径：
`<项目>/.dsh/skills` → `~/.dsh/skills` → …，用户级 rank 400）。

用 `dsh plugin add` 装的不会自动带技能，手动拷一次即可：

```bash
mkdir -p ~/.dsh/skills/feishu-channel
cp skills/feishu-channel/SKILL.md ~/.dsh/skills/feishu-channel/
```

### 路线 C：发到插件市场

DSH 的插件市场读的是一个静态索引：

```
https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
```

要上架：把包发布到 npm → 向 [dsh-plugin-catalog](https://github.com/)（或对应的
市场索引仓库）提 PR，在 `index.json` 里加一条：

```json
{
  "name": "dsh-channel-hub",
  "description": "把飞书变成 DSH 的远程控制台（长连接，无需公网 IP）",
  "version": "0.2.0",
  "keywords": ["feishu", "lark", "channel"],
  "icon": "https://.../icon.png"
}
```

具体字段以该索引仓库的 README 为准 —— 索引格式会变，别照抄。

---

## 二、发布前检查清单

```bash
npm test                # 96 个用例必须全绿
npm pack --dry-run      # 看包里到底有什么（下面有预期清单）
```

**包内应该只有**：

```
package.json  cordis.patch.yml  README.md  CHANGELOG.md  LICENSE
src/  bin/  docs/  skills/
```

**绝对不该进包**：

| 东西 | 为什么 | 怎么保证 |
|---|---|---|
| `~/.dsh/channel-hub/config.json` | 里面有 App Secret | 它本来就在状态目录，不在仓库里 |
| `node_modules/` | 体积 + 平台相关原生模块 | `files` 白名单里没有它 |
| `test/` | 不影响运行，但会让包变大 | `files` 里没有 |
| 任何 `.log` / `.tgz` / `.env` | 可能带密钥 | `.gitignore` + `files` |

发布前再扫一遍：

```bash
grep -rniE "cli_[a-z0-9]{12,}|appSecret\"?\s*[:=]\s*\"[^\"]{10,}" \
  --include="*.js" --include="*.json" --include="*.md" . | grep -v node_modules
```

（应该只命中 `cli_xxxxxxxxxxxx` 这种占位符。）

---

## 三、发布到 npm

```bash
# 1. 改 package.json：version、repository、homepage、bugs
#    这几项现在是空的/占位的，发布前必须换成你自己的仓库地址

# 2. 登录（一次性）
npm login

# 3. 打包看看
npm pack --dry-run

# 4. 发
npm publish --access public
```

**版本号规则**：修 bug 打 patch，加适配器/加能力打 minor，改配置格式或内核行为打 major。

发布之后别人就能：

```bash
dsh plugin add dsh-channel-hub
```

---

## 四、发布到 GitHub

```bash
git init
git add .
git commit -m "feat: 飞书通道 0.2.0"
git remote add origin git@github.com:<you>/dsh-channel-hub.git
git push -u origin main
```

建议同时打 tag：`git tag v0.2.0 && git push --tags`，这样别人可以
`dsh plugin add github:you/dsh-channel-hub#v0.2.0`。

**仓库里必须有的**：`README.md`（用户向）、`docs/quickstart.md`（照着做）、
`docs/architecture.md`（改代码的人向）、`CHANGELOG.md`、`LICENSE`。

---

## 五、怎么跟别人交代清楚（照抄即可）

> 这是一个 DeepSeek Harness 插件，把飞书变成你电脑上 agent 的遥控器。
>
> 1. 装：`dsh plugin add dsh-channel-hub`（或解压后 `node bin/install.mjs`），然后重启 DSH
> 2. 建飞书应用：`open.feishu.cn/app` → 企业自建应用 → 加机器人 → 开 `im:message` /
>    `im:message:send_as_bot` / `im:resource` / `im:message.p2p_msg` → 事件订阅选
>    **长连接** 并加 `im.message.receive_v1` → 发布版本
> 3. 配：`node bin/cli.mjs ui`，填 App ID / Secret，点连接
> 4. 授权：飞书里发一句话，控制台第 3 步点「允许」
>
> 不需要公网 IP、不需要内网穿透。App Secret 只存在你本机 `~/.dsh/channel-hub/config.json`（0600）。

三个最容易卡住的点，提前说：

1. **私聊不通** → 少了 `im:message.p2p_msg` 权限（群聊 @ 那条不够）
2. **改了权限没反应** → 权限必须**重新发布版本**才生效
3. **连接正常但零事件** → 长连接是在"应用发布前"建立的，`disconnect` + `connect` 一次

---

## 六、给别人用之前，想清楚这三件事

1. **它能执行任意命令**。拿到白名单的人等于拿到你电脑的 shell（在沙箱内）。
   默认白名单为空是刻意的，别为了省事开 `allowAll`。
2. **一个飞书应用只能稳定对应一个通道实例**。两个人各用各的应用，不要共用
   App ID —— 长连接会互相抢事件。
3. **别把 `~/.dsh/channel-hub/` 整个目录发给别人**（里面是你的 App Secret、会话映射、
   收发原文日志）。
