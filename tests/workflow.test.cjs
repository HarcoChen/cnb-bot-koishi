const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { apply } = require('../lib/index')
const { Session } = require('@satorijs/core')
const { CNBClient, CNBAPIError, CNBNetworkError, stageFile, filenameFromDisposition } = require('../lib/client')
const { ReportStore, scheduledAt } = require('../lib/storage')

function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (value && typeof value === 'object') {
      return Object.entries(value).every(([operator, expected]) => {
        if (operator === '$in') return expected.includes(row[key])
        if (operator === '$lt') return row[key] < expected
        if (operator === '$lte') return row[key] <= expected
        if (operator === '$gt') return row[key] > expected
        throw new Error(`Unsupported operator ${operator}`)
      })
    }
    return row[key] === value
  })
}
class Database {
  rows = []
  queries = []
  writes = []
  async get(_table, query, options = {}) {
    this.queries.push(query)
    let rows = this.rows.filter(row => matches(row, query))
    if (options.sort) {
      const [key, direction] = Object.entries(options.sort)[0]
      rows = [...rows].sort((a, b) => (a[key] - b[key]) * (direction === 'asc' ? 1 : -1))
    }
    if (options.limit) rows = rows.slice(0, options.limit)
    if (options.fields) rows = rows.map(row => Object.fromEntries(options.fields.map(key => [key, row[key]])))
    return structuredClone(rows)
  }
  async create(_table, row) { this.rows.push(structuredClone(row)) }
  async set(_table, query, row) {
    this.writes.push(structuredClone(row))
    const current = this.rows.find(row => matches(row, query))
    if (!current) return { matched: 0 }
    Object.assign(current, structuredClone(row))
    return { matched: 1 }
  }
  async remove(_table, query) { this.rows = this.rows.filter(row => !matches(row, query)) }
}

async function fixture(t, config = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cnb-workflow-'))
  const database = new Database()
  const hooks = {}
  let action
  const sent = []
  const deleted = []
  const ctx = {
    baseDir, database,
    model: { extend() {} },
    logger: () => ({ warn() {}, debug() {}, info() {} }),
    bots: [],
    command: () => ({ action(fn) { action = fn } }),
    on(event, fn) { hooks[event] = fn },
  }
  apply(ctx, { cnb_repository: 'group/repo', cnb_token: 'fake-token', ...config })
  const originals = {}
  for (const name of ['uploadAttachment', 'uploadCommentAttachment', 'createIssue', 'createComment', 'listComments', 'getIssue', 'closeIssue']) originals[name] = CNBClient.prototype[name]
  t.after(async () => {
    hooks.dispose()
    Object.assign(CNBClient.prototype, originals)
    await fs.rm(baseDir, { recursive: true, force: true })
  })
  const source = path.join(baseDir, 'source.log')
  await fs.writeFile(source, 'diagnostic log')
  const session = {
    platform: 'test', selfId: 'bot', userId: 'user', channelId: 'private', isDirect: true,
    bot: { async deleteMessage(channelId, messageId) { deleted.push({ channelId, messageId }) } },
    elements: [{ type: 'file', attrs: { name: 'source.log', url: pathToFileURL(source).href } }],
    async send(message) { sent.push(message); return [`message-${sent.length}`] },
  }
  ctx.bots.push({ platform: 'test', selfId: 'bot', async sendMessage(_channelId, message) { sent.push(message); return ['notification'] } })
  const calls = { uploads: [], issues: [], comments: [] }
  CNBClient.prototype.uploadAttachment = async function(file, name, size) {
    assert.equal((await fs.stat(file)).size, size)
    calls.uploads.push(file)
    return { asset_link: `[${name}](https://cnb.cool/asset/${calls.uploads.length})` }
  }
  CNBClient.prototype.uploadCommentAttachment = function(_issue, file, name, size) { return CNBClient.prototype.uploadAttachment.call(this, file, name, size) }
  CNBClient.prototype.createIssue = async function(title, body) {
    for (const file of calls.uploads) await assert.rejects(fs.stat(file), { code: 'ENOENT' })
    calls.issues.push({ title, body })
    return { number: 42 }
  }
  CNBClient.prototype.createComment = async function(number, body) {
    for (const file of calls.uploads) await assert.rejects(fs.stat(file), { code: 'ENOENT' })
    calls.comments.push({ number, body })
    return { id: String(calls.comments.length) }
  }
  await hooks.ready()
  return { database, hooks, session, source, calls, sent, deleted,
    command: (arg, sessionOverride = session) => action({ session: sessionOverride }, arg) }
}

