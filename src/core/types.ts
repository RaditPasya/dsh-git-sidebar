
export interface RepoStatus {
  root: string
  branch: string
  head: string
  dirtyFiles: number
  untrackedFiles: number
  conflicts: number
  operationInProgress: boolean
}

export interface BranchRow {
  name: string
  current: boolean
  upstream?: string
  ahead?: number
  behind?: number
  gone?: boolean
}

export interface CommitFile {
  path: string
  status: string
}

export interface CommitDetail {
  oid: string
  parents: string[]
  subject: string
  body?: string
  author: string
  authorTime: number
  refs: string[]
  files: CommitFile[]
  filesChanged: number
  insertions: number
  deletions: number
}

export interface BranchesView {
  root: string
  branch: string
  branches: BranchRow[]
  dirtyFiles: number
  untrackedFiles: number
  conflicts: number
  operationInProgress: boolean
}

export interface WorktreeInfo {
  path: string
  head: string
  branch: string
  main: boolean
}

export interface WorktreeListView {
  root: string
  worktrees: WorktreeInfo[]
}

export type WorktreeAddResult =
  | { ok: true; path: string; branch: string; name: string }
  | { ok: false; error: GitError }

export type WorktreeRemoveResult =
  | { ok: true; branchDeleted: boolean; branchDeleteError?: string }
  | { ok: false; error: GitError }

export type GitErrorCode =
  | 'conflicts-present'
  | 'operation-in-progress'
  | 'branch-in-other-worktree'
  | 'tracked-changes-would-be-overwritten'
  | 'untracked-changes-would-be-overwritten'
  | 'target-branch-not-found'
  | 'invalid-branch-name'
  | 'branch-already-exists'
  | 'workspace-unknown'
  | 'invalid-worktree-name'
  | 'worktree-already-exists'
  | 'worktree-dirty'
  | 'worktree-not-found'
  | 'worktree-is-main'
  | 'base-ref-not-found'
  | 'timeout'
  | 'internal'

export interface GitError {
  code: GitErrorCode
  message: string
  paths?: string[]
  moreFiles?: number
}

export type SwitchResult =
  | { ok: true; branch: string }
  | { ok: false; error: GitError }

export type PullResult =
  | { ok: true; output: string }
  | { ok: false; error: GitError }

export interface GraphCommit {
  oid: string
  parents: string[]
  subject: string
  author: string
  authorTime: number
  refs: string[]
}

export interface GraphView {
  root: string
  branch: string
  commits: GraphCommit[]
  hasMore: boolean
}

export function parseBranches(stdout: string): BranchRow[] {
  const rows: BranchRow[] = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const [name, head, oid, upstream = '', track = ''] = line.split('\u0000')
    if (name === undefined || head === undefined || oid === undefined) continue
    rows.push({ name, current: head === '*', ...parseUpstreamTrack(upstream, track) })
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

export function parseUpstreamTrack(upstream: string, track: string): Pick<BranchRow, 'upstream' | 'ahead' | 'behind' | 'gone'> {
  const cleanUpstream = (upstream ?? '').trim()
  const out: Pick<BranchRow, 'upstream' | 'ahead' | 'behind' | 'gone'> = {}
  if (cleanUpstream !== '') out.upstream = cleanUpstream
  const t = (track ?? '').trim()
  if (t === '') {
    if (cleanUpstream !== '') {
      out.ahead = 0
      out.behind = 0
    }
    return out
  }
  if (/\bgone\b/.test(t)) {
    out.gone = true
    return out
  }
  const ahead = /ahead (\d+)/.exec(t)
  const behind = /behind (\d+)/.exec(t)
  if (ahead?.[1] !== undefined) out.ahead = Number(ahead[1])
  if (behind?.[1] !== undefined) out.behind = Number(behind[1])
  return out
}

export function parseNameStatus(stdout: string): CommitFile[] {
  const files: CommitFile[] = []
  for (const line of stdout.split('\n')) {
    if (files.length >= 200) break
    if (line === '') continue
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const status = line.slice(0, tab).trim()
    const rest = line.slice(tab + 1)
    if (status === '' || rest === '') continue
    const lastTab = rest.lastIndexOf('\t')
    const path = (lastTab === -1 ? rest : rest.slice(lastTab + 1)).slice(0, 1024)
    if (path === '') continue
    files.push({ path, status: status[0] ?? status })
  }
  return files
}

export function parseNumstat(stdout: string): { insertions: number; deletions: number; filesChanged: number } {
  let insertions = 0
  let deletions = 0
  let filesChanged = 0
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const firstTab = line.indexOf('\t')
    if (firstTab === -1) continue
    const secondTab = line.indexOf('\t', firstTab + 1)
    if (secondTab === -1) continue
    const added = line.slice(0, firstTab)
    const removed = line.slice(firstTab + 1, secondTab)
    if (added === '-' || removed === '-') continue
    const a = Number(added)
    const r = Number(removed)
    if (!Number.isInteger(a) || !Number.isInteger(r) || a < 0 || r < 0) continue
    insertions += a
    deletions += r
    filesChanged += 1
  }
  return { insertions, deletions, filesChanged }
}

