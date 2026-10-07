
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  isCommitDetail, isGitError, isPanelView, isResultPayload,
  type GitError,
} from '../core/types.ts'
import { PollGuard } from './poll-guard.ts'
import { isPairedOrLoopbackAllowed } from './pair-access.ts'
import { readJsonBody, writeJson } from './http.ts'
import { GitTimeoutError, type GitService } from './git-service.ts'

export type GitEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: GitError }

const OK = (value: unknown): GitEnvelope<unknown> => ({ ok: true, value })
const FAIL = (error: GitError): GitEnvelope<never> => ({ ok: false, error })

const BAD_REQUEST: GitError = { code: 'internal', message: 'malformed request' }
const BODY_TOO_LARGE: GitError = { code: 'internal', message: 'request body too large' }

const MALFORMED_VIEW: GitError = { code: 'internal', message: 'malformed git response' }

const BUSY: GitError = {
  code: 'operation-in-progress',
  message: 'another git operation is already running for this workspace',
}

/** Routes that write to the repository; duplicates per workspace are refused. */
const MUTATION_ROUTES = new Set([
  '/git-sidebar/switch',
  '/git-sidebar/create-branch',
  '/git-sidebar/pull',
  '/git-sidebar/fetch',
])

const MAX_SUBSCRIBERS = 100
const MAX_COMMITS = 1000

const POLL_INTERVAL_MS = 30_000
/**
 * Idle ceiling, kept shallow (2x) on purpose: this poll is the only signal for
 * changes the client did not cause, so backing off harder would delay exactly
 * the updates someone is watching for.
 */
const POLL_MAX_INTERVAL_MS = 60_000
const HEARTBEAT_INTERVAL_MS = 15_000

const STATUS_TIMEOUT_MS = 15_000
const STATUS_TIMEOUT_MESSAGE = 'git status timed out'

interface Subscriber {
  path: string
  last: string
  res: ServerResponse
}

function pathOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const path = (payload as Record<string, unknown>).path
  return typeof path === 'string' && path !== '' ? path : null
}

function recordOf(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
}

function limitOf(payload: unknown): number | undefined {
  const raw = recordOf(payload).limit
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_COMMITS) : undefined
}

function okView(res: ServerResponse, value: unknown, guard: (view: unknown) => boolean): void {
  if (value !== null && !guard(value)) {
    writeJson(res, 200, FAIL(MALFORMED_VIEW))
    return
  }
  writeJson(res, 200, OK(value))
}

function okPayload(res: ServerResponse, value: Record<string, string>): void {
  if (!isResultPayload(value)) {
    writeJson(res, 200, FAIL(MALFORMED_VIEW))
    return
  }
  writeJson(res, 200, OK(value))
}

function failEnvelope(error: GitError): GitEnvelope<never> {
  return FAIL(isGitError(error) ? error : MALFORMED_VIEW)
}

/**
 * Bounds a shared operation for *this* response without cancelling it: the
 * underlying flight owns its own deadline and eviction, so one slow waiter
 * cannot tear down an operation other subscribers are still awaiting.
 */
function withDeadline<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    handle = setTimeout(() => { reject(new Error(message)) }, ms)
    handle.unref?.()
  })
  return Promise.race([operation, deadline]).finally(() => {
    if (handle !== undefined) clearTimeout(handle)
  })
}

