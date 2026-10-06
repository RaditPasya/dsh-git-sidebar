import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommitDetail } from '../../core/types.ts'
import { sharedGitApi } from './shared.tsx'
import {
  AuthorTag,
  SkeletonRows,
  TrackingDot,
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
  closeFooterPopup,
  getFooterPopupSnapshot,
  subscribeFooterPopup,
} from './footer-popup-state.ts'

export interface GitSidebarPopupInject {
  openFullPanel: () => void
}

export type GitSidebarPopupProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<GitSidebarKey> & GitSidebarPopupInject

export function GitSidebarPopup(props: GitSidebarPopupProps) {
  const t = (props as unknown as { t: (key: string, params?: Record<string, unknown>) => string }).t
  const workspaces = useWorkspaceRefs(props)

  const snapshot = useSyncExternalStore(
    subscribeFooterPopup,
    () => getFooterPopupSnapshot(),
    () => getFooterPopupSnapshot(),
  )
  const open = snapshot.open
  const navError = snapshot.navError

  const firstPath = useFollowedWorkspacePath(props, workspaces)
  const followedName = workspaces.find((w) => w.path === firstPath)?.name ?? ''

  const { status, branches, graph, error, loading, refresh } = useGitSnapshot(firstPath, t, 200)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [detailOid, setDetailOid] = useState<string | null>(null)
  const [detail, setDetail] = useState<CommitDetail | null | undefined>(undefined)
  const detailReq = useRef<string | null>(null)

  const [visible, setVisible] = useState(open)
  const [leaving, setLeaving] = useState(false)
  const leaveTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (open) {
      window.clearTimeout(leaveTimer.current)
      setLeaving(false)
      setVisible(true)
      return undefined
    }
    if (!visible) return undefined
    setLeaving(true)
    leaveTimer.current = window.setTimeout(() => {
      setVisible(false)
      setLeaving(false)
    }, 160)
    return () => {
      window.clearTimeout(leaveTimer.current)
    }
  }, [open, visible])

  useEffect(() => {
    ensureSidebarStyles()
  }, [])

  useEffect(() => {
    if (visible) return
    detailReq.current = null
    setDetailOid(null)
    setDetail(undefined)
    setQuery('')
    setLocalError(null)
  }, [visible])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeFooterPopup()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!visible) return null

  const needle = query.trim().toLowerCase()
  const list = branches?.branches ?? []
  const filtered = needle === '' ? list : list.filter((b) => b.name.toLowerCase().includes(needle))

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
    <>
      <div
        data-dsh-plugin="git-sidebar"
        data-dsh-part="footer-popup-backdrop"
        onClick={() => { closeFooterPopup() }}
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'transparent',
          pointerEvents: 'auto',
          zIndex: 59,
        }}
      />
    <div
      data-dsh-plugin="git-sidebar"
      data-dsh-part="footer-popup"
      className={leaving ? 'gs-popup-exit' : 'gs-popup-enter'}
      style={{
        position: 'fixed',
        left: 8,
        bottom: 120,
        width: 'min(380px, calc(100vw - 16px))',
        maxHeight: 'min(62vh, 560px)',
        display: 'flex',
        flexDirection: 'column',
        background: '#181b20',
        color: 'var(--dsw-alias-label-primary, #e8eaed)',
        border: `1px solid ${token.border}`,
        borderRadius: 12,
        boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,0.55))',
        pointerEvents: 'auto',
        overflow: 'hidden',
        zIndex: 60,
      }}
      role="dialog"
      aria-label={t('popup.title')}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${token.border}` }}>
        <strong style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={firstPath}>{followedName !== '' ? followedName.split('/').filter(Boolean).pop() ?? followedName : t('popup.title')}</strong>
        {status !== undefined && status !== null && status.branch !== '' && (
          <span style={{ fontSize: 12, color: token.brand, fontWeight: 700 }}>{status.branch}</span>
        )}
        <button type="button" onClick={() => { props.openFullPanel() }} className="gs-btn" style={linkButton} title={t('popup.openFull')}>
          {t('popup.openFull')}
        </button>
        <button type="button" onClick={() => { closeFooterPopup() }} className="gs-btn" style={linkButton} aria-label={t('popup.close')}>
          ✕
        </button>
      </div>

      <div style={{ overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {(localError ?? error) !== null && <div style={{ color: token.error, fontSize: 12 }}>{localError ?? error}</div>}
        {navError !== null && <div style={{ color: token.error, fontSize: 12 }}>{t('popup.navFailed')}: {navError}</div>}

        <section>
          <div style={sectionTitle}>{t('panel.branches')}</div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('panel.searchBranches')}
            style={inputStyle}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 180, overflow: 'auto' }}>
            {loading && <SkeletonRows rows={4} />}
            {!loading && filtered.slice(0, 12).map((b, index) => (
              <button
                key={b.name}
                type="button"
                disabled={busy !== null}
                onClick={() => void switchTo(b.name)}
                className="gs-btn gs-row gs-row-enter"
                style={b.current ? { ...rowStyle, ...rowCurrent } : { ...rowStyle, animationDelay: `${Math.min(index, 10) * 15}ms` }}
                title={b.upstream ?? b.name}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {b.current ? '✓ ' : ''}{b.name}
                </span>
                <TrackingDot upstream={b.upstream} ahead={b.ahead} behind={b.behind} />
              </button>
            ))}
            {!loading && filtered.length === 0 && <div style={emptyStyle}>{t('panel.noBranches')}</div>}
          </div>
        </section>

        <section>
          <div style={sectionTitle}>{t('popup.recentCommits')}</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {loading && <SkeletonRows rows={5} height={30} />}
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
    </>
  )
}

const sectionTitle: Record<string, string | number> = { fontWeight: 700, fontSize: 13, marginBottom: 6 }
const inputStyle: Record<string, string | number> = { width: '100%', boxSizing: 'border-box', padding: 7, marginBottom: 6, background: 'var(--dsw-specific-input-major, #131518)', color: 'var(--dsw-alias-label-primary, #e8eaed)', border: `1px solid ${token.border}`, borderRadius: 6 }
const rowStyle: Record<string, string | number> = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '5px 6px', cursor: 'pointer', background: 'transparent', color: 'inherit', border: '1px solid transparent', borderRadius: 6, textAlign: 'left', fontSize: 13 }
const rowCurrent: Record<string, string | number> = { borderColor: token.brand, fontWeight: 700, backgroundColor: token.activeBg }
const emptyStyle: Record<string, string | number> = { opacity: 0.6, fontSize: 12, padding: 6 }
const commitButton: Record<string, string | number> = { display: 'flex', gap: 6, alignItems: 'baseline', width: '100%', background: 'transparent', color: 'inherit', border: 0, cursor: 'pointer', textAlign: 'left', padding: 0, fontSize: 13, borderRadius: 4 }
const linkButton: Record<string, string | number> = { background: 'transparent', color: 'inherit', border: 0, cursor: 'pointer', fontSize: 12, opacity: 0.8 }