test('concurrent resolve commands close once and only one reports a new confirmation', async t => {
  const f = await fixture(t)
  await f.command('')
  Object.assign(f.database.rows[0], { status: 'AWAITING_RECOVERY' })
  Object.assign(f.database.rows[0].payload, { issue_number: '42', issue_state: 'open' })
  let reads = 0, closes = 0
  CNBClient.prototype.getIssue = async () => { reads++; return { state: 'open' } }
  CNBClient.prototype.closeIssue = async () => { closes++ }
  const replies = await Promise.all([f.command('resolve'), f.command('resolve')])
  assert.equal(reads, 1)
  assert.equal(closes, 1)
  assert.equal(replies.filter(reply => reply === '已确认解决，报障结束，Issue 已关闭。感谢反馈！').length, 1)
  assert.ok(replies.some(reply => /无需重复确认/.test(reply)))
  assert.equal(f.database.rows[0].payload.closed_by_user, true)
  assert.equal(f.sent.length, 1, 'command replies must not also be sent as notifications')
})

test('resolve racing an automatic timeout keeps the timeout reason and does not close again', async t => {
  const f = await fixture(t)
  await f.command('')
  Object.assign(f.database.rows[0], { status: 'AWAITING_RECOVERY' })
  Object.assign(f.database.rows[0].payload, { issue_number: '42', issue_state: 'open', recovery_deadline: 1 })
  let closes = 0, releaseClose, signalClose
  const started = new Promise(resolve => { signalClose = resolve })
  CNBClient.prototype.getIssue = async () => ({ state: 'open' })
  CNBClient.prototype.closeIssue = async () => {
    closes++
    if (closes === 1) {
      signalClose()
      await new Promise(resolve => { releaseClose = resolve })
    }
  }
  const timeout = f.command('status')
  await started
  const confirmation = f.command('resolve')
  releaseClose()
  await timeout
  assert.match(await confirmation, /已因等待确认超时自动关闭/)
  assert.equal(closes, 1)
  assert.equal(f.database.rows[0].status, 'DONE')
  assert.equal(f.database.rows[0].payload.close_reason, 'recovery_timeout')
  assert.notEqual(f.database.rows[0].payload.closed_by_user, true)
  assert.equal(f.sent.filter(message => typeof message === 'string' && /等待确认超时/.test(message)).length, 1)
})

test('a background close and a resolve command produce one success notification', async t => {
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  const timers = new Map()
  global.setTimeout = (fn, delay) => { const handle = {}; timers.set(handle, { fn, delay }); return handle }
  global.clearTimeout = handle => timers.delete(handle)
  t.after(() => { global.setTimeout = originalSetTimeout; global.clearTimeout = originalClearTimeout })
  const f = await fixture(t, { group_whitelist: ['group'] })
  Object.assign(f.session, { channelId: 'group', guildId: 'group', isDirect: false })
  await f.command('')
  Object.assign(f.database.rows[0], { status: 'CLOSING_ISSUE' })
  Object.assign(f.database.rows[0].payload, { issue_number: '42', close_reason: 'user_resolved', next_issue_close_at: 1 })
  f.hooks.dispose()
  await f.hooks.ready()
  let releaseClose, signalClose, closes = 0
  const started = new Promise(resolve => { signalClose = resolve })
  CNBClient.prototype.getIssue = async () => ({ state: 'open' })
  CNBClient.prototype.closeIssue = async () => {
    closes++
    signalClose()
    await new Promise(resolve => { releaseClose = resolve })
  }
  const [handle, timer] = [...timers][0]
  timers.delete(handle)
  timer.fn()
  await started
  const reply = f.command('resolve')
  releaseClose()
  assert.match(await reply, /无需重复确认/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closes, 1)
  assert.equal(f.sent.length, 2, 'one initial prompt and one background success notice')
  assert.equal(f.sent[1][0].type, 'at')
  assert.equal(f.sent[1][0].attrs.id, 'user')
  assert.match(f.sent[1].at(-1), /已确认解决/)
})

