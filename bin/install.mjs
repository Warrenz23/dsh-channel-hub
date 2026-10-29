#!/usr/bin/env node
/**
 * 把插件装进一个 DSH profile。
 *
 * 为什么要有这个脚本：桌面版 DSH 的 profile 不一定有 `dsh` 命令行可用，
 * 而手改 `cordis.patch.yml` + 手工建 node_modules 又是最容易出错的一步。
 * 这个脚本把两件事做掉：**放包** 和 **插行**，并且默认是幂等的。
 *
 *   node bin/install.mjs                       # 装进 ~/.dsh/profiles/desktop
 *   node bin/install.mjs --profile <dir>       # 指定 profile
 *   node bin/install.mjs --dry-run             # 只打印要做什么
 *   node bin/install.mjs --uninstall           # 撤销（只删我们自己的文件）
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const uninstall = args.includes('--uninstall')
const profileArg = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : undefined

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = resolve(profileArg ?? process.env.DSH_PROFILE_DIR ?? join(dshHome, 'profiles', 'desktop'))
const target = join(profileDir, 'node_modules', 'dsh-channel-hub')
const patchFile = join(profileDir, 'cordis.patch.yml')
const stateDir = process.env.DSH_HUB_STATE_DIR ?? join(dshHome, 'channel-hub')

const PATCH_BLOCK = `
# ── dsh-channel-hub（由 bin/install.mjs 写入；重复执行不会重复插入）──────────
- insert:
    - id: dsh-channel-hub
      name: 'dsh-channel-hub'
      config:
        adapters:
          feishu:
            enabled: false # 填好 ~/.dsh/channel-hub/config.json 后改成 true
            mode: ws
          mock:
            enabled: false
        security:
          allowPeers: []
          allowAll: false
      disabled: !!js "Boolean(ctx.loader && [...ctx.loader.entries()].some((e) => e.options.name === 'dsh-channel-hub' && e.options.id !== 'dsh-channel-hub' && !e.disabled))"
`

function say(line) {
  console.log(line)
}

function fail(message) {
  console.error(`\u001b[31m✖ ${message}\u001b[0m`)
  process.exitCode = 1
}

if (!existsSync(profileDir)) {
  fail(`找不到 profile 目录：${profileDir}`)
  say('  用 --profile 指定，或先启动一次 DSH 桌面版让它生成 profile。')
  process.exit(1)
}
if (!existsSync(join(profileDir, 'package.json'))) {
  fail(`${profileDir} 不像一个 DSH profile（缺 package.json）`)
  process.exit(1)
}

if (uninstall) {
  if (dryRun) {
    say(`[dry-run] 会删除 ${target}，并从 ${patchFile} 移除插件行`)
  } else {
    rmSync(target, { recursive: true, force: true })
    if (existsSync(patchFile)) {
      const text = readFileSync(patchFile, 'utf8')
      const cleaned = text.replace(/\n# ── dsh-channel-hub[\s\S]*?(?=\n- insert:|\s*$)/, '\n')
      writeFileSync(patchFile, cleaned)
    }
    say('\u001b[32m✔ 已卸载\u001b[0m（状态目录保留：' + stateDir + '）')
  }
  process.exit(0)
}

say(`插件源：${here}`)
say(`目标：  ${target}`)
say(`profile：${profileDir}`)

if (dryRun) {
  say('\n[dry-run] 会复制：package.json cordis.patch.yml README.md src/ bin/ docs/ node_modules/')
  say(`[dry-run] 会写入 patch 行到 ${patchFile}（若尚未存在）`)
  say(`[dry-run] 会生成配置模板 ${join(stateDir, 'config.json')}（若尚未存在）`)
  process.exit(0)
}

const skip = new Set(['.git', 'test', 'node_modules/.pnpm', 'node_modules/.bin', 'node_modules/.modules.yaml'])
/**
 * 复制插件本体。
 *
 * `dereference: true` 是把 pnpm 的硬链接/软链接拍平 —— profile 里的插件不该
 * 依赖开发者机器上的 store 路径。
 */
