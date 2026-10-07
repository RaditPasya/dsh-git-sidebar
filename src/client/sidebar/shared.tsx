import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges `useSessions` and the `mainView` retention key into the
// framework standard props. Without it those seats are untyped, which is why
// this file previously reached for structural casts.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { BranchesView, GraphView, RepoStatus } from '../../core/types.ts'
import { GitApi, subscribeChanges } from '../api.ts'
import type { GitSidebarKey } from './locales.ts'

export const sharedGitApi = new GitApi()

/** Throttles snapshot refreshes triggered by focus / tab-visibility wake-ups. */
export const WAKE_REFRESH_MIN_MS = 5_000

/** The framework seats shared by the main panel and the footer dock. */
export type GitSnapshotProps = Pick<PropsRuntime<'main'>, 'useWorkspaces' | 'useSessions'>

export const GIT_LOCALE_NS = 'dsh-web-git-sidebar' as const

/**
 * The locale seat. `PropsLocale` is keyed by the *namespace*, not by the
 * dictionary key union — passing the key union collapses it to `object` and
 * silently drops `t`.
 */
export type GitLocaleProps = PropsLocale<typeof GIT_LOCALE_NS>

export const token = {
  labelPrimary: 'var(--dsw-alias-label-primary, #e8eaed)',
  labelSecondary: 'var(--dsw-alias-label-secondary, #9aa0a6)',
  border: 'var(--dsw-alias-border-l1, #3c4043)',
  brand: 'var(--dsw-alias-brand-primary, #4c6ef5)',
  success: 'var(--dsw-alias-state-success-primary, #3fb950)',
  warn: 'var(--dsw-alias-state-warn-primary, #d29922)',
  error: 'var(--dsw-alias-state-error-primary, #f85149)',
  hoverBg: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))',
  activeBg: 'var(--dsw-alias-interactive-bg-active, rgba(255,255,255,0.10))',
} as const

const LANE_COLORS = [
  '#8ab4f8', '#c58af9', '#7dd3a8', '#f2b56b', '#f28b82', '#78d9e6', '#e6c56b', '#9aa0a6',
] as const

export function laneColor(index: number): string {
  return LANE_COLORS[index % LANE_COLORS.length] ?? '#9aa0a6'
}

const STYLE_ID = 'dsh-web-git-sidebar-motion'

export function ensureSidebarStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.dataset.plugin = 'dsh-web-git-sidebar'
  tag.textContent = `
.gs-popup-enter { animation: gs-rise 180ms cubic-bezier(0.2, 0, 0.2, 1) both; }
.gs-row-enter { animation: gs-fade-slide 240ms cubic-bezier(0.2, 0, 0.2, 1) both; }
.gs-flash { animation: gs-flash 900ms ease-out; }
.gs-expand { display: grid; grid-template-rows: 1fr; transition: grid-template-rows 180ms ease-out, opacity 180ms ease-out; opacity: 1; }
.gs-expand.gs-collapsed { grid-template-rows: 0fr; opacity: 0; }
.gs-expand > div { overflow: hidden; }
.gs-row { transition: background-color 120ms ease-out, border-color 120ms ease-out, transform 120ms ease-out; }
.gs-row:hover { background-color: ${token.hoverBg}; }
.gs-row:active { background-color: ${token.activeBg}; }
.gs-btn { transition: background-color 120ms ease-out, border-color 120ms ease-out, opacity 120ms ease-out; }
.gs-btn:hover:not(:disabled) { background-color: ${token.hoverBg}; }
.gs-btn:disabled { opacity: 0.55; cursor: default; }
.gs-btn:focus-visible { outline: 2px solid ${token.brand}; outline-offset: 1px; }
.gs-dirty-dot { animation: gs-pulse 2.4s ease-in-out infinite; }
/* Busy indicator for the round sync glyph. */
.gs-spin { animation: gs-rotate 900ms linear infinite; transform-origin: center; }
.gs-dock { container-type: inline-size; }
.gs-branch-light { display: none; }
@container (max-width: 247px) {
  .gs-branch-name { display: none; }
  .gs-branch-light { display: inline; }
}
.gs-skeleton {
  border-radius: 6px;
  background: linear-gradient(90deg, rgba(255,255,255,0.05) 25%, rgba(255,255,255,0.12) 37%, rgba(255,255,255,0.05) 63%);
  background-size: 400% 100%;
  animation: gs-shimmer 1.1s ease-in-out infinite;
}
/* 200 commit rows: skip paint/layout for the offscreen ones. */
.gs-virtual-row { content-visibility: auto; contain-intrinsic-size: auto 34px; }
@keyframes gs-shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
@keyframes gs-rise {
  from { opacity: 0; transform: translateY(10px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes gs-fade-slide {
  from { opacity: 0; transform: translateX(-4px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes gs-flash {
  0% { background-color: ${token.activeBg}; }
  100% { background-color: transparent; }
}
@keyframes gs-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
@keyframes gs-rotate {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .gs-popup-enter, .gs-row-enter, .gs-flash, .gs-dirty-dot, .gs-spin, .gs-skeleton { animation: none; }
  .gs-expand { transition: none; }
  .gs-row, .gs-btn { transition: none; }
}`
  document.head.appendChild(tag)
}