test('resolve cannot convert a pending timeout retry into a user confirmation', async t => {
  const f = await fixture(t)
  await f.command('')
  Object.assign(f.database.rows[0], { status: 'AWAITING_RECOVERY' })
  Object.assign(f.database.rows[0].payload, { issue_number: '42', issue_state: 'open', recovery_deadline: 1 })
  let closes = 0
  CNBClient.prototype.getIssue = async () => ({ state: 'open' })
  CNBClient.prototype.closeIssue = async () => {
    if (++closes === 1) throw new CNBNetworkError('disconnected')
  }
  await f.command('status')
  assert.equal(f.database.rows[0].status, 'CLOSING_ISSUE')
  assert.match(await f.command('resolve'), /超时自动关闭流程/)
  assert.equal(closes, 1)
  assert.equal(f.database.rows[0].payload.close_reason, 'recovery_timeout')
  await f.command('status')
  assert.equal(closes, 2)
  assert.equal(f.database.rows[0].status, 'DONE')
  assert.notEqual(f.database.rows[0].payload.closed_by_user, true)
  assert.equal(f.calls.comments.length, 1)
  assert.match(await f.command('resolve'), /已因等待确认超时自动关闭/)
})

test('recall only the upload prompt after accepting a diagnostic file; append does not recall again', async t => {
  const f = await fixture(t)
  assert.equal(await f.command('启动后闪退'), '')
  assert.match(f.sent[0], /请在 10 分钟内/)
  assert.match(f.sent[0], /Issue 标题：启动后闪退/)
  assert.deepEqual(f.database.rows[0].payload.log_prompt_message_ids, ['message-1'])
  f.session.elements[0].attrs.name = 'diagnostic.zip'
  CNBClient.prototype.uploadAttachment = async () => {
    assert.deepEqual(f.deleted, [{ channelId: 'private', messageId: 'message-1' }])
    return { asset_link: '[log](https://cnb.cool/asset/1)' }
  }
  await f.hooks.message(f.session)
  assert.equal(f.database.rows[0].status, 'WAITING_NPC')
  assert.deepEqual(f.database.rows[0].payload.log_prompt_message_ids, [])
  await f.hooks.message(f.session)
  assert.equal(f.deleted.length, 1)
  assert.equal(await fs.readFile(f.source, 'utf8'), 'diagnostic log')
})

test('wait for prompt message IDs when a file arrives before the prompt send completes', async t => {
  const f = await fixture(t)
  let finishSend, promptStarted
  const started = new Promise(resolve => { promptStarted = resolve })
  f.session.send = async message => {
    f.sent.push(message)
    if (message.startsWith('请在')) {
      promptStarted()
      return new Promise(resolve => { finishSend = resolve })
    }
    return ['receipt']
  }
  const command = f.command('')
  await started
  const upload = f.hooks.message(f.session)
  finishSend(['prompt'])
  await Promise.all([command, upload])
  assert.deepEqual(f.deleted, [{ channelId: 'private', messageId: 'prompt' }])
  assert.equal(f.database.rows[0].status, 'WAITING_NPC')
})

test('keep the prompt for invalid or unreadable files and recall it after a valid retry', async t => {
  const f = await fixture(t)
  await f.command('')
  const validAttrs = { ...f.session.elements[0].attrs }
  f.session.elements[0].attrs = { name: 'source.log' }
  await f.hooks.message(f.session)
  assert.equal(f.database.rows[0].status, 'WAITING_LOG')
  assert.deepEqual(f.deleted, [])
  f.session.elements[0].attrs = { ...validAttrs, name: 'program.exe' }
  await f.hooks.message(f.session)
  assert.equal(f.database.rows[0].status, 'WAITING_LOG')
  assert.deepEqual(f.deleted, [])
  assert.deepEqual(f.database.rows[0].payload.log_prompt_message_ids, ['message-1'])
  f.session.elements[0].attrs = validAttrs
  await f.hooks.message(f.session)
  assert.deepEqual(f.deleted, [{ channelId: 'private', messageId: 'message-1' }])
})