function copyTree(from, to, isRoot) {
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    force: true,
    filter: (source) => {
      const relative = source.slice(here.length).replace(/\\/g, '/').replace(/^\//, '')
      if (relative === '') return true
      if (isRoot && relative === 'node_modules') return true
      return !skip.has(relative)
    },
  })
}

mkdirSync(dirname(target), { recursive: true })
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const entry of ['package.json', 'cordis.patch.yml', 'README.md', 'src', 'bin', 'docs', 'LICENSE']) {
  if (!existsSync(join(here, entry))) continue
  copyTree(join(here, entry), join(target, entry), true)
}
if (existsSync(join(here, 'node_modules'))) {
  mkdirSync(join(target, 'node_modules'), { recursive: true })
  for (const entry of readdirNames(join(here, 'node_modules'))) {
    if (entry === '.pnpm' || entry === '.bin' || entry === '.modules.yaml') continue
    copyTree(join(here, 'node_modules', entry), join(target, 'node_modules', entry), true)
  }
}
say('\u001b[32m✔ 插件已复制\u001b[0m')

/**
 * 装技能：DSH 会在 `~/.dsh/skills/<name>/SKILL.md` 找用户级技能。
 *
 * 装了它，以后用户只要说"连接飞书"，agent 就会按技能里的步骤自己跑
 * （status → setup → connect → allow），不需要人肉点界面。
 */
const skillSrc = join(here, 'skills', 'feishu-channel')
const skillDst = join(dshHome, 'skills', 'feishu-channel')
if (existsSync(join(skillSrc, 'SKILL.md')) && !dryRun) {
  try {
    mkdirSync(skillDst, { recursive: true })
    cpSync(join(skillSrc, 'SKILL.md'), join(skillDst, 'SKILL.md'), { force: true })
    say(`\u001b[32m✔ 已安装技能 feishu-channel（${skillDst}）\u001b[0m`)
  } catch (error) {
    say(`\u001b[33m· 技能没装上（不影响运行）：${String(error)}`)
  }
}

/** 插行：已经存在就跳过（幂等）。 */
const patchText = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '# dsh profile patch\n'
if (patchText.includes("name: 'dsh-channel-hub'") || patchText.includes('name: "dsh-channel-hub"')) {
  say('\u001b[33m· patch 里已经有 dsh-channel-hub，跳过\u001b[0m')
} else {
  writeFileSync(patchFile, `${patchText.trimEnd()}\n${PATCH_BLOCK}`)
  say(`\u001b[32m✔ 已写入 ${patchFile}\u001b[0m`)
}

/** 配置模板：不覆盖已有文件。 */
const configFile = join(stateDir, 'config.json')
if (!existsSync(configFile)) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(configFile, `${JSON.stringify({
    adapters: {
      feishu: {
        enabled: false,
        appId: 'cli_xxxxxxxxxxxx',
        appSecret: '在这里填飞书应用的 App Secret',
        mode: 'ws',
      },
    },
    security: { allowPeers: [], allowAll: false },
    agent: { cwd: '' },
  }, null, 2)}\n`, { mode: 0o600 })
  say(`\u001b[32m✔ 已生成配置模板 ${configFile}\u001b[0m`)
} else {
  say(`\u001b[33m· 配置已存在，未覆盖：${configFile}\u001b[0m`)
}

say('\n下一步（全程在网页里点，不用改配置文件）：')
say('  1. 重启一次 DSH，让插件加载')
say('  2. 双击 bin\\open-ui.cmd（或 node bin/cli.mjs ui）打开控制台')
say('     （也可看日志里 "控制台：http://127.0.0.1:17867/?token=..." 那一行）')
say('  3. 页面第 1 步填 App ID / App Secret → 验证并保存（会真的去换一次 token）')
say('  4. 第 2 步点「连接」→ 状态变成"已连接"')
say('  5. 在飞书里给机器人发一句话 → 第 3 步会冒出你的会话 → 点「允许」')
say('')
say('完整清单：docs/quickstart.md')

function readdirNames(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