export interface WorkspaceRef {
  id: string
  path: string
  name: string
}

function workspaceSignature(row: { workspaceId: string; path: string; title: string }): string {
  return `${row.workspaceId}|${row.path}|${row.title}`
}

export function useWorkspaceRefs(props: GitSnapshotProps): WorkspaceRef[] {
  const items = props.useWorkspaces((state) => state.items)
  const signature = items.map(workspaceSignature).join('\n')
  return useMemo(
    () => items
      .filter((row) => row.path !== '')
      .map((row) => ({ id: String(row.workspaceId), path: row.path, name: row.title })),
    // `signature` covers every field read below, so it is the correct key.
    [signature],
  )
}

/** cwd of the session currently retained by the main view, if any. */
function useMainViewCwd(props: GitSnapshotProps): string | null {
  const cwd = props.useSessions((state) => {
    for (const row of Object.values(state.byId)) {
      if (row === undefined) continue
      const retained = row.retainedBy['mainView']
      if (typeof retained === 'number' && retained > 0) {
        return typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null
      }
    }
    return null
  })
  return cwd ?? null
}

export function useFollowedWorkspacePath(props: GitSnapshotProps, workspaces: WorkspaceRef[]): string {
  const cwd = useMainViewCwd(props)
  const [followed, setFollowed] = useState<string>('')
  useEffect(() => {
    if (cwd === null) return
    const exact = workspaces.find((workspace) => workspace.path === cwd)
    const match = exact ?? workspaces.find((workspace) =>
      cwd.startsWith(workspace.path.endsWith('/') ? workspace.path : `${workspace.path}/`))
    if (match === undefined) return
    setFollowed((prev) => (prev === match.path ? prev : match.path))
  }, [cwd, workspaces])
  if (followed !== '') return followed
  return workspaces[0]?.path ?? ''
}

export interface SnapshotCacheEntry {
  at: number
  status: RepoStatus | null
  branches: BranchesView | null
  graph: GraphView | null
}

/**
 * A load either produced data, was superseded by a newer invalidation, or
 * genuinely failed. Collapsing "superseded" into "failed" surfaced a bogus
 * error banner whenever two mounted components refreshed for one host event.
 */
export type SnapshotOutcome =
  | { kind: 'entry'; entry: SnapshotCacheEntry }
  | { kind: 'superseded' }
  | { kind: 'failed' }

export interface GitSnapshot {
  status: RepoStatus | null | undefined
  branches: BranchesView | null
  graph: GraphView | null
  error: string | null
  loading: boolean
  refresh: (workspacePath: string) => Promise<SnapshotOutcome>
}

const SNAPSHOT_TTL_MS = 10_000
const MAX_CACHE_ENTRIES = 32

const snapshotCache = new Map<string, SnapshotCacheEntry>()
const snapshotInflight = new Map<string, SnapshotFlight>()
const snapshotEpoch = new Map<string, number>()
const focusThrottle = new Map<string, number>()

interface SnapshotFlight {
  epoch: number
  result: Promise<SnapshotOutcome>
}

function cacheKey(path: string, commitLimit: number): string {
  return `${path}::${commitLimit}`
}

function epochOf(path: string): number {
  return snapshotEpoch.get(path) ?? 0
}

function readCache(key: string): SnapshotCacheEntry | null {
  const entry = snapshotCache.get(key)
  if (entry === undefined) return null
  if (Date.now() - entry.at > SNAPSHOT_TTL_MS) return null
  return entry
}

/** Insertion-ordered LRU so a long session cannot grow the cache forever. */
function remember(key: string, entry: SnapshotCacheEntry): void {
  snapshotCache.delete(key)
  snapshotCache.set(key, entry)
  while (snapshotCache.size > MAX_CACHE_ENTRIES) {
    const oldest = snapshotCache.keys().next()
    if (oldest.done === true) break
    snapshotCache.delete(oldest.value)
  }
}

