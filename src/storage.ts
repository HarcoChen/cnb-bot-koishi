import type { Report, Scope, Status } from './types'

const TABLE = 'cnb_report_tasks'
const ACTIVE = new Set<Status>([
  'WAITING_LOG', 'PREPARING_LOG', 'CREATING_ISSUE', 'TRIGGERING_NPC',
  'WAITING_NPC', 'DELIVERING', 'AWAITING_RECOVERY', 'CLOSING_ISSUE', 'UNCERTAIN',
])
const INDEX_FIELDS = new Set([
  'id', 'active_key', 'status', 'platform', 'bot_id', 'guild_id', 'channel_id',
  'user_id', 'direct', 'created_at', 'updated_at', 'deadline', 'revision',
])

export function extendModel(ctx: any) {
  ctx.model.extend(TABLE, {
    id: { type: 'string', length: 36 },
    active_key: { type: 'string', length: 768, nullable: true },
    status: { type: 'string', length: 32 },
    platform: { type: 'string', length: 64 },
    bot_id: { type: 'string', length: 128 },
    guild_id: { type: 'string', length: 256 },
    channel_id: { type: 'string', length: 256 },
    user_id: { type: 'string', length: 256 },
    direct: 'boolean',
    created_at: 'double',
    updated_at: 'double',
    deadline: 'double',
    revision: { type: 'unsigned', initial: 0 },
    payload: 'json',
  }, { primary: 'id', autoInc: false, unique: ['active_key'] })
}

export class ReportStore {
  constructor(private db: any) {}

  private decode(row: any): Report {
    const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {}
    return { ...payload, ...row, payload: undefined } as Report
  }

  private encode(task: Report) {
    const payload: Record<string, any> = {}
    for (const [key, value] of Object.entries(task)) {
      if (!INDEX_FIELDS.has(key) && value !== undefined) payload[key] = value
    }
    return {
      id: task.id,
      active_key: task.active_key ?? null,
      status: task.status,
      platform: task.platform,
      bot_id: task.bot_id,
      guild_id: task.guild_id ?? '',
      channel_id: task.channel_id,
      user_id: task.user_id,
      direct: !!task.direct,
      created_at: task.created_at,
      updated_at: task.updated_at,
      deadline: task.deadline,
      revision: Number(task.revision || 0),
      payload,
    }
  }

  async get(id: string): Promise<Report | undefined> {
    const [row] = await this.db.get(TABLE, { id })
    return row ? this.decode(row) : undefined
  }

  async all(): Promise<Report[]> {
    return (await this.db.get(TABLE, {})).map((row: any) => this.decode(row))
  }

  async findActive(scope: Scope): Promise<Report | undefined> {
    const key = activeKey(scope)
    const [row] = await this.db.get(TABLE, { active_key: key })
    return row ? this.decode(row) : undefined
  }

  async findWaiting(scope: Scope): Promise<Report | undefined> {
    const task = await this.findActive(scope)
    return task?.status === 'WAITING_LOG' ? task : undefined
  }

  async findCurrent(scope: Scope): Promise<Report | undefined> {
    const active = await this.findActive(scope)
    if (active) return active
    const rows = await this.db.get(TABLE, {
      platform: scope.platform,
      bot_id: scope.bot_id,
      guild_id: scope.guild_id,
      user_id: scope.user_id,
    }, { sort: { created_at: 'desc' }, limit: 1 })
    return rows[0] ? this.decode(rows[0]) : undefined
  }

  async create(task: Report): Promise<boolean> {
    try {
      await this.db.create(TABLE, this.encode(task))
      return true
    } catch (error) {
      // The unique active_key index arbitrates simultaneous /debug requests.
      return false
    }
  }

  async claimLog(task: Report): Promise<boolean> {
    return !!(await this.transition(task.id, 'PREPARING_LOG', ['WAITING_LOG']))
  }

  update(
    id: string,
    patch?: Record<string, any>,
    status?: undefined,
    releaseActive?: boolean,
    expected?: Status[],
  ): Promise<Report | undefined>
  update(
    id: string,
    patch: Record<string, any>,
    status: Status,
    releaseActive: boolean,
    expected: Status[],
  ): Promise<Report | undefined>
  async update(
    id: string,
    patch: Record<string, any> = {},
    status?: Status,
    releaseActive = false,
    expected?: Status[],
  ): Promise<Report | undefined> {
    return (await this.write(id, patch, status, releaseActive, expected)).task
  }

  async transition(
    id: string,
    status: Status,
    expected: Status[],
    patch: Record<string, any> = {},
    releaseActive = false,
  ): Promise<Report | undefined> {
    const result = await this.write(id, patch, status, releaseActive, expected)
    return result.applied ? result.task : undefined
  }

  async transitionAtRevision(
    id: string,
    status: Status,
    expected: Status[],
    revision: number,
    patch: Record<string, any> = {},
    releaseActive = false,
  ): Promise<Report | undefined> {
    const result = await this.write(id, patch, status, releaseActive, expected, revision)
    return result.applied ? result.task : undefined
  }

  private async write(
    id: string,
    patch: Record<string, any>,
    status: Status | undefined,
    releaseActive: boolean,
    expected?: Status[],
    expectedRevision?: number,
  ): Promise<{ task?: Report; applied: boolean }> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.get(id)
      if (!current) return { applied: false }
      if (expected && !expected.includes(current.status)) return { task: current, applied: false }
      if (status && status !== current.status && !expected) {
        return { task: current, applied: false }
      }

      const revision = Number(current.revision || 0)
      if (expectedRevision !== undefined && revision !== expectedRevision) {
        return { task: current, applied: false }
      }
      const next = { ...current, ...patch, status: status ?? current.status }
      if (releaseActive) next.active_key = null
      next.updated_at = Date.now() / 1000
      next.revision = revision + 1

      const query: Record<string, any> = { id, revision }
      if (expected) query.status = { $in: expected }
      const result = await this.db.set(TABLE, query, this.encode(next))
      if (result?.matched) return { task: await this.get(id), applied: true }

      // A concurrent write changed the record after the read. Retry ordinary
      // patches against the latest row; guarded transitions stop on a mismatch.
      const latest = await this.get(id)
      if (!latest || (expected && !expected.includes(latest.status))
        || (expectedRevision !== undefined && Number(latest.revision || 0) !== expectedRevision)) {
        return { task: latest, applied: false }
      }
    }
    return { task: await this.get(id), applied: false }
  }

  async listActive(): Promise<Report[]> {
    return (await this.all()).filter(task => ACTIVE.has(task.status))
  }

  async remove(id: string) {
    await this.db.remove(TABLE, { id })
  }

  async prune(before: number) {
    const terminal = new Set<Status>(['DONE', 'EXPIRED', 'CANCELLED', 'FAILED'])
    for (const task of await this.all()) {
      if (!task.active_key && terminal.has(task.status) && task.updated_at < before) {
        await this.remove(task.id)
      }
    }
  }
}

export function activeKey(scope: Scope) {
  return [scope.platform, scope.bot_id, scope.guild_id, scope.user_id].join(':')
}