test('recall every prompt segment and continue submitting when the adapter rejects recall', async t => {
  const f = await fixture(t)
  f.session.send = async message => { f.sent.push(message); return ['prompt-a', 'prompt-b'] }
  f.session.bot.deleteMessage = async (channelId, messageId) => {
    f.deleted.push({ channelId, messageId })
    throw new Error('recall time limit exceeded')
  }
  await f.command('')
  await f.hooks.message(f.session)
  assert.deepEqual(f.deleted, [
    { channelId: 'private', messageId: 'prompt-a' },
    { channelId: 'private', messageId: 'prompt-b' },
  ])
  assert.equal(f.calls.issues.length, 1)
  assert.equal(f.database.rows[0].status, 'WAITING_NPC')
  assert.deepEqual(f.database.rows[0].payload.log_prompt_message_ids, [])
})

test('persist prompt IDs across restart and scope group recall to the report owner', async t => {
  const f = await fixture(t, { group_whitelist: ['group'] })
  Object.assign(f.session, { channelId: 'group', guildId: 'group', isDirect: false })
  await f.command('')
  f.hooks.dispose()
  await f.hooks.ready()
  await f.hooks.message({ ...f.session, userId: 'someone-else' })
  assert.deepEqual(f.deleted, [])
  assert.equal(f.calls.issues.length, 0)
  await f.hooks.message(f.session)
  assert.deepEqual(f.deleted, [{ channelId: 'group', messageId: 'message-1' }])
  assert.equal(f.database.rows[0].status, 'WAITING_NPC')
})

test('recall user files only after the initial Issue or appended comment is saved', async t => {
  const f = await fixture(t, { group_whitelist: ['group'] })
  Object.assign(f.session, { channelId: 'group', guildId: 'group', isDirect: false, messageId: 'initial-file' })
  f.session.bot.deleteMessage = async (channelId, messageId) => {
    if (messageId === 'initial-file') assert.equal(f.calls.issues.length, 1)
    if (messageId === 'extra-file') assert.match(f.calls.comments.at(-1).body, /追加日志附件/)
    f.deleted.push({ channelId, messageId })
  }
  await f.command('')
  await f.hooks.message({ ...f.session, userId: 'someone-else', messageId: 'unrelated-file' })
  assert.deepEqual(f.deleted, [])
  await f.hooks.message(f.session)
  assert.deepEqual(f.deleted, [
    { channelId: 'group', messageId: 'message-1' },
    { channelId: 'group', messageId: 'initial-file' },
  ])
  assert.equal(f.database.rows[0].payload.source_message_id, '')
  f.session.messageId = 'extra-file'
  await f.hooks.message(f.session)
  assert.deepEqual(f.deleted.at(-1), { channelId: 'group', messageId: 'extra-file' })
  assert.equal(f.deleted.length, 3)
})

test('file recall denied by the platform does not interrupt initial or appended submissions', async t => {
  const f = await fixture(t)
  f.session.messageId = 'initial-file'
  f.session.bot.deleteMessage = async (channelId, messageId) => {
    f.deleted.push({ channelId, messageId })
    throw new Error('permission denied')
  }
  await f.command('')
  await f.hooks.message(f.session)
  assert.equal(f.calls.issues.length, 1)
  assert.equal(f.database.rows[0].status, 'WAITING_NPC')
  f.session.messageId = 'extra-file'
  await f.hooks.message(f.session)
  assert.match(f.sent.at(-1), /日志已追加到 Issue/)
  assert.deepEqual(f.deleted.map(row => row.messageId), ['message-1', 'initial-file', 'extra-file'])
})

test('keep user files when initial Issue creation fails even after a successful upload', async t => {
  const f = await fixture(t)
  f.session.messageId = 'initial-file'
  await f.command('')
  CNBClient.prototype.createIssue = async () => { throw new CNBAPIError('rejected', 403) }
  await f.hooks.message(f.session)
  assert.equal(f.calls.uploads.length, 1)
  assert.equal(f.database.rows[0].status, 'FAILED')
  assert.deepEqual(f.deleted.map(row => row.messageId), ['message-1'])
})

