
import { subscribeSharedEvents } from './sse-leader.ts'
import type {
  BranchesView, CommitDetail, GitError, GitFeatureConfig, GraphView, PanelView, RepoStatus, WorktreeListView,
} from '../core/types.ts'

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GitError }

const TRANSPORT_ERROR: GitError = { code: 'internal', message: 'git route unavailable' }

const REQUEST_TIMEOUT_MS = 25_000

function isErrorEnvelope(value: unknown): value is { ok: false; error: GitError } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.ok !== false) return false
  const error = record.error as Record<string, unknown> | undefined
  return typeof error?.code === 'string' && typeof error?.message === 'string'
}

async function post<T>(path: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
  let response: Response
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new Error('git request timed out'))
  }, REQUEST_TIMEOUT_MS)
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch {
    return { ok: false, error: TRANSPORT_ERROR }
  } finally {
    clearTimeout(timeout)
  }
  try {
    const envelope = await response.json() as unknown
    if (typeof envelope !== 'object' || envelope === null) return { ok: false, error: TRANSPORT_ERROR }
    const record = envelope as Record<string, unknown>
    if (record.ok === true) return { ok: true, value: record.value as T }
    if (isErrorEnvelope(envelope)) return { ok: false, error: envelope.error }
    return { ok: false, error: TRANSPORT_ERROR }
  } catch {
    return { ok: false, error: TRANSPORT_ERROR }
  }
}

export class GitApi {
  status(path: string): Promise<ApiResult<RepoStatus | null>> {
    return post('git-sidebar/status', { path })
  }

  branches(path: string): Promise<ApiResult<BranchesView | null>> {
    return post('git-sidebar/branches', { path })
  }

  switchBranch(path: string, branch: string): Promise<ApiResult<{ branch: string }>> {
    return post('git-sidebar/switch', { path, branch })
  }

  createBranch(path: string, name: string): Promise<ApiResult<{ branch: string }>> {
    return post('git-sidebar/create-branch', { path, name })
  }

  pull(path: string): Promise<ApiResult<{ output: string }>> {
    return post('git-sidebar/pull', { path })
  }

  fetch(path: string): Promise<ApiResult<{ output: string }>> {
    return post('git-sidebar/fetch', { path })
  }

  graph(path: string, limit?: number): Promise<ApiResult<GraphView | null>> {
    return post('git-sidebar/graph', limit === undefined ? { path } : { path, limit })
  }

  panel(path: string, limit?: number): Promise<ApiResult<PanelView | null>> {
    return post('git-sidebar/panel', limit === undefined ? { path } : { path, limit })
  }

  commit(path: string, oid: string): Promise<ApiResult<CommitDetail | null>> {
    return post('git-sidebar/commit', { path, oid })
  }

  worktrees(path: string): Promise<ApiResult<WorktreeListView | null>> {
    return post('git-sidebar/worktrees', { path })
  }

  addWorktree(path: string, name: string, baseRef?: string): Promise<ApiResult<{ path: string; branch: string; name: string }>> {
    return post('git-sidebar/worktree-add', baseRef === undefined ? { path, name } : { path, name, baseRef })
  }

  removeWorktree(path: string, worktreePath: string, opts?: { force?: boolean; deleteBranch?: boolean }): Promise<ApiResult<{ removed: true }>> {
    return post('git-sidebar/worktree-remove', { path, worktreePath, force: opts?.force === true, deleteBranch: opts?.deleteBranch === true })
  }

  config(): Promise<ApiResult<GitFeatureConfig>> {
    return post('git-sidebar/config', {})
  }
}

export function subscribeChanges(path: string, onChange: () => void): () => void {
  return subscribeSharedEvents(`git-sidebar/events?path=${encodeURIComponent(path)}`, 'change', () => { onChange() })
}
