
import { subscribeSharedEvents } from './sse-leader.ts'
import type {
  BranchesView, CommitDetail, GitError, GitFeatureConfig, GraphView, PanelView, RepoStatus, WorktreeListView,
} from '../core/types.ts'

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GitError }

const TRANSPORT_ERROR: GitError = { code: 'internal', message: 'git route unavailable' }

async function post<T>(path: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    return { ok: false, error: TRANSPORT_ERROR }
  }
  try {
    const envelope = await response.json() as unknown
    if (typeof envelope !== 'object' || envelope === null) return { ok: false, error: TRANSPORT_ERROR }
    const record = envelope as Record<string, unknown>
    if (record.ok === true) return { ok: true, value: record.value as T }
    return { ok: false, error: (record.error as GitError | undefined) ?? TRANSPORT_ERROR }
  } catch {
    return { ok: false, error: TRANSPORT_ERROR }
  }
}

export class GitApi {
  status(path: string): Promise<ApiResult<RepoStatus | null>> {
    return post('git-fork/status', { path })
  }

  branches(path: string): Promise<ApiResult<BranchesView | null>> {
    return post('git-fork/branches', { path })
  }

  switchBranch(path: string, branch: string): Promise<ApiResult<{ branch: string }>> {
    return post('git-fork/switch', { path, branch })
  }

  createBranch(path: string, name: string): Promise<ApiResult<{ branch: string }>> {
    return post('git-fork/create-branch', { path, name })
  }

  graph(path: string, limit?: number): Promise<ApiResult<GraphView | null>> {
    return post('git-fork/graph', limit === undefined ? { path } : { path, limit })
  }

  panel(path: string, limit?: number): Promise<ApiResult<PanelView | null>> {
    return post('git-fork/panel', limit === undefined ? { path } : { path, limit })
  }

  commit(path: string, oid: string): Promise<ApiResult<CommitDetail | null>> {
    return post('git-fork/commit', { path, oid })
  }

  worktrees(path: string): Promise<ApiResult<WorktreeListView | null>> {
    return post('git-fork/worktrees', { path })
  }

  addWorktree(path: string, name: string, baseRef?: string): Promise<ApiResult<{ path: string; branch: string; name: string }>> {
    return post('git-fork/worktree-add', baseRef === undefined ? { path, name } : { path, name, baseRef })
  }

  removeWorktree(path: string, worktreePath: string, opts?: { force?: boolean; deleteBranch?: boolean }): Promise<ApiResult<{ removed: true }>> {
    return post('git-fork/worktree-remove', { path, worktreePath, force: opts?.force === true, deleteBranch: opts?.deleteBranch === true })
  }

  config(): Promise<ApiResult<GitFeatureConfig>> {
    return post('git-fork/config', {})
  }
}

export function subscribeChanges(path: string, onChange: () => void): () => void {
  return subscribeSharedEvents(`git-fork/events?path=${encodeURIComponent(path)}`, 'change', () => { onChange() })
}