export function parseWorktreeBranches(stdout: string): string[] {
  const seen = new Set<string>()
  const branches: string[] = []
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('branch refs/heads/')) continue
    const name = line.slice('branch refs/heads/'.length).trim()
    if (name !== '' && !seen.has(name)) {
      seen.add(name)
      branches.push(name)
    }
  }
  return branches
}

export function parseWorktrees(stdout: string): WorktreeInfo[] {
  const rows: WorktreeInfo[] = []
  let current: { path?: string; head?: string; branch?: string } | null = null
  const flush = (): void => {
    if (current === null || current.path === undefined) return
    rows.push({
      path: current.path,
      head: current.head ?? '',
      branch: current.branch ?? '',
      main: rows.length === 0,
    })
  }
  for (const line of stdout.split('\n')) {
    if (line === '') {
      flush()
      current = null
      continue
    }
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length).trim() }
      continue
    }
    if (current === null) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length).trim()
    else if (line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length).trim()
  }
  flush()
  return rows
}

export function parsePorcelain(stdout: string): { dirtyFiles: number; untrackedFiles: number; conflicts: number } {
  let dirtyFiles = 0
  let untrackedFiles = 0
  let conflicts = 0
  const unmerged = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const xy = line.slice(0, 2)
    if (unmerged.has(xy)) conflicts += 1
    else if (xy.startsWith('??')) untrackedFiles += 1
    else if (xy === '  ') continue
    else dirtyFiles += 1
  }
  return { dirtyFiles, untrackedFiles, conflicts }
}

export function parseGraph(stdout: string): GraphCommit[] {
  const commits: GraphCommit[] = []
  for (const raw of stdout.split('\u001e')) {
    const entry = raw.replace(/^\n/, '')
    if (entry === '') continue
    const [oid, parentsRaw, author, authorTimeRaw, decoration, subject] = entry.split('\u0000')
    if (oid === undefined || oid === '') continue
    commits.push({
      oid,
      parents: parentsRaw === undefined || parentsRaw === '' ? [] : parentsRaw.split(' '),
      subject: (subject ?? '').slice(0, 1000),
      author: (author ?? '').slice(0, 200),
      authorTime: Number(authorTimeRaw ?? '0'),
      refs: parseDecoration(decoration ?? ''),
    })
  }
  return commits
}

export function parseDecoration(decoration: string): string[] {
  if (decoration === '') return []
  return decoration.split(', ').map(part => {
    if (part === 'HEAD') return ''
    let name = part.replace(/^HEAD -> /, '').replace(/^tag: /, '')
    return name.trim()
  }).filter(name => name !== '')
}

export type LaneGlyph = 'node' | 'pass' | 'merge' | 'gap'

export interface GraphRowLanes {
  columns: LaneGlyph[]
  nodeColumn: number
  merge: boolean
}

export function computeLanes(rows: readonly GraphCommit[]): GraphRowLanes[] {
  const later = new Set<string>()
  for (const row of rows) {
    for (const parent of row.parents) later.add(parent)
  }
  const lanes: (string | null)[] = []
  const result: GraphRowLanes[] = []
  for (const row of rows) {
    let nodeColumn = lanes.findIndex(pending => pending === row.oid)
    if (nodeColumn === -1) {
      lanes.push(row.oid)
      nodeColumn = lanes.length - 1
    }
    const columns: LaneGlyph[] = []
    for (let i = 0; i < lanes.length; i += 1) {
      const pending = lanes[i]
      if (pending === null) columns.push('gap')
      else if (i === nodeColumn) columns.push(row.parents.length > 1 ? 'merge' : 'node')
      else if (pending === row.oid) columns.push('gap')
      else if (typeof pending === 'string' && later.has(pending)) columns.push('pass')
      else columns.push('gap')
    }
    const parents = row.parents.filter(parent => later.has(parent))
    const [first, ...rest] = parents
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] === row.oid && i !== nodeColumn) lanes[i] = null
    }
    lanes[nodeColumn] = first ?? null
    for (const parent of rest) {
      if (!lanes.includes(parent)) lanes.push(parent)
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
    result.push({ columns, nodeColumn, merge: row.parents.length > 1 })
  }
  return result
}