function invalidateCache(path: string): void {
  const prefix = `${path}::`
  for (const key of [...snapshotCache.keys()]) {
    if (key.startsWith(prefix)) snapshotCache.delete(key)
  }
  snapshotEpoch.set(path, epochOf(path) + 1)
}

async function fetchSnapshot(
  key: string,
  path: string,
  commitLimit: number,
  epoch: number,
): Promise<SnapshotOutcome> {
  const result = await sharedGitApi.panel(path, commitLimit)
  if (!result.ok) return { kind: 'failed' }
  if (epochOf(path) !== epoch) return { kind: 'superseded' }
  const view = result.value
  const entry: SnapshotCacheEntry = view === null
    ? { at: Date.now(), status: null, branches: null, graph: null }
    : { at: Date.now(), status: view.status, branches: view.branches, graph: view.graph }
  remember(key, entry)
  return { kind: 'entry', entry }
}

async function loadSnapshot(path: string, commitLimit: number, force: boolean): Promise<SnapshotOutcome> {
  const key = cacheKey(path, commitLimit)
  const epoch = epochOf(path)
  const running = snapshotInflight.get(key)
  // Join any in-flight request for this epoch. A forced refresh still wants
  // fresh data, and fresh data is exactly what the running request fetches —
  // launching a second one only duplicated the work (and the git processes).
  if (running !== undefined && running.epoch === epoch) return running.result
  if (!force) {
    const warm = readCache(key)
    if (warm !== null) return { kind: 'entry', entry: warm }
  }
  const flight: SnapshotFlight = { epoch, result: fetchSnapshot(key, path, commitLimit, epoch) }
  snapshotInflight.set(key, flight)
  try {
    return await flight.result
  } finally {
    if (snapshotInflight.get(key) === flight) snapshotInflight.delete(key)
  }
}

const pathListeners = new Map<string, Set<() => void>>()
const pathRelayDisposers = new Map<string, () => void>()

/**
 * One host subscription per workspace path, shared by every mounted component.
 * The cache is invalidated exactly once per host event: if each component
 * invalidated separately, the second one would advance the epoch past the
 * first component's in-flight request and force a duplicate fetch.
 */
function subscribePath(path: string, listener: () => void): () => void {
  let listeners = pathListeners.get(path)
  if (listeners === undefined) {
    listeners = new Set<() => void>()
    pathListeners.set(path, listeners)
    pathRelayDisposers.set(path, subscribeChanges(path, () => {
      invalidateCache(path)
      const current = pathListeners.get(path)
      if (current === undefined) return
      for (const active of [...current]) active()
    }))
  }
  listeners.add(listener)
  return () => {
    const current = pathListeners.get(path)
    if (current === undefined) return
    current.delete(listener)
    if (current.size > 0) return
    pathListeners.delete(path)
    focusThrottle.delete(path)
    const dispose = pathRelayDisposers.get(path)
    pathRelayDisposers.delete(path)
    dispose?.()
  }
}