test('keep user files on failed or uncertain appended comments and invalid attachments', async t => {
  const f = await fixture(t)
  await f.command('')
  await f.hooks.message(f.session)
  f.session.messageId = 'extra-file'
  for (const error of [new CNBAPIError('rejected', 403), new CNBNetworkError('disconnected')]) {
    CNBClient.prototype.createComment = async () => { throw error }
    await f.hooks.message(f.session)
    assert.deepEqual(f.deleted.map(row => row.messageId), ['message-1'])
  }
  f.session.elements[0].attrs.name = 'program.exe'
  await f.hooks.message(f.session)
  assert.deepEqual(f.deleted.map(row => row.messageId), ['message-1'])
  assert.equal(f.database.rows[0].status, 'WAITING_NPC')
})

test('delete uploaded copies before creating Issue; append logs to the same Issue', async t => {
  const f = await fixture(t)
  await f.command('')
  await f.hooks.message(f.session)
  assert.equal(f.calls.issues.length, 1)
  assert.equal(f.database.rows[0].status, 'WAITING_NPC')
  assert.equal(f.database.rows[0].payload.prepared_path, '')
  await f.hooks.message(f.session)
  assert.equal(f.calls.issues.length, 1)
  assert.equal(f.calls.comments.length, 2)
  assert.equal(f.calls.comments.at(-1).number, '42')
  assert.match(f.calls.comments.at(-1).body, /追加日志附件/)
  assert.match(f.sent.at(-1), /debug analyze/)
  assert.equal(await fs.readFile(f.source, 'utf8'), 'diagnostic log')
  await f.command('analyze')
  assert.equal(f.database.rows[0].payload.analysis_round, 2)
  await f.command('cancel')
  await f.hooks.message(f.session)
  assert.equal(f.calls.uploads.length, 2)
})

test('append during recovery; clean up on uncertain comment submission without retrying', async t => {
  const f = await fixture(t)
  await f.command('')
  await f.hooks.message(f.session)
  f.database.rows[0].status = 'AWAITING_RECOVERY'
  CNBClient.prototype.createComment = async () => { throw new CNBNetworkError('disconnected') }
  await f.hooks.message(f.session)
  assert.match(f.sent.at(-1), /提交结果不确定/)
  await assert.rejects(fs.stat(f.calls.uploads.at(-1)), { code: 'ENOENT' })
  assert.equal(f.database.rows[0].status, 'AWAITING_RECOVERY')
  assert.equal(f.calls.issues.length, 1)
})

test('rejected append upload cleans up the staged file and leaves report usable', async t => {
  const f = await fixture(t)
  await f.command('')
  await f.hooks.message(f.session)
  let staged
  CNBClient.prototype.uploadAttachment = async file => {
    staged = file
    throw new CNBAPIError('rejected', 403)
  }
  await f.hooks.message(f.session)
  await assert.rejects(fs.stat(staged), { code: 'ENOENT' })
  assert.equal(f.database.rows[0].status, 'WAITING_NPC')
  assert.match(f.sent.at(-1), /追加日志失败/)
})

test('resume already uploaded attachment without a local file or another upload', async t => {
  const f = await fixture(t)
  await f.command('')
  Object.assign(f.database.rows[0], { status: 'CREATING_ISSUE' })
  Object.assign(f.database.rows[0].payload, {
    external_phase: 'asset_uploaded', asset_link: '[log](https://cnb.cool/asset/1)',
    prepared_path: '', file_bytes: 14, source_file_suffix: '.log',
  })
  f.hooks.dispose()
  await f.hooks.ready()
  assert.equal(f.calls.uploads.length, 0)
  assert.equal(f.calls.issues.length, 1)
  assert.match(f.calls.issues[0].body, /14 字节/)
  assert.equal(f.database.rows[0].status, 'WAITING_NPC')
})

test('active queries and pruning exclude history in the database', async () => {
  const database = new Database()
  database.rows = [
    { id: 'active', status: 'WAITING_LOG', active_key: 'key', updated_at: 0 },
    { id: 'old', status: 'DONE', active_key: null, updated_at: 0 },
    { id: 'recent', status: 'FAILED', active_key: null, updated_at: 200 },
  ]
  const store = new ReportStore(database)
  assert.deepEqual((await store.listActive()).map(row => row.id), ['active'])
  assert.ok(database.queries[0].status.$in)
  await store.prune(100)
  assert.deepEqual(database.rows.map(row => row.id), ['active', 'recent'])
})

