import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommitDetail } from '../../core/types.ts'
import { sharedGitApi } from './shared.tsx'
import {
  AuthorTag,
  SkeletonRows,
  commitHoverTitle,
  ensureSidebarStyles,
  fileStatusColor,
  formatDateTime,
  formatRelativeTime,
  token,
  useFollowedWorkspacePath,
  useGitSnapshot,
  useWorkspaceRefs,
} from './shared.tsx'
import type { GitSidebarKey } from './locales.ts'
import {
  getFooterPopupSnapshot,
  subscribeFooterPopup,
} from './footer-popup-state.ts'

export interface GitFooterActionInject {
  openGit: () => void
}

export type GitFooterActionProps =
  PropsRuntime<'sidebar.footer.action'> & PropsLocale<GitSidebarKey> & GitFooterActionInject

export function GitFooterAction(props: GitFooterActionProps) {
  const wide = (props as unknown as { wide?: boolean }).wide ?? false
  const t = (props as unknown as { t: (key: string, params?: Record<string, unknown>) => string }).t
  const workspaces = useWorkspaceRefs(props)
  const firstPath = useFollowedWorkspacePath(props, workspaces)
  const followedName = workspaces.find((w) => w.path === firstPath)?.name ?? ''

  const navError = useSyncExternalStore(
    subscribeFooterPopup,
    () => getFooterPopupSnapshot().navError,
    () => getFooterPopupSnapshot().navError,
  )

  const { status, branches, graph, error, loading, refresh } = useGitSnapshot(firstPath, t, 200)
  const [busy, setBusy] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [detailOid, setDetailOid] = useState<string | null>(null)
  const [detail, setDetail] = useState<CommitDetail | null | undefined>(undefined)
  const [collapsed, setCollapsed] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pullTone, setPullTone] = useState<'conflict' | 'failed' | null>(null)
  const [fetching, setFetching] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'info' | 'error' } | null>(null)

  const [dockHeight, setDockHeight] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('dsh-web-git-sidebar.dockHeight')
      const parsed = raw !== null ? Number(raw) : NaN
      if (Number.isFinite(parsed)) return Math.min(640, Math.max(140, parsed))
    } catch {
    }
    return 320
  })
  const detailReq = useRef<string | null>(null)
  const detailPath = useRef<string>('')
  const dragStart = useRef<{ y: number; height: number } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    ensureSidebarStyles()
    return () => {
      window.clearTimeout(toastTimer.current)
    }
  }, [])

  useEffect(() => {
    detailReq.current = null
    detailPath.current = ''
    setDetailOid(null)
    setDetail(undefined)
    setLocalError(null)
    setPickerOpen(false)
    setPullTone(null)
    window.clearTimeout(toastTimer.current)
    setToast(null)
  }, [firstPath])

  useEffect(() => {
    try {
      localStorage.setItem('dsh-web-git-sidebar.dockHeight', String(dockHeight))
    } catch {
    }
  }, [dockHeight])

  useEffect(() => {
    if (!pickerOpen) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPickerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [pickerOpen])

  if (firstPath === '') return null

  const label = status !== undefined && status !== null && status.branch !== '' ? status.branch : (status !== undefined && status !== null && status.head !== '' ? status.head : t('panel'))
  const dirty = (status?.dirtyFiles ?? 0) + (status?.untrackedFiles ?? 0) > 0
  const conflicted = (status?.conflicts ?? 0) > 0
  const stateLabel = conflicted ? `${label}, ${t('dock.stateConflict')}` : (dirty ? `${label}, ${t('dock.stateDirty')}` : label)

  if (status === undefined || status === null) {
    return (
      <div
        data-dsh-plugin="dsh-web-git-sidebar"
        data-dsh-part="footer-dock"
        style={slimDock}
      >
        {status === undefined && <SkeletonRows rows={1} height={16} />}
        {status === null && <span style={slimText}>{t('panel.notARepo')}</span>}
      </div>
    )
  }

  if (!wide) {
    return (
      <button
        type="button"
        onClick={() => { props.openGit() }}
        title={stateLabel}
        aria-label={stateLabel}
        className="gs-btn"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: 'transparent',
          color: 'inherit',
          border: 0,
          cursor: 'pointer',
          padding: 6,
          borderRadius: 6,
          fontSize: 13,
          maxWidth: '100%',
        }}
      >
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="4.5" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="4.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="11.5" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M4.5 6v4M4.5 8c0-1.5 2-1.2 3.4-1.6 1-.3 1.9-.8 2.2-1.9"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
        {conflicted && <span aria-hidden="true" style={{ color: token.error }}>⚠</span>}
        {dirty && !conflicted && <span aria-hidden="true" className="gs-dirty-dot" style={{ color: token.warn }}>●</span>}
      </button>
    )
  }

  const list = branches?.branches ?? []
  const currentName = list.find((b) => b.current)?.name ?? (status.branch !== '' ? status.branch : '')
  const currentUpstream = list.find((b) => b.current)?.upstream ?? ''
  const currentBehind = list.find((b) => b.current)?.behind ?? 0
  const branchName = currentName !== '' ? currentName : label
  const branchTitle = conflicted ? `${branchName} · ${t('dock.stateConflict')}` : (dirty ? `${branchName} · ${t('dock.stateDirty')}` : branchName)
  const pullColor = pullTone === 'failed'
    ? token.error
    : pullTone === 'conflict'
      ? PULL_ORANGE
      : currentBehind > 0
        ? token.success
        : token.labelSecondary
  const needsPull = currentBehind > 0


  const showToast = (text: string, tone: 'ok' | 'info' | 'error'): void => {
    window.clearTimeout(toastTimer.current)
    setToast({ text, tone })
    toastTimer.current = window.setTimeout(() => {
      setToast(null)
    }, 2600)
  }

  const switchTo = async (branch: string) => {
    if (firstPath === '' || busy !== null) return
    setBusy(branch)
    setLocalError(null)
    try {
      const result = await sharedGitApi.switchBranch(firstPath, branch)
      if (!result.ok) {
        setLocalError(result.error.message)
        return
      }
      setPickerOpen(false)
      setPullTone(null)
      await refresh(firstPath)
    } finally {
      setBusy(null)
    }
  }

  const syncNow = async () => {
    if (firstPath === '' || busy !== null || pulling || fetching) return
    if (!needsPull) {
      setFetching(true)
      setLocalError(null)
      try {
        const result = await sharedGitApi.fetch(firstPath)
        if (!result.ok) {
          setLocalError(result.error.message)
          showToast(result.error.message, 'error')
          return
        }
        const entry = await refresh(firstPath)
        if (entry === null) {
          showToast(t('panel.requestFailed'), 'error')
          return
        }
        const behind = entry.branches?.branches.find((b) => b.current)?.behind ?? 0
        showToast(behind > 0 ? t('dock.behind', { count: behind }) : t('dock.noUpstreamChanges'), behind > 0 ? 'info' : 'ok')
        return
      } finally {
        setFetching(false)
      }
    }
    setPulling(true)
    setLocalError(null)
    const before = currentBehind
    try {
      const result = await sharedGitApi.pull(firstPath)
      if (!result.ok) {
        const message = result.error.message
        setLocalError(message)
        setPullTone(/conflict|fast-forward|diverge|overwrit|stash/i.test(message) ? 'conflict' : 'failed')
        showToast(message, 'error')
        return
      }
      setPullTone(null)
      await refresh(firstPath)
      showToast(before > 0 ? t('dock.pulled', { count: before }) : t('dock.upToDate'), 'ok')
    } finally {
      setPulling(false)
    }
  }

  const openCommit = async (oid: string) => {
    if (detailOid === oid) {
      detailReq.current = null
      setDetailOid(null)
      return
    }
    const requestPath = firstPath
    detailReq.current = oid
    detailPath.current = requestPath
    setDetailOid(oid)
    setDetail(undefined)
    const result = await sharedGitApi.commit(requestPath, oid)
    if (detailReq.current !== oid || detailPath.current !== requestPath) return
    setDetail(result.ok ? result.value : null)
  }

  return (
    <div
      data-dsh-plugin="dsh-web-git-sidebar"
      data-dsh-part="footer-dock"
      className="gs-dock"
      style={{
        width: '100%',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #e8eaed)',
        borderTop: `1px solid ${token.border}`,
        position: 'relative',
      }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-hidden="true"
        onPointerDown={(e) => {
          dragStart.current = { y: e.clientY, height: dockHeight }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const start = dragStart.current
          if (start === null) return
          setDockHeight(Math.min(640, Math.max(140, start.height + (start.y - e.clientY))))
        }}
        onPointerUp={() => { dragStart.current = null }}
        onPointerCancel={() => { dragStart.current = null }}
        style={{ height: 6, cursor: 'ns-resize', touchAction: 'none', flex: 'none' }}
      />
      <div
        className="gs-btn"
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderRadius: 8 }}
      >
        <button
          type="button"
          onClick={() => { setCollapsed((v) => !v) }}
          className="gs-btn"
          style={chevronButton}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('popup.title') : t('popup.close')}
          title={collapsed ? label : t('popup.close')}
        >
          <span aria-hidden="true" style={{ fontSize: 12, lineHeight: 1, opacity: 0.8, display: 'inline-block', transition: 'transform 180ms ease-out', transform: collapsed ? 'rotate(-90deg)' : 'none' }}>
            {'▾'}
          </span>
        </button>
        <strong style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={firstPath}>
          {followedName !== '' ? followedName.split('/').filter(Boolean).pop() ?? followedName : t('popup.title')}
        </strong>
        {conflicted && <span aria-hidden="true" style={{ color: token.error, fontSize: 12 }}>⚠</span>}
        {!collapsed && (
          <button
            type="button"
            onClick={() => { setPickerOpen((v) => !v) }}
            className="gs-btn"
            style={branchButton}
            title={branchTitle}
            aria-expanded={pickerOpen}
            aria-haspopup="listbox"
          >
            <span className="gs-branch-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{branchName}</span>
            <span className="gs-branch-light" aria-hidden="true" style={{ color: conflicted ? token.error : (dirty ? token.warn : token.success), fontSize: 11 }}>●</span>
          </button>
        )}
        {collapsed && dirty && !conflicted && <span aria-hidden="true" className="gs-dirty-dot" style={{ color: token.warn, fontSize: 12 }}>●</span>}
        {!collapsed && (
          <button
            type="button"
            onClick={() => { void syncNow() }}
            disabled={pulling || fetching || busy !== null || currentUpstream === ''}
            className="gs-btn"
            style={{ ...iconButton, color: needsPull ? pullColor : token.labelSecondary }}
            title={fetching ? t('dock.fetching') : (pulling ? t('dock.pulling') : (currentUpstream === '' ? t('panel.noUpstream') : (needsPull ? t('dock.pull') : t('dock.fetch'))))}
            aria-label={needsPull ? t('dock.pull') : t('dock.fetch')}
          >
            <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={(pulling || fetching) ? 'gs-dirty-dot' : undefined} style={{ display: needsPull ? undefined : 'none' }}>
              <path d="M7 1.8v7.2M4.3 6.4 7 9.2l2.7-2.8M2.5 11.8h9" />
            </svg>
            <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={(pulling || fetching) ? 'gs-dirty-dot' : undefined} style={{ display: needsPull ? 'none' : undefined }}>
              <path d="M12 7A5 5 0 1 1 7 2c1.8 0 3.4.9 4.3 2.3M11.5 1.5v3h-3" />
            </svg>
          </button>
        )}
        {!collapsed && (
          <button
            type="button"
            onClick={() => { props.openGit() }}
            className="gs-btn"
            style={iconButton}
            title={t('popup.openFull')}
            aria-label={t('popup.openFull')}
          >
            <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 5.2V2h3.2M8.8 2H12v3.2M12 8.8V12H8.8M5.2 12H2V8.8" />
            </svg>
          </button>
        )}
      </div>
      {toast !== null && (
        <div role="status" className="gs-popup-enter" style={toastStyle}>
          <span style={{ color: toast.tone === 'error' ? token.error : (toast.tone === 'ok' ? token.success : token.labelPrimary) }}>{toast.text}</span>
        </div>
      )}
      {pickerOpen && !collapsed && (
        <div role="listbox" aria-label={t('panel.branches')} style={pickerStyle}>
          <div style={sectionTitle}>{t('panel.branches')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 200, overflow: 'auto' }}>
            {loading && <SkeletonRows rows={3} />}
            {!loading && list.map((b) => {
              const a = b.ahead ?? 0
              const d = b.behind ?? 0
              const suffix = (b.upstream === undefined || b.upstream === '' || b.gone === true)
                ? ` · ${(b.gone === true ? t('panel.upstreamGone') : t('panel.localOnly'))}`
                : (a === 0 && d === 0 ? '' : ` · ↑${a} ↓${d}`)
              return (
                <button
                  key={b.name}
                  type="button"
                  role="option"
                  aria-selected={b.current}
                  disabled={busy !== null}
                  onClick={() => void switchTo(b.name)}
                  className="gs-btn gs-row"
                  style={b.current ? { ...pickerRow, ...pickerRowCurrent } : pickerRow}
                  title={b.upstream ?? b.name}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {b.current ? '✓ ' : ''}{b.name}{suffix}
                  </span>
                </button>
              )
            })}
            {!loading && list.length === 0 && <div style={emptyStyle}>{t('panel.noBranches')}</div>}
          </div>
        </div>
      )}
      <div className={`gs-expand${collapsed ? ' gs-collapsed' : ''}`} aria-hidden={collapsed}>
        <div>
          <div style={{ overflow: 'auto', padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 10, height: dockHeight, minHeight: 0 }}>
          {(localError ?? error) !== null && <div style={{ color: token.error, fontSize: 12 }}>{localError ?? error}</div>}
          {navError !== null && <div style={{ color: token.error, fontSize: 12 }}>{t('popup.navFailed')}: {navError}</div>}

          <section>
            <div style={sectionTitle}>{t('popup.recentCommits')}</div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {loading && <SkeletonRows rows={4} height={30} />}
              {!loading && (graph?.commits ?? []).slice(0, 30).map((c) => {
                const loaded = detailOid === c.oid && detail !== undefined && detail !== null && detail.oid === c.oid
                return (
                  <div key={c.oid} style={{ borderBottom: `1px solid ${token.border}`, padding: '5px 0' }}>
                    <button
                      type="button"
                      onClick={() => void openCommit(c.oid)}
                      className="gs-btn gs-row"
                      style={commitButton}
                      aria-expanded={detailOid === c.oid}
                      title={loaded && detail
                        ? `${c.subject}\n${detail.author} · ${formatDateTime(detail.authorTime)}\n+${detail.insertions} −${detail.deletions}${detail.body !== undefined ? `\n\n${detail.body}` : ''}`
                        : commitHoverTitle(c.subject, c.author, c.authorTime)}
                    >
                      <span style={{ fontFamily: 'monospace', opacity: 0.65, fontSize: 11 }}>{c.oid.slice(0, 7)}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {c.subject}
                      </span>
                    </button>
                    <div style={{ fontSize: 11, color: token.labelSecondary, marginLeft: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <AuthorTag name={c.author} />
                      <span>· {formatRelativeTime(t, c.authorTime)}</span>
                    </div>
                    <div className={`gs-expand${detailOid === c.oid ? '' : ' gs-collapsed'}`} aria-hidden={detailOid !== c.oid}>
                      <div>
                        {detailOid === c.oid && (
                          <div style={{ margin: '4px 0 4px 2px', fontSize: 12 }}>
                            {detail === undefined && <div>{t('panel.loadingCommit')}</div>}
                            {detail === null && <div>{t('panel.commitFailed')}</div>}
                            {detail !== undefined && detail !== null && (
                              <>
                                <div style={{ opacity: 0.85, marginBottom: 4 }}>
                                  {detail.author} · {formatDateTime(detail.authorTime)}
                                </div>
                                {detail.body !== undefined && (
                                  <div style={{ whiteSpace: 'pre-wrap', opacity: 0.85, marginBottom: 4 }}>{detail.body}</div>
                                )}
                                <div style={{ opacity: 0.75, marginBottom: 4 }}>
                                  {t('panel.filesChanged', { count: detail.filesChanged })} ·{' '}
                                  <span style={{ color: token.success }}>+{detail.insertions}</span>{' '}
                                  <span style={{ color: token.error }}>−{detail.deletions}</span>
                                </div>
                                {detail.files.slice(0, 8).map((f) => (
                                  <div key={f.path} style={{ display: 'flex', gap: 6, padding: '1px 0' }}>
                                    <span style={{ width: 14, fontWeight: 700, color: fileStatusColor(f.status) }}>{f.status}</span>
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>{f.path}</span>
                                  </div>
                                ))}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
              {!loading && (graph?.commits.length ?? 0) === 0 && <div style={emptyStyle}>{t('panel.noCommits')}</div>}
            </div>
          </section>
          </div>
        </div>
      </div>
    </div>
  )
}

const sectionTitle: Record<string, string | number> = { fontWeight: 700, fontSize: 12, marginBottom: 6 }
const branchButton: Record<string, string | number> = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px', cursor: 'pointer', background: 'transparent', color: 'inherit', border: `1px solid ${token.border}`, borderRadius: 6, fontSize: 12, fontWeight: 700, maxWidth: '45%', minWidth: 0 }
const pickerStyle: Record<string, string | number> = { position: 'absolute', top: 42, left: 8, right: 8, zIndex: 5, background: 'var(--dsw-specific-input-major, #131518)', border: `1px solid ${token.border}`, borderRadius: 8, boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,0.55))', padding: 8 }
const pickerRow: Record<string, string | number> = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '5px 6px', cursor: 'pointer', background: 'transparent', color: 'inherit', border: '1px solid transparent', borderRadius: 6, textAlign: 'left', fontSize: 13, width: '100%', boxSizing: 'border-box' }
const pickerRowCurrent: Record<string, string | number> = { borderColor: token.brand, fontWeight: 700, backgroundColor: token.activeBg }
const PULL_ORANGE = '#e8833c'
const toastStyle: Record<string, string | number> = { position: 'absolute', top: 40, left: 8, right: 8, zIndex: 6, textAlign: 'center', fontSize: 12, padding: '6px 8px', background: 'var(--dsw-specific-input-major, #131518)', color: 'var(--dsw-alias-label-primary, #e8eaed)', border: `1px solid ${token.border}`, borderRadius: 8, boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,0.55))', pointerEvents: 'none' }
const emptyStyle: Record<string, string | number> = { opacity: 0.6, fontSize: 12, padding: 6 }
const commitButton: Record<string, string | number> = { display: 'flex', gap: 6, alignItems: 'baseline', width: '100%', background: 'transparent', color: 'inherit', border: 0, cursor: 'pointer', textAlign: 'left', padding: 0, fontSize: 13, borderRadius: 4 }
const iconButton: Record<string, string | number> = { background: 'transparent', color: 'inherit', border: 0, cursor: 'pointer', padding: 4, borderRadius: 6, display: 'inline-flex', alignItems: 'center', opacity: 0.8 }
const chevronButton: Record<string, string | number> = { background: 'transparent', color: 'inherit', border: 0, cursor: 'pointer', fontSize: 12, padding: 2, lineHeight: 1, borderRadius: 4 }
const slimDock: Record<string, string | number> = { width: '100%', minWidth: 0, display: 'flex', alignItems: 'center', padding: '8px 10px', color: 'var(--dsw-alias-label-primary, #e8eaed)', fontSize: 12, opacity: 0.75 }
const slimText: Record<string, string | number> = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
