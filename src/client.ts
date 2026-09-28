import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { extname } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'

export class CNBAPIError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'CNBAPIError'
  }
}

export class CNBNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CNBNetworkError'
  }
}

export interface Asset {
  asset_link: string
  download_url?: string
  name?: string
}

export class CNBClient {
  readonly api: string
  readonly web: string
  readonly repository: string

  constructor(
    apiEndpoint: string,
    webEndpoint: string,
    repository: string,
    private token: string,
  ) {
    this.api = endpoint(apiEndpoint, 'CNB API')
    this.web = endpoint(webEndpoint, 'CNB 网页')
    this.repository = repository.trim().replace(/^\/+|\/+$/g, '')
    if (!this.repository || this.repository.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new TypeError('CNB 仓库路径格式无效。')
    }
    if (!token.trim()) throw new TypeError('请先在插件配置中填写 CNB 访问令牌。')
    this.token = token.trim()
  }

  private repoPath() {
    return this.repository.split('/').map(encodeURIComponent).join('/')
  }

  private async json(method: string, path: string, body?: unknown, query?: Record<string, string | number>) {
    const url = new URL(`${this.api}/${path.replace(/^\//, '')}`)
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          'User-Agent': 'Koishi-CNB-Report/0.1',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new CNBNetworkError(`CNB API 网络请求结果不确定：${errorMessage(error)}`)
    }
    let raw = ''
    if (response.body) {
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > 4 * 1024 * 1024) {
            await reader.cancel()
            throw new CNBAPIError('CNB API 响应超过 4 MiB 限制。', response.status)
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      raw = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
    }
    let data: any = {}
    if (raw) {
      try { data = JSON.parse(raw) } catch {
        throw new CNBAPIError('CNB API 返回了无法解析的 JSON。', response.status)
      }
    }
    if (!response.ok) {
      const reason = data?.errmsg || data?.message || response.statusText
      throw new CNBAPIError(`CNB API 请求失败（HTTP ${response.status}）：${reason}`, response.status)
    }
    return data
  }

  issueUrl(number: string) {
    return `${this.web}/${this.repoPath()}/-/issues/${encodeURIComponent(number)}`
  }

  async uploadAttachment(filePath: string, filename: string, size: number): Promise<Asset> {
    const name = filename.split(/[\\/]/).pop() || 'log.zip'
    const contentType = extname(name).toLowerCase() === '.log' ? 'text/plain' : 'application/zip'
    const created = await this.json('POST', `/${this.repoPath()}/-/issues/asset-groups`, {
      file_assets: [{ name, size, content_type: contentType }],
    })
    const asset = (created?.file_upload_urls || created?.assets || [])[0]
    if (!asset?.upload_url || !asset?.asset_link) {
      throw new CNBAPIError('CNB 创建附件组时没有返回文件上传地址。')
    }
    const uploadUrl = new URL(asset.upload_url)
    if (uploadUrl.protocol !== 'https:' || uploadUrl.username || uploadUrl.password) {
      throw new CNBAPIError('CNB 返回的附件上传 URL 不是有效 HTTPS 地址。')
    }
    let response: Response
    try {
      const stream = createReadStream(filePath)
      response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType, 'Content-Length': String(size) },
        body: stream as any,
        duplex: 'half',
        signal: AbortSignal.timeout(120_000),
      } as RequestInit & { duplex: 'half' })
    } catch {
      throw new CNBNetworkError('CNB 附件上传结果不确定，请检查 CNB 外部状态。')
    }
    if (!response.ok) throw new CNBAPIError(`CNB 附件上传失败（HTTP ${response.status}）。`, response.status)
    return { asset_link: String(asset.asset_link), download_url: String(asset.download_url || ''), name }
  }

  async createIssue(title: string, body: string) {
    const result = await this.json('POST', `/${this.repoPath()}/-/issues`, { title, body })
    if (!result || !result.number) throw new CNBAPIError('CNB 创建 Issue 响应缺少 Issue 编号。')
    return { ...result, html_url: result.html_url || this.issueUrl(String(result.number)) }
  }

  getIssue(number: string) {
    return this.json('GET', `/${this.repoPath()}/-/issues/${encodeURIComponent(number)}`)
  }

  closeIssue(number: string) {
    return this.json('PATCH', `/${this.repoPath()}/-/issues/${encodeURIComponent(number)}`, {
      state: 'closed', state_reason: 'completed',
    })
  }

  createComment(number: string, body: string) {
    return this.json('POST', `/${this.repoPath()}/-/issues/${encodeURIComponent(number)}/comments`, { body })
  }

  async listComments(number: string) {
    const comments: any[] = []
    for (let page = 1; page <= 20; page++) {
      const result = await this.json('GET', `/${this.repoPath()}/-/issues/${encodeURIComponent(number)}/comments`, undefined, {
        page, page_size: 100,
      })
      const batch = Array.isArray(result) ? result : result?.data
      if (!Array.isArray(batch)) throw new CNBAPIError('CNB 评论列表响应格式异常。')
      comments.push(...batch)
      if (batch.length < 100) break
    }
    return comments
  }
}

function endpoint(value: string, label: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new TypeError(`${label}地址无效，必须使用 HTTPS。`) }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new TypeError(`${label}地址无效，必须使用 HTTPS。`)
  }
  return url.href.replace(/\/$/, '')
}

