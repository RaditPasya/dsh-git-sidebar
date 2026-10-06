import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { computeLanes, type CommitDetail } from '../../core/types.ts'
import { sharedGitApi } from './shared.tsx'
import {
  AuthorTag,
  SkeletonRows,
  TrackingBadge,
  commitHoverTitle,
  ensureSidebarStyles,
  fileStatusColor,
  formatDateTime,
  formatRelativeTime,
  laneColor,
  token,
  useFollowedWorkspacePath,
  useGitSnapshot,
  useWorkspaceRefs,
} from './shared.tsx'
import type { GitSidebarKey } from './locales.ts'

export type GitPanelProps = PropsRuntime<'main'> & PropsLocale<GitSidebarKey>

export function GitPanel(props: GitPanelProps) {
  const t = (props as unknown as { t: Translate<GitSidebarKey> }).t
  const workspaces = useWorkspaceRefs(props)
  const followedPath = useFollowedWorkspacePath(props, workspaces)
  const [path, setPath] = useState<string>('')
  const [manualPick, setManualPick] = useState(false)
  const [query, setQuery] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [flashBranch, setFlashBranch] = useState<string | null>(null)
  const [selectedOid, setSelectedOid] = useState<string | null>(null)
  const [detail, setDetail] = useState<CommitDetail | null | undefined>(undefined)
  const detailReq = useRef<string | null>(null)
  const flashTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    ensureSidebarStyles()
    return () => {
      window.clearTimeout(flashTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!manualPick && followedPath !== '' && path === '') setPath(followedPath)
  }, [workspaces, path, followedPath, manualPick])

  const { status, branches, graph, error, loading, refresh } = useGitSnapshot(path, t, 200)
  const [localError, setLocalError] = useState<string | null>(null)
  const shownError = localError ?? error

  const filteredBranches = useMemo(() => {
    const list = branches?.branches ?? []
    const needle = query.trim().toLowerCase()
    if (needle === '') return list
    return list.filter((b) => b.name.toLowerCase().includes(needle))
  }, [branches, query])

  const lanes = useMemo(() => (graph ? computeLanes(graph.commits) : []), [graph])

  const switchTo = useCallback(async (branch: string) => {
    if (path === '' || busy !== null) return
    setBusy(branch)
    setLocalError(null)
    const result = await sharedGitApi.switchBranch(path, branch)
    setBusy(null)
    if (!result.ok) {
      setLocalError(result.error.message)
      return
    }
    setFlashBranch(branch)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => {
      setFlashBranch((current) => (current === branch ? null : current))
    }, 950)
    await refresh(path)
  }, [path, busy, refresh])

  const createBranch = useCallback(async () => {
    const name = newBranch.trim()
    if (path === '' || name === '' || busy !== null) return
    setBusy(`create:${name}`)
    const result = await sharedGitApi.createBranch(path, name)
    setBusy(null)
    if (!result.ok) {
      setLocalError(result.error.message)
      return
    }
    setNewBranch('')
    await refresh(path)
  }, [path, newBranch, busy, refresh])

  const openCommit = useCallback(async (oid: string) => {
    if (selectedOid === oid) {
      detailReq.current = null
      setSelectedOid(null)
      return
    }
    detailReq.current = oid
    setSelectedOid(oid)
    setDetail(undefined)
    const result = await sharedGitApi.commit(path, oid)
    if (detailReq.current !== oid) return
    setDetail(result.ok ? result.value : null)
  }, [path, selectedOid])

  return (
    <div style={styles.page} data-dsh-plugin="git-sidebar" data-dsh-part="panel">
      <div style={styles.header}>
        <div>
          <div style={styles.title}>{t('panel.title')}</div>
          <div style={styles.subtitle}>{t('panel.subtitle')}</div>
        </div>
        <button
          type="button"
          className="gs-btn"
          style={styles.refresh}
          onClick={() => void refresh(path)}
          aria-label={t('panel.refresh') ?? 'Refresh'}
          title={t('panel.refresh') ?? 'Refresh'}
        >
          ⟳
        </button>
      </div>

      <label style={styles.label}>
        {t('panel.workspace')}
        <select value={path} onChange={(e) => { setManualPick(true); setPath(e.target.value) }} style={styles.select}>
          {workspaces.map((w) => (
            <option key={w.id} value={w.path}>{w.name}</option>
          ))}
        </select>
      </label>

      {status !== undefined && status !== null && (
        <div style={styles.statusLine}>
          <strong style={{ color: token.brand }}>{status.branch === '' ? t('panel.detached') : status.branch}</strong>
          <span style={{ opacity: 0.7 }}>{status.head}</span>
          {status.conflicts > 0 && <span style={{ color: token.error }}>· ⚠ {status.conflicts}</span>}
          {status.dirtyFiles > 0 && <span>· {t('panel.dirty', { count: status.dirtyFiles })}</span>}
          {status.untrackedFiles > 0 && <span>· +{status.untrackedFiles} {t('panel.untracked')}</span>}
        </div>
      )}
      {workspaces.length === 0 && path === '' && (
        <div style={styles.empty}>{t('panel.noWorkspace')}</div>
      )}
      {loading && status === undefined && workspaces.length > 0 && (
        <div style={{ ...styles.statusLine, maxWidth: 1100 }}>
          <SkeletonRows rows={1} height={16} />
        </div>
      )}
      {shownError !== null && <div style={styles.error}>{shownError}</div>}

      <div style={styles.columns}>
        <section style={styles.branches}>
          <div style={styles.sectionTitle}>{t('panel.branches')}</div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('panel.searchBranches')}
            style={styles.input}
          />
          <div style={styles.branchList}>
            {loading && workspaces.length > 0 && <SkeletonRows rows={6} />}
            {!loading && filteredBranches.map((b, index) => (
              <button
                key={b.name}
                type="button"
                disabled={busy !== null}
                onClick={() => void switchTo(b.name)}
                className="gs-btn gs-row gs-row-enter"
                style={{
                  ...(b.current ? { ...styles.branchRow, ...styles.branchCurrent } : styles.branchRow),
                  ...(flashBranch === b.name ? { backgroundColor: token.activeBg } : undefined),
                  animationDelay: `${Math.min(index, 12) * 18}ms`,
                }}
                title={b.upstream ?? b.name}
              >
                <span>{b.current ? '✓ ' : ''}{b.name}</span>
                <TrackingBadge upstream={b.upstream} ahead={b.ahead} behind={b.behind} t={t} />
              </button>
            ))}
            {!loading && filteredBranches.length === 0 && <div style={styles.empty}>{t('panel.noBranches')}</div>}
          </div>
          <div style={styles.createRow}>
            <input
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              placeholder={t('panel.newBranchPlaceholder')}
              style={styles.input}
            />
            <button type="button" onClick={() => void createBranch()} className="gs-btn" style={styles.button}>
              {t('panel.create')}
            </button>
          </div>
        </section>

        <section style={styles.commits}>
          <div style={styles.sectionTitle}>
            {t('panel.commits', { count: graph?.commits.length ?? 0 })}
          </div>
          <div style={styles.commitList}>
            {loading && workspaces.length > 0 && <SkeletonRows rows={8} height={34} />}
            {!loading && (graph?.commits ?? []).map((c, i) => {
              const row = lanes[i]
              const open = selectedOid === c.oid
              const loaded = open && detail !== undefined && detail !== null && detail.oid === c.oid
              return (
                <div
                  key={c.oid}
                  style={styles.commitRow}
                  className={open ? 'gs-flash' : undefined}
                >
                  <button
                    type="button"
                    onClick={() => void openCommit(c.oid)}
                    className="gs-btn gs-row"
                    style={styles.commitButton}
                    aria-expanded={open}
                    title={loaded && detail
                      ? `${c.subject}\n${detail.author} · ${formatDateTime(detail.authorTime)}\n+${detail.insertions} −${detail.deletions}${detail.body !== undefined ? `\n\n${detail.body}` : ''}`
                      : commitHoverTitle(c.subject, c.author, c.authorTime)}
                  >
                    <span style={styles.lanes} aria-hidden="true">
                      {(row?.columns ?? []).map((g, col) => (
                        <span
                          key={col}
                          style={g === 'gap'
                            ? { width: 10, display: 'inline-block' }
                            : { ...styles.laneNode, color: laneColor((row?.nodeColumn ?? 0) + col) }}
                        >
                          {g === 'node' ? '●' : g === 'merge' ? '◆' : g === 'pass' ? '│' : ' '}
                        </span>
                      ))}
                    </span>
                    <span style={styles.oid}>{c.oid.slice(0, 7)}</span>
                    <span style={styles.subject}>{c.subject}</span>
                  </button>
                  <div style={styles.meta}>
                    {c.refs.map((r) => (
                      <span key={r} style={r === graph?.branch ? { ...styles.ref, ...styles.refCurrent } : styles.ref}>{r}</span>
                    ))}
                    <span style={{ opacity: 0.7 }}><AuthorTag name={c.author} /></span>
                    <span style={{ opacity: 0.5 }}>·</span>
                    <span style={{ opacity: 0.55 }}>{formatRelativeTime(t, c.authorTime)}</span>
                  </div>
                  <div className={`gs-expand${open ? '' : ' gs-collapsed'}`} aria-hidden={!open}>
                    <div>
                      {open && (
                        <div style={styles.detail}>
                          {detail === undefined && <div>{t('panel.loadingCommit')}</div>}
                          {detail === null && <div>{t('panel.commitFailed')}</div>}
                          {detail !== undefined && detail !== null && (
                            <>
                              <div style={{ opacity: 0.85, marginBottom: 4 }}>
                                {detail.author} · {formatDateTime(detail.authorTime)}
                              </div>
                              {detail.body !== undefined && <div style={styles.detailBody}>{detail.body}</div>}
                              <div style={styles.detailStat}>
                                {t('panel.filesChanged', { count: detail.filesChanged })} ·{' '}
                                <span style={{ color: token.success }}>+{detail.insertions}</span>{' '}
                                <span style={{ color: token.error }}>−{detail.deletions}</span>
                              </div>
                              {detail.files.map((f) => (
                                <div key={f.path} style={styles.fileRow}>
                                  <span style={{ ...styles.fileStatus, color: fileStatusColor(f.status) }}>{f.status}</span>
                                  <span style={styles.filePath} title={f.path}>{f.path}</span>
                                </div>
                              ))}
                              {detail.files.length === 0 && <div style={styles.empty}>{t('panel.noFiles')}</div>}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            {!loading && (graph?.commits.length ?? 0) === 0 && <div style={styles.empty}>{t('panel.noCommits')}</div>}
          </div>
        </section>
      </div>
    </div>
  )
}

const styles: Record<string, Record<string, string | number>> = {
  page: { boxSizing: 'border-box', height: '100%', overflow: 'auto', padding: '28px clamp(24px,4vw,48px) 48px', color: 'var(--dsw-alias-label-primary)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', maxWidth: 1100, margin: '0 auto 16px' },
  title: { fontSize: 20, fontWeight: 700 },
  subtitle: { opacity: 0.7, fontSize: 13, marginTop: 4 },
  refresh: { fontSize: 16, padding: '6px 10px', cursor: 'pointer', background: 'transparent', color: 'inherit', border: `1px solid ${token.border}`, borderRadius: 6 },
  label: { display: 'block', maxWidth: 1100, margin: '0 auto 12px', fontSize: 13 },
  select: { display: 'block', width: '100%', marginTop: 6, padding: 8, background: 'var(--dsw-specific-input-major, #131518)', color: 'var(--dsw-alias-label-primary, #e8eaed)', border: `1px solid ${token.border}`, borderRadius: 6 },
  statusLine: { maxWidth: 1100, margin: '0 auto 12px', display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13, flexWrap: 'wrap' },
  error: { maxWidth: 1100, margin: '0 auto 12px', color: token.error, fontSize: 13 },
  columns: { display: 'grid', gridTemplateColumns: 'minmax(260px,340px) 1fr', gap: 16, maxWidth: 1100, margin: '0 auto' },
  branches: { border: `1px solid ${token.border}`, borderRadius: 8, padding: 12, alignSelf: 'start' },
  commits: { border: `1px solid ${token.border}`, borderRadius: 8, padding: 12, minWidth: 0 },
  sectionTitle: { fontWeight: 700, marginBottom: 8 },
  input: { width: '100%', boxSizing: 'border-box', padding: 8, marginBottom: 8, background: 'var(--dsw-specific-input-major, #131518)', color: 'var(--dsw-alias-label-primary, #e8eaed)', border: `1px solid ${token.border}`, borderRadius: 6 },
  branchList: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 420, overflow: 'auto' },
  branchRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer', background: 'transparent', color: 'inherit', border: '1px solid transparent', borderRadius: 6, textAlign: 'left' },
  branchCurrent: { borderColor: token.brand, fontWeight: 700, backgroundColor: token.activeBg },
  createRow: { display: 'flex', gap: 8, marginTop: 8 },
  button: { padding: '8px 12px', cursor: 'pointer', background: 'transparent', color: 'inherit', border: `1px solid ${token.border}`, borderRadius: 6 },
  empty: { opacity: 0.6, fontSize: 13, padding: 8 },
  commitList: { display: 'flex', flexDirection: 'column', maxHeight: 640, overflow: 'auto' },
  commitRow: { borderBottom: `1px solid ${token.border}`, padding: '6px 0' },
  commitButton: { display: 'flex', gap: 8, alignItems: 'baseline', width: '100%', background: 'transparent', color: 'inherit', border: 0, cursor: 'pointer', textAlign: 'left', padding: 2, borderRadius: 4 },
  lanes: { fontFamily: 'monospace', whiteSpace: 'pre', opacity: 0.9 },
  laneNode: { width: 10, display: 'inline-block', textAlign: 'center' },
  oid: { fontFamily: 'monospace', opacity: 0.7, fontSize: 12 },
  subject: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
  meta: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, marginLeft: 4, flexWrap: 'wrap' },
  ref: { border: '1px solid currentColor', borderRadius: 4, padding: '0 4px', fontSize: 11, color: token.brand },
  refCurrent: { fontWeight: 700, backgroundColor: token.activeBg },
  detail: { margin: '6px 0 6px 4px', padding: 8, border: `1px solid ${token.border}`, borderRadius: 6 },
  detailStat: { fontSize: 12, opacity: 0.8, marginBottom: 6 },
  detailBody: { fontSize: 12, whiteSpace: 'pre-wrap', opacity: 0.85, marginBottom: 6 },
  fileRow: { display: 'flex', gap: 8, fontSize: 12, padding: '2px 0' },
  fileStatus: { width: 16, fontWeight: 700 },
  filePath: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
}
