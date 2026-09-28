const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { appendFileSync, existsSync } = require('node:fs')
const { resolve } = require('node:path')

const root = resolve(__dirname, '..')
const pkg = require('../package.json')
const plugin = require(root)

assert.equal(typeof plugin.apply, 'function', '插件入口必须导出 apply')
assert.equal(plugin.Config?.type, 'object', '插件入口必须导出配置 Schema')
assert.ok(plugin.Config.dict.cnb_repository, '配置必须包含目标仓库')
assert.ok(plugin.Config.dict.cnb_token, '配置必须包含访问令牌')
assert.ok(JSON.parse(JSON.stringify(plugin.Config)), '配置必须能够序列化')

if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`, '标签必须与 package.json 版本一致')
}

assert.ok(process.env.npm_execpath, '请通过 npm run pack:check 执行')
const result = JSON.parse(execFileSync(process.execPath, [
  process.env.npm_execpath, 'pack', '--json', '--ignore-scripts',
], { cwd: root, encoding: 'utf8' }))
assert.equal(result.length, 1, '必须只生成一个安装包')
const pack = result[0]
assert.equal(pack.name, pkg.name)
assert.equal(pack.version, pkg.version)
assert.ok(existsSync(resolve(root, pack.filename)), '安装包必须存在')

const files = new Set(pack.files.map(file => file.path))
for (const file of [pkg.main, pkg.types, 'package.json', 'README.md', 'LICENSE']) {
  assert.ok(files.has(file), `安装包缺少 ${file}`)
}
for (const file of files) {
  assert.ok(file.startsWith('lib/') || ['package.json', 'README.md', 'LICENSE'].includes(file),
    `安装包包含非发布文件 ${file}`)
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT,
    `tarball=${pack.filename}\ndist-tag=${pkg.version.includes('-') ? 'next' : 'latest'}\n`)
}
console.log(`已验证 ${pack.filename}：入口、配置 Schema 和 ${files.size} 个发布文件正常。`)