export async function stageFile(
  sourceUrl: string,
  filename: string,
  destination: string,
  maxBytes: number,
  allowlist: ReadonlySet<string>,
) {
  const name = filename.replace(/\\/g, '/').split('/').pop() || 'log.zip'
  const suffix = extname(name).toLowerCase()
  if (suffix !== '.zip' && suffix !== '.log') throw new Error('只接受 .zip 或 .log 日志文件，请重新上传。')
  const size = sourceUrl.startsWith('file:')
    ? await stageLocalFile(sourceUrl, destination, maxBytes)
    : await downloadSafe(sourceUrl, destination, maxBytes, allowlist)
  if (!size) {
    await fs.rm(destination, { force: true }).catch(() => {})
    throw new Error('上传的日志文件为空。')
  }
  return { name, size, suffix }
}

async function stageLocalFile(sourceUrl: string, destination: string, maxBytes: number) {
  const url = new URL(sourceUrl)
  if (url.host && url.host !== 'localhost') throw new Error('附件本地路径无效。')
  let path: string
  try { path = fileURLToPath(url) } catch { throw new Error('附件本地路径无效。') }
  const info = await fs.lstat(path).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error('无法读取这个日志文件，请重新上传。')
  if (info.size > maxBytes) throw sizeError(maxBytes)
  try {
    const size = await copyLimited(createReadStream(path), destination, maxBytes)
    return size
  } catch {
    await fs.rm(destination, { force: true }).catch(() => {})
    throw new Error('读取日志文件失败，请重新上传。')
  }
}

async function downloadSafe(initialUrl: string, destination: string, maxBytes: number, allowlist: ReadonlySet<string>) {
  let current = initialUrl
  const endAt = Date.now() + 120_000
  for (let redirects = 0; redirects <= 5; redirects++) {
    const url = new URL(current)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      throw new Error('附件下载链接无效。')
    }
    const address = await validateHost(url.hostname, allowlist)
    const remaining = endAt - Date.now()
    if (remaining <= 0) throw new Error('下载日志文件超时，请重新上传。')
    const response = await requestPinned(url, address, remaining)
    const status = response.statusCode || 0
    if (status >= 300 && status < 400) {
      const rawLocation = response.headers.location
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation
      response.destroy()
      if (!location || redirects === 5) throw new Error('附件下载重定向无效或次数过多。')
      current = new URL(location, url).href
      continue
    }
    if (status < 200 || status >= 300) {
      response.destroy()
      throw new Error('下载日志文件失败，文件链接可能已过期，请重新上传。')
    }
    const length = Number(response.headers['content-length'] || 0)
    if (length > maxBytes) {
      response.destroy()
      throw sizeError(maxBytes)
    }
    try {
      return await copyLimited(response, destination, maxBytes)
    } catch (error) {
      await fs.rm(destination, { force: true }).catch(() => {})
      if (Date.now() >= endAt) throw new Error('下载日志文件超时，请重新上传。')
      if (error instanceof Error && error.message.includes('大小上限')) throw error
      throw new Error('下载日志文件失败，文件链接可能已过期，请重新上传。')
    }
  }
  throw new Error('附件下载重定向次数过多。')
}

async function copyLimited(source: NodeJS.ReadableStream, destination: string, maxBytes: number) {
  let total = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length
      if (total > maxBytes) callback(sizeError(maxBytes))
      else callback(null, chunk)
    },
  })
  await pipeline(source, limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
  return total
}

async function validateHost(hostname: string, allowlist: ReadonlySet<string>) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.local')) throw new Error('拒绝访问本机或本地域名附件地址。')
  const entries = [...allowlist].map(item => item.trim().toLowerCase().replace(/^\.|\.$/g, '')).filter(Boolean)
  if (entries.length && !entries.some(item => host === item || host.endsWith(`.${item}`))) {
    throw new Error('附件下载域名不在配置的白名单中。')
  }
  let addresses: { address: string; family: number }[]
  try {
    const family = isIP(host)
    addresses = family ? [{ address: host, family }] : await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error('无法解析附件下载域名。')
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('拒绝访问内网或保留地址附件链接。')
  }
  return addresses[0]
}

function requestPinned(url: URL, address: { address: string; family: number }, timeout: number) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const options: any = {
      method: 'GET',
      agent: false,
      headers: { Host: url.host },
      signal: AbortSignal.timeout(timeout),
      // Pin the socket's DNS result to the public IP that was validated above.
      // The URL hostname remains unchanged for Host and TLS certificate checks.
      lookup: (_hostname: string, lookupOptions: any, callback: (...args: any[]) => void) => {
        if (lookupOptions?.all) callback(null, [address])
        else callback(null, address.address, address.family)
      },
    }
    const tlsHost = url.hostname.replace(/^\[|\]$/g, '')
    if (url.protocol === 'https:' && !isIP(tlsHost)) options.servername = tlsHost
    const onResponse = (response: IncomingMessage) => resolve(response)
    const request = url.protocol === 'https:'
      ? httpsRequest(url, options, onResponse)
      : httpRequest(url, options, onResponse)
    request.once('error', reject)
    request.end()
  })
}

function isPublicAddress(address: string) {
  const ip = address.toLowerCase().split('%')[0]
  if (ip.includes(':')) {
    if (ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb') || ip.startsWith('ff')) return false
    if (ip.startsWith('::ffff:')) return isPublicAddress(ip.slice(7))
    if (ip.startsWith('2001:db8:')) return false
    return /^[23]/.test(ip)
  }
  const n = ip.split('.').map(Number)
  if (n.length !== 4 || n.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false
  const [a, b, c] = n
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) return false
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

function sizeError(maxBytes: number) {
  return new Error(`日志文件超过大小上限（${formatBytes(maxBytes)}），请压缩或只保留相关日志后重新上传。`)
}

function formatBytes(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MiB`
  if (size >= 1024) return `${(size / 1024).toFixed(1).replace(/\.0$/, '')} KiB`
  return `${size} B`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