test('real attachment client streams bytes and releases response and file resources', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cnb-client-'))
  const file = path.join(dir, 'test.log')
  await fs.writeFile(file, 'streamed log')
  const originalFetch = global.fetch
  t.after(async () => {
    global.fetch = originalFetch
    await fs.rm(dir, { recursive: true, force: true })
  })
  let stream, cancelled = false
  global.fetch = async (_url, options) => {
    if (options.method === 'POST') return new Response(JSON.stringify({ file_upload_urls: [{
      upload_url: 'https://uploads.example.test/log', asset_link: '[log](https://cnb.cool/asset)',
    }] }))
    assert.equal(options.method, 'PUT')
    assert.equal(options.headers['Content-Length'], '12')
    stream = options.body
    let body = ''
    for await (const chunk of stream) body += chunk.toString()
    assert.equal(body, 'streamed log')
    return new Response(new ReadableStream({ cancel() { cancelled = true } }))
  }
  const client = new CNBClient('https://api.cnb.cool', 'https://cnb.cool', 'group/repo', 'fake')
  const asset = await client.uploadAttachment(file, 'test.log', 12)
  assert.match(asset.asset_link, /asset/)
  assert.ok(cancelled)
  assert.ok(stream.destroyed)
})

test('scheduled metadata selects only due tasks and updates with each transition', async () => {
  const database = new Database()
  const notifications = []
  const store = new ReportStore(database, time => notifications.push(time))
  const base = {
    active_key: 'one', status: 'WAITING_LOG', platform: 'test', bot_id: 'bot',
    guild_id: '', channel_id: 'private', user_id: 'user', direct: true,
    created_at: 1, updated_at: 1, deadline: 100,
  }
  await store.create({ ...base, id: 'one' })
  await store.create({ ...base, id: 'two', active_key: 'two', deadline: 200 })
  assert.equal(await store.nextScheduled(), 100)
  assert.deepEqual((await store.listDue(150)).map(task => task.id), ['one'])
  await store.transition('one', 'WAITING_NPC', ['WAITING_LOG'], { next_poll_at: 300, analysis_deadline: 250 })
  assert.equal(database.rows[0].scheduled_at, 250)
  assert.equal(await store.nextScheduled(), 200)
  await store.transition('two', 'UNCERTAIN', ['WAITING_LOG'], { uncertain_kind: 'issue_creation' })
  assert.equal(database.rows[1].scheduled_at, 0)
  await store.transition('one', 'DONE', ['WAITING_NPC'], {}, true)
  assert.equal(await store.nextScheduled(), 0)
  assert.deepEqual(notifications, [100, 200, 250, 0, 0])
})

test('idle scheduler performs no repeated queries and wakes for a newly created report', async t => {
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  const originalNow = Date.now
  const timers = new Map()
  global.setTimeout = (fn, delay) => {
    const handle = {}
    timers.set(handle, { fn, delay })
    return handle
  }
  global.clearTimeout = handle => timers.delete(handle)
  t.after(() => {
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
    Date.now = originalNow
  })
  const f = await fixture(t)
  assert.equal(timers.size, 0)
  await f.command('')
  assert.equal(timers.size, 1)
  const [handle, timer] = [...timers][0]
  assert.ok(timer.delay > 590000)
  Date.now = () => (f.database.rows[0].deadline + 1) * 1000
  timers.delete(handle)
  timer.fn()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.database.rows[0].status, 'EXPIRED')
  assert.equal(timers.size, 0)
  assert.ok(f.database.queries.some(query => query.scheduled_at?.$lte))
})

test('concurrent comment readers share a request, while later readers fetch fresh data', async t => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  let calls = 0, release
  global.fetch = async () => {
    calls++
    await new Promise(resolve => { release = resolve })
    return new Response(JSON.stringify([{ id: calls }]))
  }
  const client = new CNBClient('https://api.cnb.cool', 'https://cnb.cool', 'group/repo', 'fake')
  const first = client.listComments('42')
  const second = client.listComments('42')
  assert.equal(calls, 1)
  release()
  assert.deepEqual(await first, await second)
  const third = client.listComments('42')
  assert.equal(calls, 2)
  release()
  assert.deepEqual(await third, [{ id: 2 }])
})

