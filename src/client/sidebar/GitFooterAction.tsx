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
  const dragStart = useRef<{ y: number; height: number } | null>(null)

  useEffect(() => {
    ensureSidebarStyles()
  }, [])

  useEffect(() => {
    detailReq.current = null
    setDetailOid(null)
    setDetail(undefined)
    setLocalError(null)
  }, [firstPath])

  useEffect(() => {
    try {
      localStorage.setItem('dsh-web-git-sidebar.dockHeight', String(dockHeight))
    } catch {
    }
  }, [dockHeight])

  if (firstPath === '') return null
  if (status === undefined || status === null) return null

  const label = status.branch !== '' ? status.branch : (status.head !== '' ? status.head : t('panel'))
  const dirty = status.dirtyFiles + status.untrackedFiles > 0
  const conflicted = status.conflicts > 0

  if (!wide) {
    return (
      <button
        type="button"
        onClick={() => { props.openGit() }}
        title={label}
        aria-label={label}
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

  const switchTo = async (branch: string) => {
    if (firstPath === '' || busy !== null) return
    setBusy(branch)
    setLocalError(null)
    const result = await sharedGitApi.switchBranch(firstPath, branch)
    setBusy(null)
    if (!result.ok) {
      setLocalError(result.error.message)
      return
    }
    await refresh(firstPath)
  }

  const openCommit = async (oid: string) => {
    if (detailOid === oid) {
      detailReq.current = null
      setDetailOid(null)
      return
    }
    detailReq.current = oid
    setDetailOid(oid)
    setDetail(undefined)
    const result = await sharedGitApi.commit(firstPath, oid)
    if (detailReq.current !== oid) return
    setDetail(result.ok ? result.value : null)
  }

  return (
    <div
      data-dsh-plugin="dsh-web-git-sidebar"
      data-dsh-part="footer-dock"
      style={{
        width: '100%',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#181b20',
        color: 'var(--dsw-alias-label-primary, #e8eaed)',
        borderTop: `1px solid ${token.border}`,
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
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('popup.title') : t('popup.close')}
        title={collapsed ? label : t('popup.close')}
        onClick={() => { setCollapsed((v) => !v) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed((v) => !v) } }}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', cursor: 'pointer' }}
      >
        <span aria-hidden="true" style={{ fontSize: 12, lineHeight: 1, opacity: 0.8, display: 'inline-block', transition: 'transform 180ms ease-out', transform: collapsed ? 'rotate(-90deg)' : 'none' }}>
          {'▾'}
        </span>
        <strong style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={firstPath}>
          {followedName !== '' ? followedName.split('/').filter(Boolean).pop() ?? followedName : t('popup.title')}
        </strong>
        {conflicted && <span aria-hidden="true" style={{ color: token.error, fontSize: 12 }}>⚠</span>}
        {dirty && !conflicted && <span aria-hidden="true" className="gs-dirty-dot" style={{ color: token.warn, fontSize: 12 }}>●</span>}
        {!collapsed && (
          <button type="button" onClick={(e) => { e.stopPropagation(); props.openGit() }} className="gs-btn" style={linkButton} title={t('popup.openFull')}>
            {t('popup.openFull')}
          </button>
        )}
      </div>

      <div className={`gs-expand${collapsed ? ' gs-collapsed' : ''}`} aria-hidden={collapsed}>
        <div>
          <div style={{ overflow: 'auto', padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 10, height: dockHeight, minHeight: 0 }}>
          {(localError ?? error) !== null && <div style={{ color: token.error, fontSize: 12 }}>{localError ?? error}</div>}
          {navError !== null && <div style={{ color: token.error, fontSize: 12 }}>{t('popup.navFailed')}: {navError}</div>}

          <section>
            <div style={sectionTitle}>{t('panel.branches')}</div>
            {loading && <SkeletonRows rows={1} height={30} />}
            {!loading && (
              <select
                value={currentName}
                disabled={busy !== null || list.length === 0}
                onChange={(e) => { void switchTo(e.target.value) }}
                className="gs-btn"
                style={selectStyle}
                title={t('panel.branches')}
                aria-label={t('panel.branches')}
              >
                {list.map((b) => {
                  const a = b.ahead ?? 0
                  const d = b.behind ?? 0
                  const suffix = (b.upstream === undefined || b.upstream === '')
                    ? ' · local'
                    : (a === 0 && d === 0 ? '' : ` · ↑${a} ↓${d}`)
                  return (
                    <option key={b.name} value={b.name}>
                      {b.current ? '✓ ' : ''}{b.name}{suffix}
                    </option>
                  )
                })}
              </select>
            )}
            {!loading && list.length === 0 && <div style={emptyStyle}>{t('panel.noBranches')}</div>}
          </section>

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
const selectStyle: Record<string, string | number> = { width: '100%', boxSizing: 'border-box', padding: '6px 8px', background: 'var(--dsw-specific-input-major, #131518)', color: 'var(--dsw-alias-label-primary, #e8eaed)', border: `1px solid ${token.border}`, borderRadius: 6, fontSize: 12 }
const emptyStyle: Record<string, string | number> = { opacity: 0.6, fontSize: 12, padding: 6 }
const commitButton: Record<string, string | number> = { display: 'flex', gap: 6, alignItems: 'baseline', width: '100%', background: 'transparent', color: 'inherit', border: 0, cursor: 'pointer', textAlign: 'left', padding: 0, fontSize: 13, borderRadius: 4 }
const linkButton: Record<string, string | number> = { background: 'transparent', color: 'inherit', border: 0, cursor: 'pointer', fontSize: 12, opacity: 0.8 }
