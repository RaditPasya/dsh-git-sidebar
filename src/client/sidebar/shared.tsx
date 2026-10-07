import { useCallback, useEffect, useRef, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { BranchesView, GraphView, RepoStatus } from '../../core/types.ts'
import { GitApi, subscribeChanges } from '../api.ts'
import type { GitSidebarKey } from './locales.ts'

export const sharedGitApi = new GitApi()

export const FOCUS_REFRESH_MIN_MS = 5_000

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
@media (prefers-reduced-motion: reduce) {
  .gs-popup-enter, .gs-row-enter, .gs-flash, .gs-dirty-dot, .gs-skeleton { animation: none; }
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

export function useWorkspaceRefs(props: unknown): WorkspaceRef[] {
  const maybeHook = (props as { useWorkspaces?: (sel: (s: unknown) => unknown) => unknown }).useWorkspaces
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const items = typeof maybeHook === 'function'
    ? (maybeHook as (sel: (s: unknown) => unknown) => unknown)((s: unknown) => {
      const record = s as { items?: Array<Record<string, unknown>> }
      return record.items ?? []
    })
    : []
  const list = (items ?? []) as Array<Record<string, unknown>>
  const fingerprint = list.map((w) => [w['workspaceId'], w['id'], w['path'], w['name']].join('|')).join('\n')
  const [refs, setRefs] = useState<WorkspaceRef[]>(() => toRefs(list))
  useEffect(() => {
    setRefs(toRefs(list))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint])
  return refs
}

function toRefs(list: Array<Record<string, unknown>>): WorkspaceRef[] {
  return list
    .map((w) => ({
      id: String(w['workspaceId'] ?? w['id'] ?? w['path'] ?? ''),
      path: String(w['path'] ?? ''),
      name: String(w['name'] ?? w['path'] ?? ''),
    }))
    .filter((w) => w.path !== '')
}

function useMainViewCwd(props: unknown): string | null {
  const maybeHook = (props as { useSessions?: (sel: (s: unknown) => unknown) => unknown }).useSessions
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const cwd = typeof maybeHook === 'function'
    ? (maybeHook as (sel: (s: unknown) => unknown) => unknown)((s: unknown) => {
      const byId = (s as { byId?: Record<string, { cwd?: unknown; retainedBy?: Record<string, unknown> }> }).byId ?? {}
      for (const row of Object.values(byId)) {
        if (row === undefined) continue
        const retained = ((row.retainedBy ?? {}) as Record<string, unknown>)['mainView']
        if (typeof retained === 'number' && retained > 0) {
          return typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null
        }
      }
      return null
    })
    : null
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

export function useFollowedWorkspacePath(props: unknown, workspaces: WorkspaceRef[]): string {
  const cwd = useMainViewCwd(props)
  const [followed, setFollowed] = useState<string>('')
  useEffect(() => {
    if (cwd === null) return
    const exact = workspaces.find((w) => w.path === cwd)
    if (exact !== undefined) {
      setFollowed((prev) => (prev === exact.path ? prev : exact.path))
      return
    }
    const parent = workspaces.find((w) => cwd.startsWith(w.path.endsWith('/') ? w.path : `${w.path}/`))
    if (parent !== undefined) {
      setFollowed((prev) => (prev === parent.path ? prev : parent.path))
    }
  }, [cwd, workspaces])
  if (followed !== '') return followed
  return workspaces[0]?.path ?? ''
}

export interface GitSnapshot {
  status: RepoStatus | null | undefined
  branches: BranchesView | null
  graph: GraphView | null
  error: string | null
  loading: boolean
  refresh: (workspacePath: string) => Promise<SnapshotCacheEntry | null>
}

export interface SnapshotCacheEntry {
  at: number
  status: RepoStatus | null
  branches: BranchesView | null
  graph: GraphView | null
}

const snapshotCache = new Map<string, SnapshotCacheEntry>()
const snapshotInflight = new Map<string, Promise<SnapshotCacheEntry | null>>()
const snapshotEpoch = new Map<string, number>()
const focusThrottle = new Map<string, number>()

const SNAPSHOT_TTL_MS = 10_000

function cacheKey(path: string, commitLimit: number): string {
  return `${path}::${commitLimit}`
}

function epochOf(path: string): number {
  return snapshotEpoch.get(path) ?? 0
}

function readCache(path: string, commitLimit: number): SnapshotCacheEntry | null {
  const entry = snapshotCache.get(cacheKey(path, commitLimit))
  if (entry === undefined) return null
  if (Date.now() - entry.at > SNAPSHOT_TTL_MS) return null
  return entry
}

function invalidateCache(path: string): void {
  const prefix = `${path}::`
  for (const key of [...snapshotCache.keys()]) {
    if (key.startsWith(prefix)) snapshotCache.delete(key)
  }
  snapshotEpoch.set(path, epochOf(path) + 1)
}

async function loadSnapshot(path: string, commitLimit: number, force: boolean): Promise<SnapshotCacheEntry | null> {
  const key = cacheKey(path, commitLimit)
  if (!force) {
    const warm = readCache(path, commitLimit)
    if (warm !== null) return warm
    const running = snapshotInflight.get(key)
    if (running !== undefined) return running
  }
  const epoch = epochOf(path)
  const flight = (async (): Promise<SnapshotCacheEntry | null> => {
    const res = await sharedGitApi.panel(path, commitLimit)
    if (!res.ok) return null
    if (epochOf(path) !== epoch) return null
    const view = res.value
    if (view === null) {
      const entry: SnapshotCacheEntry = { at: Date.now(), status: null, branches: null, graph: null }
      snapshotCache.set(key, entry)
      return entry
    }
    const entry: SnapshotCacheEntry = {
      at: Date.now(),
      status: view.status,
      branches: view.branches,
      graph: view.graph,
    }
    snapshotCache.set(key, entry)
    return entry
  })()
  snapshotInflight.set(key, flight)
  try {
    return await flight
  } finally {
    if (snapshotInflight.get(key) === flight) snapshotInflight.delete(key)
  }
}

export function useGitSnapshot(
  path: string,
  t: Translate<GitSidebarKey>,
  commitLimit: number,
): GitSnapshot {
  const [status, setStatus] = useState<RepoStatus | null | undefined>(() => readCache(path, commitLimit)?.status)
  const [branches, setBranches] = useState<BranchesView | null>(() => readCache(path, commitLimit)?.branches ?? null)
  const [graph, setGraph] = useState<GraphView | null>(() => readCache(path, commitLimit)?.graph ?? null)
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

  const refresh = useCallback(async (workspacePath: string): Promise<SnapshotCacheEntry | null> => {
    if (workspacePath === '') return null
    const current = seq.current + 1
    seq.current = current
    setError(null)
    const entry = await loadSnapshot(workspacePath, commitLimit, true)
    if (seq.current !== current) return entry
    if (entry === null) {
      setError(tRef.current('panel.requestFailed'))
      return null
    }
    applyEntry(entry)
    return entry
  }, [commitLimit, applyEntry])

  useEffect(() => {
    if (path === '') return undefined
    let live = true
    seq.current += 1
    const current = seq.current
    const warm = readCache(path, commitLimit)
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
    void loadSnapshot(path, commitLimit, false).then((entry) => {
      if (!live || seq.current !== current) return
      if (entry === null) {
        setError(tRef.current('panel.requestFailed'))
        return
      }
      applyEntry(entry)
    }).catch(() => {
      if (!live || seq.current !== current) return
      setError(tRef.current('panel.requestFailed'))
    })
    const unsubscribe = subscribeChanges(path, () => {
      invalidateCache(path)
      void refresh(path)
    })
    const onFocus = (): void => {
      const now = Date.now()
      const last = focusThrottle.get(path) ?? 0
      if (now - last < FOCUS_REFRESH_MIN_MS) return
      focusThrottle.set(path, now)
      void refresh(path)
    }
    window.addEventListener('focus', onFocus)
    return () => {
      live = false
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [path, commitLimit, refresh])

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

export function authorColor(name: string): string {
  let hash = 2166136261
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 65%, 65%)`
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