test('expired recovery deadline does not bypass network retry backoff', () => {
  const task = {
    status: 'AWAITING_RECOVERY', recovery_deadline: 100, next_issue_check_at: 200,
    last_issue_error: 'network unavailable',
  }
  assert.equal(scheduledAt(task), 200)
  assert.equal(scheduledAt({ ...task, last_issue_error: '' }), 100)
})

function sampleReport() {
  return {
    id: 'sample', active_key: 'one', status: 'WAITING_NPC', platform: 'test', bot_id: 'bot',
    guild_id: '', channel_id: 'private', user_id: 'user', direct: true,
    created_at: 1, updated_at: 1, deadline: 100, next_poll_at: 100,
    poll_attempts: 0, analysis_deadline: 1000, description: 'preserve this description',
  }
}

test('scheduling updates write only changed fields and preserve identity and JSON data', async () => {
  const database = new Database()
  const store = new ReportStore(database)
  await store.create(sampleReport())
  const originalPayload = structuredClone(database.rows[0].payload)
  await store.update('sample', { deadline: 200 })
  assert.deepEqual(Object.keys(database.writes.at(-1)).sort(), ['deadline', 'revision', 'scheduled_at', 'updated_at'])
  assert.deepEqual(database.rows[0].payload, originalPayload)
  await store.update('sample', { next_poll_at: 300 })
  assert.deepEqual(Object.keys(database.writes.at(-1)).sort(), ['payload', 'revision', 'scheduled_at', 'updated_at'])
  assert.equal(database.rows[0].payload.description, originalPayload.description)
  assert.equal(database.rows[0].payload.next_poll_at, 300)
  assert.equal(database.rows[0].platform, 'test')
})

test('a conflicting update rereads once and preserves the competing payload change', async () => {
  const database = new Database()
  const store = new ReportStore(database)
  await store.create(sampleReport())
  const originalSet = database.set.bind(database)
  let conflict = true
  database.set = async (...args) => {
    if (conflict) {
      conflict = false
      database.rows[0].revision++
      database.rows[0].payload.description = 'concurrent supplement'
      return { matched: 0 }
    }
    return originalSet(...args)
  }
  database.queries = []
  const updated = await store.update('sample', { next_poll_at: 300 })
  assert.equal(updated.description, 'concurrent supplement')
  assert.equal(updated.next_poll_at, 300)
  assert.equal(database.queries.length, 3) // Initial read, conflict read, final read.
  const rejected = await store.transitionAtRevision('sample', 'DELIVERING', ['WAITING_NPC'], 0)
  assert.equal(rejected, undefined)
  assert.equal(database.rows[0].status, 'WAITING_NPC')
})

test('analysis selection keeps author, round and time checks and selects the earliest valid reply', async t => {
  const f = await fixture(t)
  await f.command('')
  await f.hooks.message(f.session)
  const task = f.database.rows[0].payload
  const body = `一句话描述：test\n详细分析：details\n${task.trigger_marker}`
  const reply = (id, offset, username = 'CodeBuddy', text = body) => ({
    id, body: text, author: { username }, created_at: new Date((task.trigger_at + offset) * 1000).toISOString(),
  })
  CNBClient.prototype.listComments = async () => [
    reply('later', 20), reply('untrusted', 1, 'stranger'), reply('before-trigger', -20),
    reply('wrong-round', 1, 'CodeBuddy', 'some other marker'), reply('earliest', 10), reply('tie', 10),
  ]
  await f.command('status')
  assert.equal(f.database.rows[0].payload.analysis_comment_id, 'earliest')
})