function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function isRepoStatus(value: unknown): value is RepoStatus {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.root === 'string'
    && typeof record.branch === 'string'
    && typeof record.head === 'string'
    && isCount(record.dirtyFiles)
    && isCount(record.untrackedFiles)
    && isCount(record.conflicts)
    && typeof record.operationInProgress === 'boolean'
}

export function isBranchRow(value: unknown): value is BranchRow {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || typeof record.current !== 'boolean') return false
  if (record.upstream !== undefined && typeof record.upstream !== 'string') return false
  if (record.ahead !== undefined && !isCount(record.ahead)) return false
  if (record.behind !== undefined && !isCount(record.behind)) return false
  if (record.gone !== undefined && typeof record.gone !== 'boolean') return false
  return true
}

export function isCommitFile(value: unknown): value is CommitFile {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.path === 'string' && typeof record.status === 'string'
}

export function isCommitDetail(value: unknown): value is CommitDetail {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.oid === 'string'
    && Array.isArray(record.parents) && record.parents.every(parent => typeof parent === 'string')
    && typeof record.subject === 'string'
    && (record.body === undefined || typeof record.body === 'string')
    && typeof record.author === 'string'
    && typeof record.authorTime === 'number' && Number.isFinite(record.authorTime)
    && Array.isArray(record.refs) && record.refs.every(ref => typeof ref === 'string')
    && Array.isArray(record.files) && record.files.every(isCommitFile)
    && isCount(record.filesChanged)
    && isCount(record.insertions)
    && isCount(record.deletions)
}

export function isBranchesView(value: unknown): value is BranchesView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.root === 'string'
    && typeof record.branch === 'string'
    && Array.isArray(record.branches) && record.branches.every(isBranchRow)
    && isCount(record.dirtyFiles)
    && isCount(record.untrackedFiles)
    && isCount(record.conflicts)
    && typeof record.operationInProgress === 'boolean'
}

export function isGraphCommit(value: unknown): value is GraphCommit {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.oid === 'string'
    && Array.isArray(record.parents) && record.parents.every(parent => typeof parent === 'string')
    && typeof record.subject === 'string'
    && typeof record.author === 'string'
    && typeof record.authorTime === 'number' && Number.isFinite(record.authorTime)
    && Array.isArray(record.refs) && record.refs.every(ref => typeof ref === 'string')
}

export interface PanelView {
  status: RepoStatus
  branches: BranchesView
  graph: GraphView
}

export function isPanelView(value: unknown): value is PanelView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return isRepoStatus(record.status) && isBranchesView(record.branches) && isGraphView(record.graph)
}

export function isGraphView(value: unknown): value is GraphView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.root === 'string'
    && typeof record.branch === 'string'
    && Array.isArray(record.commits) && record.commits.every(isGraphCommit)
    && typeof record.hasMore === 'boolean'
}

const GIT_ERROR_CODES = new Set<GitErrorCode>([
  'conflicts-present',
  'operation-in-progress',
  'branch-in-other-worktree',
  'tracked-changes-would-be-overwritten',
  'untracked-changes-would-be-overwritten',
  'target-branch-not-found',
  'invalid-branch-name',
  'branch-already-exists',
  'workspace-unknown',
  'invalid-worktree-name',
  'worktree-already-exists',
  'worktree-dirty',
  'worktree-not-found',
  'worktree-is-main',
  'base-ref-not-found',
  'timeout',
  'internal',
])

export function isWorktreeInfo(value: unknown): value is WorktreeInfo {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.path === 'string'
    && typeof record.head === 'string'
    && typeof record.branch === 'string'
    && typeof record.main === 'boolean'
}

export function isWorktreeListView(value: unknown): value is WorktreeListView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.root === 'string'
    && Array.isArray(record.worktrees) && record.worktrees.every(isWorktreeInfo)
}

export function isGitErrorCode(value: unknown): value is GitErrorCode {
  return typeof value === 'string' && GIT_ERROR_CODES.has(value as GitErrorCode)
}

export function isGitError(value: unknown): value is GitError {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (!isGitErrorCode(record.code)) return false
  if (typeof record.message !== 'string') return false
  if (record.paths !== undefined
    && (!Array.isArray(record.paths) || !record.paths.every(path => typeof path === 'string'))) {
    return false
  }
  if (record.moreFiles !== undefined && !isCount(record.moreFiles)) return false
  return true
}

export function isResultPayload(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null) return false
  return Object.values(value as Record<string, unknown>).every(entry => typeof entry === 'string')
}
