import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RepoStatus } from '../../core/types.ts'
import { subscribeChanges } from '../api.ts'
import { FOCUS_REFRESH_MIN_MS, ensureSidebarStyles, sharedGitApi, token, useFollowedWorkspacePath, useWorkspaceRefs } from './shared.tsx'
import type { GitSidebarKey } from './locales.ts'
import { toggleFooterPopup } from './footer-popup-state.ts'

export interface GitFooterActionInject {
  openGit: () => void
}

export type GitFooterActionProps =
  PropsRuntime<'sidebar.footer.action'> & PropsLocale<GitSidebarKey> & GitFooterActionInject

export function GitFooterAction(props: GitFooterActionProps) {
  const wide = (props as unknown as { wide?: boolean }).wide ?? false
  const t = (props as unknown as { t: (key: string) => string }).t
  const workspaces = useWorkspaceRefs(props)
  const firstPath = useFollowedWorkspacePath(props, workspaces)
  const followedName = workspaces.find((w) => w.path === firstPath)?.name ?? ''

  const [status, setStatus] = useState<RepoStatus | null | undefined>(undefined)

  useEffect(() => {
    ensureSidebarStyles()
  }, [])

  useEffect(() => {
    if (firstPath === '') return undefined
    let live = true
    const lastFocus = { current: 0 }
    const load = (): void => {
      void sharedGitApi.status(firstPath).then((result) => {
        if (live) setStatus(result.ok ? result.value : null)
      }).catch(() => {
        if (live) setStatus(null)
      })
    }
    load()
    const unsubscribe = subscribeChanges(firstPath, load)
    const onFocus = (): void => {
      const now = Date.now()
      if (now - lastFocus.current < FOCUS_REFRESH_MIN_MS) return
      lastFocus.current = now
      load()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      live = false
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [firstPath])

  if (status === undefined || status === null) return null

  const label = status.branch !== '' ? status.branch : (status.head !== '' ? status.head : t('panel'))

  const dirty = status.dirtyFiles + status.untrackedFiles > 0
  const conflicted = status.conflicts > 0

  return (
    <button
      type="button"
      onClick={() => { toggleFooterPopup() }}
      title={firstPath === '' ? label : `${label} · ${followedName !== '' ? followedName : firstPath}${followedName !== '' ? ` — ${firstPath}` : ''}`}
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
        padding: wide ? '6px 8px' : 6,
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
      {wide && (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
      )}
      {conflicted && <span aria-hidden="true" style={{ color: token.error }}>⚠</span>}
      {dirty && !conflicted && <span aria-hidden="true" className="gs-dirty-dot" style={{ color: token.warn }}>●</span>}
    </button>
  )
}