test('comment attachments use the issue comment asset endpoint', async t => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cnb-comment-'))
  const file = path.join(dir, 'append.log')
  await fs.writeFile(file, 'append log')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = []
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    if (options.method === 'POST') return new Response(JSON.stringify({
      upload_url: 'https://uploads.example.test/comment',
      asset_link: '[append.log](https://cnb.cool/asset/comment-1)',
    }))
    for await (const chunk of options.body) assert.equal(chunk.toString(), 'append log')
    return new Response('{}')
  }
  const client = new CNBClient('https://api.cnb.cool', 'https://cnb.cool', 'group/repo', 'fake')
  const asset = await client.uploadCommentAttachment('42', file, 'append.log', 10)
  assert.match(calls[0].url, /issues\/42\/comment-file-asset-upload-url$/)
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'append.log', size: 10, content_type: 'text/plain' })
  assert.equal(calls[1].options.method, 'PUT')
  assert.match(asset.asset_link, /comment-1/)
})

test('common diagnostic formats are accepted while unrelated binaries remain rejected', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cnb-formats-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const json = path.join(dir, 'diagnostic.json')
  const exe = path.join(dir, 'program.exe')
  await fs.writeFile(json, '{}')
  await fs.writeFile(exe, 'binary')
  const staged = path.join(dir, 'staged')
  const result = await stageFile(pathToFileURL(json).href, 'diagnostic.json', staged, 1024, new Set())
  assert.equal(result.suffix, '.json')
  await assert.rejects(stageFile(pathToFileURL(exe).href, 'program.exe', path.join(dir, 'bad'), 1024, new Set()), /常见日志和诊断文件/)
})

test('adapter file names survive both initial and appended uploads', async t => {
  const f = await fixture(t)
  f.session.elements[0].attrs = { file: 'runtime.json', url: pathToFileURL(f.source).href }
  await f.command('')
  await f.hooks.message(f.session)
  assert.match(f.calls.issues[0].body, /\[runtime.json\]/)
  assert.match(f.calls.issues[0].body, /文件类型：JSON/)
  f.session.elements[0].attrs.file = 'second.txt'
  await f.hooks.message(f.session)
  assert.match(f.calls.comments.at(-1).body, /\[second.txt\]/)
  assert.equal(await fs.readFile(f.source, 'utf8'), 'diagnostic log')
})

test('missing adapter names use a real URL filename and never default to log.zip', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cnb-filename-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const source = path.join(dir, '诊断.json')
  const bytes = Buffer.from('{"message":"sample"}')
  await fs.writeFile(source, bytes)
  const destination = path.join(dir, 'staged')
  const staged = await stageFile(pathToFileURL(source).href, '', destination, 1024, new Set())
  assert.equal(staged.name, '诊断.json')
  assert.deepEqual(await fs.readFile(destination), bytes)
  const unknown = path.join(dir, 'opaque')
  await fs.writeFile(unknown, bytes)
  await assert.rejects(stageFile(pathToFileURL(unknown).href, '', path.join(dir, 'invalid'), 1024, new Set()), /无法确定附件的原始文件名/)
})

test('download response filenames support UTF-8 and ordinary Content-Disposition', () => {
  assert.equal(filenameFromDisposition("attachment; filename=backup.zip; filename*=UTF-8''%E6%97%A5%E5%BF%97.json"), '日志.json')
  assert.equal(filenameFromDisposition('attachment; filename="diagnostic.log"'), 'diagnostic.log')
  assert.equal(filenameFromDisposition('attachment'), '')
})

test('OneBot raw event names are used when normalized file attributes lose the name', async t => {
  const f = await fixture(t)
  const url = pathToFileURL(f.source).href
  f.session.elements = [{ type: 'file', attrs: { src: url, file: 'opaque-resource-id' } }]
  f.session.event = {}
  f.session.bot = { internal: {} }
  Session.prototype.setInternal.call(f.session, 'onebot', {
    message: [{ type: 'file', data: { name: 'original.json', url } }],
  })
  assert.equal(f.session.onebot.message[0].data.name, 'original.json')
  assert.equal(f.session.event._data.message[0].data.name, 'original.json')
  await f.command('')
  await f.hooks.message(f.session)
  assert.match(f.calls.issues[0].body, /\[original.json\]/)
  Session.prototype.setInternal.call(f.session, 'onebot', { file: { name: 'additional.log', url } })
  // The public session accessor also works without serialized event metadata.
  delete f.session.event._type
  delete f.session.event._data
  await f.hooks.message(f.session)
  assert.match(f.calls.comments.at(-1).body, /\[additional.log\]/)
  assert.equal(f.calls.uploads.length, 2)
})
