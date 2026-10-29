/**
 * 把本仓库推到 GitHub（不需要安装 git）。
 *
 * 用途：这台机器没有 git / gh，用 GitHub REST API 直接建仓库、传文件、建提交。
 *
 *   set GH_TOKEN=ghp_xxx        # 需要 repo 权限，用完立刻 revoke
 *   node scripts/publish.mjs    # 重复执行 = 在 main 之上追加一个提交
 *
 * 环境变量：
 *   GH_TOKEN       必填
 *   REPO_NAME      仓库名（默认取 package.json 的 name）
 *   REPO_PRIVATE   设为 1 则建私有仓库
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const token = process.env.GH_TOKEN
if (!token) {
  console.error('缺少 GH_TOKEN')
  process.exit(1)
}
const root = process.argv[2] ?? process.cwd()
const repoName = process.env.REPO_NAME ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
const isPrivate = process.env.REPO_PRIVATE === '1'
const API = 'https://api.github.com'

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'dsh-channel-hub-publisher',
      'x-github-api-version': '2022-11-28',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  const data = text === '' ? {} : JSON.parse(text)
  if (!response.ok) {
    const error = new Error(`${method} ${path} → ${response.status} ${data.message ?? ''}`)
    error.status = response.status
    error.data = data
    throw error
  }
  return data
}

const skip = new Set(['node_modules', '.git', '.tgz'])
function collect(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry) || entry.endsWith('.tgz') || entry.endsWith('.zip')) continue
    const full = join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) out.push(...collect(full, base))
    else out.push({ path: relative(base, full).split(sep).join('/'), full, size: info.size })
  }
  return out
}

const user = await api('/user')
console.log(`账号：${user.login}`)

// 先把仓库地址写进 package.json，再上传（否则推上去的元数据还是空的）
const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.repository = { type: 'git', url: `git+https://github.com/${user.login}/${repoName}.git` }
pkg.homepage = `https://github.com/${user.login}/${repoName}#readme`
pkg.bugs = { url: `https://github.com/${user.login}/${repoName}/issues` }
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
console.log(`package.json → ${pkg.homepage}`)

let repo
try {
  repo = await api('/user/repos', {
    method: 'POST',
    body: {
      name: repoName,
      description: '把飞书（Lark）变成 DeepSeek Harness 的远程控制台：长连接接入，无需公网 IP；带可视化配置页、审批卡、图片/语音。',
      homepage: pkg.homepage,
      private: isPrivate,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    },
  })
  console.log(`仓库已创建：${repo.html_url}`)
  await api(`/repos/${user.login}/${repoName}/topics`, {
    method: 'PUT',
    body: { names: ['deepseek-harness', 'dsh', 'dsh-plugin', 'feishu', 'lark', 'chatbot', 'channel'] },
  }).catch(() => {})
} catch (error) {
  if (error.status !== 422) throw error
  repo = await api(`/repos/${user.login}/${repoName}`)
  console.log(`仓库已存在，复用：${repo.html_url}`)
}

const files = collect(root)
console.log(`文件数：${files.length}，总计 ${Math.round(files.reduce((n, f) => n + f.size, 0) / 1024)} KB`)

/**
 * 新仓库是"空 git 仓库"，`POST /git/blobs` 会直接 409（Git Repository is empty）。
 * 先用 Contents API 种一个初始提交，后续的 blob/tree/commit 才有父节点可用。
 */
let parentSha
try {
  const ref = await api(`/repos/${user.login}/${repoName}/git/ref/heads/main`)
  parentSha = ref.object.sha
  console.log(`已有分支 main（${parentSha.slice(0, 7)}），在其之上提交`)
} catch (error) {
  if (error.status !== 404 && error.status !== 409) throw error
  const seed = await api(`/repos/${user.login}/${repoName}/contents/.seed`, {
    method: 'PUT',
    body: { message: 'chore: 初始化仓库', content: Buffer.from('init\n').toString('base64') },
  })
  parentSha = seed.commit.sha
  console.log(`空仓库：已种下初始提交（${parentSha.slice(0, 7)}）`)
}

const tree = []
for (const file of files) {
  const content = readFileSync(file.full).toString('base64')
  const blob = await api(`/repos/${user.login}/${repoName}/git/blobs`, {
    method: 'POST',
    body: { content, encoding: 'base64' },
  })
  tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha })
}
console.log(`blob 上传完成：${tree.length}`)

const newTree = await api(`/repos/${user.login}/${repoName}/git/trees`, {
  method: 'POST',
  body: { tree },
})

const commit = await api(`/repos/${user.login}/${repoName}/git/commits`, {
  method: 'POST',
  body: {
    message: [
      'feat: 飞书通道 0.2.0',
      '',
      '- 长连接接入飞书，无需公网 IP；可视化控制台三步完成配置',
      '- 审批卡/提问卡（waterfall + 竞速 + 软超时），卡片按钮走回调',
      '- 图片/语音/文件入站（attachments 准入 + 语音降级）',
      '- 确定性会话 id、同窗口串行队列、出站重试',
      '- CLI：status/setup/connect/disconnect（--json + 退出码）',
      '- 96 个离线用例；bin/sniff.mjs 事件嗅探；DSH 技能 feishu-channel',
    ].join('\n'),
    tree: newTree.sha,
    parents: [parentSha],
  },
})

try {
  await api(`/repos/${user.login}/${repoName}/git/refs`, {
    method: 'POST',
    body: { ref: 'refs/heads/main', sha: commit.sha },
  })
} catch (error) {
  if (error.status !== 422) throw error
  await api(`/repos/${user.login}/${repoName}/git/refs/heads/main`, {
    method: 'PATCH',
    body: { sha: commit.sha, force: false },
  })
}

const check = await api(`/repos/${user.login}/${repoName}/git/trees/main?recursive=1`)
console.log(`\n远端文件数：${check.tree.filter((item) => item.type === 'blob').length}`)
console.log(`仓库地址：${repo.html_url}`)
console.log(`提交：${commit.sha.slice(0, 7)}`)
