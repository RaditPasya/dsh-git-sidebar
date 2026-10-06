
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  isBranchesView, isCommitDetail, isGitError, isGitFeatureConfig, isGraphView, isPanelView, isRepoStatus,
  isWorktreeListView,
  type GitError, type GitFeatureConfig,
} from '../core/types.ts'
import { PollGuard } from './poll-guard.ts'
import { isGitAllowed } from './access.ts'
import { readJsonBody, writeJson } from './http.ts'
import type { GitService } from './git-service.ts'
import { worktreesHome } from './worktree-home.ts'

export type GitEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: GitError }

const defaultFeatureConfig = (): GitFeatureConfig => ({
  autoIsolate: false,
  autoBaseline: 'current',
  worktreesHome: worktreesHome(),
})

const OK = (value: unknown): GitEnvelope<unknown> => ({ ok: true, value })
const FAIL = (error: GitError): GitEnvelope<never> => ({ ok: false, error })

const BAD_REQUEST: GitError = { code: 'internal', message: 'malformed request' }

interface Subscriber {
  path: string
  last: string
  lastWorktreeDigest?: string
  res: ServerResponse
  statusAbort?: AbortController
}

const POLL_INTERVAL_MS = 30_000
const HEARTBEAT_INTERVAL_MS = 15_000

const STATUS_TIMEOUT_MS = 15_000
const STATUS_TIMEOUT_MESSAGE = 'git status timed out'

const POLL_LIFETIME_MS = Number.MAX_SAFE_INTEGER

const MALFORMED_VIEW: GitError = { code: 'internal', message: 'malformed git response' }

function pathOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const path = (payload as Record<string, unknown>).path
  return typeof path === 'string' && path !== '' ? path : null
}

function okView(res: ServerResponse, value: unknown, guard: (view: unknown) => boolean): void {
  if (value !== null && !guard(value)) {
    writeJson(res, 200, FAIL(MALFORMED_VIEW))
    return
  }
  writeJson(res, 200, OK(value))
}