export function registerGitRoutes(ctx: Context, service: GitService): () => void {
  const subscribers = new Set<Subscriber>()
  const mutationInFlight = new Set<string>()
  let guard: PollGuard | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }

  const removeSubscriber = (subscriber: Subscriber): void => {
    if (!subscribers.delete(subscriber)) return
    if (subscribers.size > 0) return
    guard?.stop()
    guard = undefined
    stopHeartbeat()
  }

  const push = (subscriber: Subscriber, payload: unknown): void => {
    try {
      subscriber.res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch {
      // The socket already went away; drop the subscriber rather than throwing
      // out of the poll tick.
      removeSubscriber(subscriber)
    }
  }

  /**
   * One status probe per subscriber per tick, all settled. A failure or timeout
   * on one workspace must not stop polling for the others, and the tick must
   * always resolve so the guard keeps its cadence.
   *
   * Returns true when at least one subscriber observed a change, which resets
   * the guard's idle backoff.
   */
  const runPoll = async (): Promise<boolean> => {
    const current = [...subscribers]
    const results = await Promise.allSettled(current.map(async (subscriber): Promise<boolean> => {
      if (!subscribers.has(subscriber)) return false
      const status = await withDeadline(
        service.status(subscriber.path),
        STATUS_TIMEOUT_MS,
        STATUS_TIMEOUT_MESSAGE,
      )
      const key = status === null
        ? 'no-repo'
        : [
          status.root, status.branch, status.head,
          status.dirtyFiles, status.untrackedFiles, status.conflicts, status.operationInProgress,
        ].join('|')
      if (key === subscriber.last) return false
      subscriber.last = key
      push(subscriber, { path: subscriber.path, status })
      return true
    }))
    let changed = false
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value) changed = true
      } else {
        ctx.logger.warn(`dsh-web-git-sidebar: status poll failed: ${String(result.reason)}`)
      }
    }
    return changed
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!isPairedOrLoopbackAllowed(ctx, req)) {
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
      const body = await readJsonBody(req)
      if (!body.ok) {
        if (body.reason === 'too-large') {
          writeJson(res, 413, FAIL(BODY_TOO_LARGE))
          return
        }
        writeJson(res, 400, FAIL(BAD_REQUEST))
        return
      }
      const payload = body.value
      const path = pathOf(payload)
      if (path === null) {
        writeJson(res, 400, FAIL(BAD_REQUEST))
        return
      }
      // Coalesce duplicate mutations: a repeated pull/fetch/switch on the same
      // workspace would otherwise stack git processes and fight over the index.
      const isMutation = MUTATION_ROUTES.has(pathname)
      const flightKey = `${pathname}::${path}`
      if (isMutation && mutationInFlight.has(flightKey)) {
        writeJson(res, 429, FAIL(BUSY))
        return
      }
      if (isMutation) mutationInFlight.add(flightKey)
      try {
        switch (pathname) {
          case '/git-sidebar/panel':
            okView(res, await service.panel(path, limitOf(payload)), isPanelView)
            return
          case '/git-sidebar/switch': {
            const branch = recordOf(payload).branch
            if (typeof branch !== 'string' || branch === '') {
              writeJson(res, 400, FAIL(BAD_REQUEST))
              return
            }
            const result = await service.switchBranch(path, branch)
            if (result.ok) okPayload(res, { branch: result.branch })
            else writeJson(res, 200, failEnvelope(result.error))
            return
          }
          case '/git-sidebar/create-branch': {
            const name = recordOf(payload).name
            if (typeof name !== 'string' || name === '') {
              writeJson(res, 400, FAIL(BAD_REQUEST))
              return
            }
            const result = await service.createBranch(path, name)
            if (result.ok) okPayload(res, { branch: result.branch })
            else writeJson(res, 200, failEnvelope(result.error))
            return
          }
          case '/git-sidebar/pull': {
            const result = await service.pull(path)
            if (result.ok) okPayload(res, { output: result.output })
            else writeJson(res, 200, failEnvelope(result.error))
            return
          }
          case '/git-sidebar/fetch': {
            const result = await service.fetch(path)
            if (result.ok) okPayload(res, { output: result.output })
            else writeJson(res, 200, failEnvelope(result.error))
            return
          }
          case '/git-sidebar/commit': {
            const oid = recordOf(payload).oid
            if (typeof oid !== 'string' || oid === '') {
              writeJson(res, 400, FAIL(BAD_REQUEST))
              return
            }
            okView(res, await service.commitDetail(path, oid), isCommitDetail)
            return
          }
          default:
            res.writeHead(404)
            res.end()
        }
      } finally {
        if (isMutation) mutationInFlight.delete(flightKey)
      }
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-web-git-sidebar: route failed: ${String(error)}`)
      if (res.headersSent) {
        res.end()
        return
      }
      const failure: GitError = error instanceof GitTimeoutError
        ? { code: 'timeout', message: error.message }
        : { code: 'internal', message: 'git route failed' }
      writeJson(res, error instanceof GitTimeoutError ? 504 : 500, FAIL(failure))
    }
  }

  const sse = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!isPairedOrLoopbackAllowed(ctx, req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      const rawPath = new URL(req.url ?? '/', 'http://x').searchParams.get('path')
      if (rawPath === null || rawPath === '') {
        res.writeHead(400)
        res.end()
        return
      }
      if (subscribers.size >= MAX_SUBSCRIBERS) {
        res.writeHead(429)
        res.end()
        return
      }
      const path = await service.gatePath(rawPath)
      if (path === null) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 2000\n\n')
      const subscriber: Subscriber = { path, last: '', res }
      subscribers.add(subscriber)
      res.on('error', () => { removeSubscriber(subscriber) })
      res.on('close', () => { removeSubscriber(subscriber) })
      req.on('close', () => { removeSubscriber(subscriber) })
      if (guard === undefined) {
        guard = new PollGuard({
          intervalMs: POLL_INTERVAL_MS,
          maxIntervalMs: POLL_MAX_INTERVAL_MS,
          onRun: runPoll,
        })
      }
      guard.start()
      if (heartbeatTimer === undefined) {
        heartbeatTimer = setInterval(() => {
          for (const current of subscribers) {
            try {
              current.res.write(': ping\n\n')
            } catch {
              removeSubscriber(current)
            }
          }
        }, HEARTBEAT_INTERVAL_MS)
        heartbeatTimer.unref?.()
      }
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-web-git-sidebar: events route failed: ${String(error)}`)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  }

  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/git-sidebar', handler }),
    ctx.webServer.register({ kind: 'exact', path: '/git-sidebar/events', handler: sse }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
    guard?.stop()
    guard = undefined
    stopHeartbeat()
    for (const subscriber of subscribers) subscriber.res.end()
    subscribers.clear()
  }
}