export function useGitSnapshot(
  path: string,
  t: Translate<GitSidebarKey>,
  commitLimit: number,
): GitSnapshot {
  const initialKey = cacheKey(path, commitLimit)
  const [status, setStatus] = useState<RepoStatus | null | undefined>(() => readCache(initialKey)?.status)
  const [branches, setBranches] = useState<BranchesView | null>(() => readCache(initialKey)?.branches ?? null)
  const [graph, setGraph] = useState<GraphView | null>(() => readCache(initialKey)?.graph ?? null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  const applyEntry = useCallback((entry: SnapshotCacheEntry) => {
    setStatus(entry.status)
    setBranches(entry.branches)
    setGraph(entry.graph)
    setError(entry.status === null ? tRef.current('panel.notARepo') : null)
  }, [])

  const applyOutcome = useCallback((outcome: SnapshotOutcome): SnapshotOutcome => {
    if (outcome.kind === 'entry') {
      applyEntry(outcome.entry)
      return outcome
    }
    // A superseded load has a newer request already in flight; it is not an error.
    if (outcome.kind === 'failed') setError(tRef.current('panel.requestFailed'))
    return outcome
  }, [applyEntry])

  const refresh = useCallback(async (workspacePath: string): Promise<SnapshotOutcome> => {
    if (workspacePath === '') return { kind: 'failed' }
    const current = seq.current + 1
    seq.current = current
    setError(null)
    const outcome = await loadSnapshot(workspacePath, commitLimit, true)
    if (seq.current !== current) return outcome
    return applyOutcome(outcome)
  }, [commitLimit, applyOutcome])

  useEffect(() => {
    if (path === '') return undefined
    let live = true
    seq.current += 1
    const current = seq.current
    const warm = readCache(cacheKey(path, commitLimit))
    if (warm !== null) {
      setStatus(warm.status)
      setBranches(warm.branches)
      setGraph(warm.graph)
      setError(warm.status === null ? tRef.current('panel.notARepo') : null)
    } else {
      setStatus(undefined)
      setBranches(null)
      setGraph(null)
    }
    void loadSnapshot(path, commitLimit, false).then((outcome) => {
      if (!live || seq.current !== current) return
      applyOutcome(outcome)
    })
    const unsubscribe = subscribePath(path, () => {
      void refresh(path)
    })
    // Regaining window focus and returning to a visible tab both mean the cached
    // snapshot may be stale. They share one throttle so a tab switch that also
    // raises focus cannot double-fetch.
    const refreshIfDue = (): void => {
      const now = Date.now()
      const last = focusThrottle.get(path) ?? 0
      if (now - last < WAKE_REFRESH_MIN_MS) return
      focusThrottle.set(path, now)
      void refresh(path)
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') refreshIfDue()
    }
    window.addEventListener('focus', refreshIfDue)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      live = false
      unsubscribe()
      window.removeEventListener('focus', refreshIfDue)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [path, commitLimit, refresh, applyOutcome])

  return { status, branches, graph, error, loading: status === undefined, refresh }
}

export function SkeletonRows({ rows, height = 22 }: { rows: number; height?: number }) {
  return (
    <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="gs-skeleton"
          style={{ height, animationDelay: `${index * 70}ms` }}
        />
      ))}
    </div>
  )
}

const authorColors = new Map<string, string>()

export function authorColor(name: string): string {
  const cached = authorColors.get(name)
  if (cached !== undefined) return cached
  let hash = 2166136261
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const color = `hsl(${Math.abs(hash) % 360}, 65%, 65%)`
  if (authorColors.size < 512) authorColors.set(name, color)
  return color
}

export function AuthorTag({ name }: { name: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
      <span aria-hidden="true" style={{ color: authorColor(name), fontSize: 10, lineHeight: 1 }}>●</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
    </span>
  )
}

export function formatRelativeTime(t: Translate<GitSidebarKey>, epochSeconds: number): string {
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds)
  if (elapsed < 60) return t('time.justNow')
  if (elapsed < 3600) return t('time.minutesAgo', { count: Math.floor(elapsed / 60) })
  if (elapsed < 86400) return t('time.hoursAgo', { count: Math.floor(elapsed / 3600) })
  if (elapsed < 30 * 86400) return t('time.daysAgo', { count: Math.floor(elapsed / 86400) })
  return formatDateTime(epochSeconds)
}

export function formatDateTime(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function commitHoverTitle(subject: string, author: string, authorTime: number): string {
  return `${subject}\n${author} · ${formatDateTime(authorTime)}`
}

export function TrackingBadge({ upstream, ahead, behind, gone, t }: {
  upstream?: string
  ahead?: number
  behind?: number
  gone?: boolean
  t: Translate<GitSidebarKey>
}) {
  if (upstream === undefined || upstream === '' || gone === true) {
    return <span style={{ fontSize: 12, color: token.warn, whiteSpace: 'nowrap' }} title={gone === true ? t('panel.upstreamGone') : t('panel.noUpstream')}>● {gone === true ? t('panel.upstreamGone') : t('panel.localOnly')}</span>
  }
  const a = ahead ?? 0
  const b = behind ?? 0
  if (a === 0 && b === 0) return <span style={{ fontSize: 12, color: token.success, whiteSpace: 'nowrap' }}>✓ {t('panel.inSync')}</span>
  return (
    <span style={{ fontSize: 12, opacity: 0.9, whiteSpace: 'nowrap' }} title={upstream}>
      {a > 0 && <span style={{ color: token.warn }}>↑{a}</span>}
      {a > 0 && b > 0 && <span> </span>}
      {b > 0 && <span style={{ color: token.brand }}>↓{b}</span>}
      <span style={{ opacity: 0.7 }}> {upstream}</span>
    </span>
  )
}

export function fileStatusColor(status: string): string {
  if (status === 'A') return token.success
  if (status === 'D') return token.error
  return token.warn
}