export function registerGitRoutes(ctx: Context, service: GitService, config: () => GitFeatureConfig = defaultFeatureConfig): () => void {
  const subscribers = new Set<Subscriber>()
  let guard: PollGuard | undefined
  let heartbeatTimer: NodeJS.Timeout | undefined

  const removeSubscriber = (subscriber: Subscriber): void => {
    subscriber.statusAbort?.abort(new Error('git status subscriber closed'))
    subscriber.statusAbort = undefined
    subscribers.delete(subscriber)
    if (subscribers.size === 0) {
      guard?.stop()
      guard = undefined
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
  }

  const push = (subscriber: Subscriber, payload: unknown): void => {
    subscriber.res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  const statusWithDeadline = async (path: string, controller: AbortController = new AbortController()): Promise<Awaited<ReturnType<GitService['status']>>> => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(STATUS_TIMEOUT_MESSAGE)
        controller.abort(error)
        reject(error)
      }, STATUS_TIMEOUT_MS)
    })
    try {
      return await Promise.race([service.status(path, controller.signal), deadline])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  const runPoll = async (): Promise<void> => {
    await Promise.all([...subscribers].map(async (subscriber) => {
      const controller = new AbortController()
      subscriber.statusAbort = controller
      try {
        const status = await statusWithDeadline(subscriber.path, controller)
        let worktreeDigest = subscriber.lastWorktreeDigest ?? ''
        try {
          const view = await service.worktrees(subscriber.path, controller.signal)
          if (view !== null) {
            worktreeDigest = view.worktrees.map(item => `${item.path}:${item.branch}:${item.head}`).join(',')
            subscriber.lastWorktreeDigest = worktreeDigest
          }
        } catch {
        }
        const key = status === null ? 'no-repo' : `${status.root}|${status.branch}|${status.head}|wt:${worktreeDigest}`
        if (key === subscriber.last) return
        subscriber.last = key
        push(subscriber, { path: subscriber.path, status })
      } catch (error: unknown) {
        if (subscribers.has(subscriber)) {
          ctx.logger.warn(`dsh-web-git-sidebar: status poll failed for ${subscriber.path}: ${String(error)}`)
        }
      } finally {
        if (subscriber.statusAbort === controller) subscriber.statusAbort = undefined
      }
    }))
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isGitAllowed(ctx, req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      res.writeHead(415)
      res.end()
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const payload = await readJsonBody(req, { maxBytes: 1024 * 1024 })
    if (pathname === '/git-sidebar/config') {
      const view = config()
      writeJson(res, 200, isGitFeatureConfig(view) ? OK(view) : FAIL(MALFORMED_VIEW))
      return
    }
    const path = pathOf(payload)
    if (path === null) {
      writeJson(res, 200, FAIL(BAD_REQUEST))
      return
    }
    switch (pathname) {
      case '/git-sidebar/status':
        try {
          okView(res, await statusWithDeadline(path), isRepoStatus)
        } catch (error: unknown) {
          ctx.logger.warn(`dsh-web-git-sidebar: status request failed for ${path}: ${String(error)}`)
          writeJson(res, 200, FAIL({ code: 'internal', message: STATUS_TIMEOUT_MESSAGE }))
        }
        return
      case '/git-sidebar/branches':
        okView(res, await service.branches(path), isBranchesView)
        return
      case '/git-sidebar/graph': {
        const rawLimit = typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>).limit
          : undefined
        const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(rawLimit, 1000) : undefined
        okView(res, await service.graph(path, limit), isGraphView)
        return
      }
      case '/git-sidebar/panel': {
        const rawLimit = typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>).limit
          : undefined
        const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(rawLimit, 1000) : undefined
        try {
          okView(res, await service.panel(path, limit), isPanelView)
        } catch (error: unknown) {
          ctx.logger.warn(`dsh-web-git-sidebar: panel request failed for ${path}: ${String(error)}`)
          writeJson(res, 200, FAIL({ code: 'internal', message: 'git panel request failed' }))
        }
        return
      }
      case '/git-sidebar/switch': {
        const branch = typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>).branch
          : undefined
        if (typeof branch !== 'string' || branch === '') {
          writeJson(res, 200, FAIL(BAD_REQUEST))
          return
        }
        const result = await service.switchBranch(path, branch)
        writeJson(res, 200, result.ok ? OK({ branch: result.branch }) : FAIL(isGitError(result.error) ? result.error : MALFORMED_VIEW))
        return
      }
      case '/git-sidebar/create-branch': {
        const name = typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>).name
          : undefined
        if (typeof name !== 'string' || name === '') {
          writeJson(res, 200, FAIL(BAD_REQUEST))
          return
        }
        const result = await service.createBranch(path, name)
        writeJson(res, 200, result.ok ? OK({ branch: result.branch }) : FAIL(isGitError(result.error) ? result.error : MALFORMED_VIEW))
        return
      }
      case '/git-sidebar/worktrees':
        okView(res, await service.worktrees(path), isWorktreeListView)
        return
      case '/git-sidebar/worktree-add': {
        const record = typeof payload === 'object' && payload !== null
          ? payload as Record<string, unknown>
          : {}
        const name = record.name
        const baseRef = record.baseRef
        if (typeof name !== 'string' || name === ''
          || (baseRef !== undefined && typeof baseRef !== 'string')) {
          writeJson(res, 200, FAIL(BAD_REQUEST))
          return
        }
        const result = await service.addWorktree(path, name, baseRef)
        writeJson(res, 200, result.ok ? OK({ path: result.path, branch: result.branch, name: result.name }) : FAIL(isGitError(result.error) ? result.error : MALFORMED_VIEW))
        return
      }
      case '/git-sidebar/worktree-remove': {
        const record = typeof payload === 'object' && payload !== null
          ? payload as Record<string, unknown>
          : {}
        const worktreePath = record.worktreePath
        if (typeof worktreePath !== 'string' || worktreePath === '') {
          writeJson(res, 200, FAIL(BAD_REQUEST))
          return
        }
        const result = await service.removeWorktree(path, worktreePath, {
          force: record.force === true,
          deleteBranch: record.deleteBranch === true,
        })
        writeJson(res, 200, result.ok ? OK({ removed: true }) : FAIL(isGitError(result.error) ? result.error : MALFORMED_VIEW))
        return
      }
      case '/git-sidebar/commit': {
        const record = typeof payload === 'object' && payload !== null
          ? payload as Record<string, unknown>
          : {}
        const oid = record.oid
        if (typeof oid !== 'string' || oid === '') {
          writeJson(res, 200, FAIL(BAD_REQUEST))
          return
        }
        okView(res, await service.commitDetail(path, oid), isCommitDetail)
        return
      }
      default:
        res.writeHead(404)
        res.end()
    }
  }

  const sse = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isGitAllowed(ctx, req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.searchParams.get('path')
    if (path === null || path === '') {
      res.writeHead(400)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    const subscriber: Subscriber = { path, last: '', res }
    subscribers.add(subscriber)
    res.on('error', () => { removeSubscriber(subscriber) })
    if (guard === undefined) {
      guard = new PollGuard({
        intervalMs: POLL_INTERVAL_MS,
        deadlineMs: POLL_LIFETIME_MS,
        maxBackoffMs: POLL_INTERVAL_MS,
        onRun: runPoll,
      })
    }
    guard.start()
    if (heartbeatTimer === undefined) {
      heartbeatTimer = setInterval(() => {
        for (const current of subscribers) current.res.write(': ping\n\n')
      }, HEARTBEAT_INTERVAL_MS)
    }
    req.on('close', () => { removeSubscriber(subscriber) })
  }

  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/git-sidebar', handler }),
    ctx.webServer.register({ kind: 'exact', path: '/git-sidebar/events', handler: sse }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
    guard?.stop()
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
    for (const subscriber of subscribers) {
      subscriber.statusAbort?.abort(new Error('git status routes disposed'))
      subscriber.res.end()
    }
    subscribers.clear()
  }
}
