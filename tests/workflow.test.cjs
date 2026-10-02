const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { apply } = require('../lib/index')
const { CNBClient, CNBAPIError, CNBNetworkError } = require('../lib/client')
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

async function fixture(t) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cnb-workflow-'))
  const database = new Database()
  const hooks = {}
  let action
  const sent = []
  const ctx = {
    baseDir, database,
    model: { extend() {} },
    logger: () => ({ warn() {}, debug() {}, info() {} }),
    bots: [],
    command: () => ({ action(fn) { action = fn } }),
    on(event, fn) { hooks[event] = fn },
  }
  apply(ctx, { cnb_repository: 'group/repo', cnb_token: 'fake-token' })
  const originals = {}
  for (const name of ['uploadAttachment', 'createIssue', 'createComment', 'listComments']) originals[name] = CNBClient.prototype[name]
  t.after(async () => {
    hooks.dispose()
    Object.assign(CNBClient.prototype, originals)
    await fs.rm(baseDir, { recursive: true, force: true })
  })
  const source = path.join(baseDir, 'source.log')
  await fs.writeFile(source, 'diagnostic log')
  const session = {
    platform: 'test', selfId: 'bot', userId: 'user', channelId: 'private', isDirect: true,
    elements: [{ type: 'file', attrs: { name: 'source.log', url: pathToFileURL(source).href } }],
    async send(message) { sent.push(message) },
  }
  const calls = { uploads: [], issues: [], comments: [] }
  CNBClient.prototype.uploadAttachment = async function(file, name, size) {
    assert.equal((await fs.stat(file)).size, size)
    calls.uploads.push(file)
    return { asset_link: `[${name}](https://cnb.cool/asset/${calls.uploads.length})` }
  }
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
  return { database, hooks, session, source, calls, sent, command: arg => action({ session }, arg) }
}

test('delete uploaded copies before creating Issue; append logs to the same Issue', async t => {
  const f = await fixture(t)
  await f.command('')
  await f.hooks.message(f.session)
  assert.equal(f.calls.issues.length, 1)
  assert.equal(f.database.rows[0].status, 'WAITING_NPC')
  assert.equal(f.database.rows[0].payload.prepared_path, '')
  await f.hooks.message(f.session)
  assert.equal(f.calls.uploads.length, 2)
  assert.equal(f.calls.issues.length, 1)
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
