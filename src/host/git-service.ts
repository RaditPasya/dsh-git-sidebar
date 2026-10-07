
import { existsSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { subprocessRunner as sharedSubprocessRunner, type GitRunner, type GitRunResult } from './git-runner.ts'
import {
  branchDeleteArgv, checkRefFormatArgv, classifySwitchFailure, commitFilesArgv,
  commitHeaderArgv, commitNumstatArgv, createBranchArgv,
  forEachRefArgv, gitPathArgv, graphLogArgv, headBranchArgv, identityArgv,
  operationMarkersArgv, OPERATION_MARKERS, fetchArgv, isUnsafeRefValue, pullArgv, sanitizeWorktreeName, statusPorcelainArgv,
  switchArgv, topLevelArgv, unmergedArgv, validateBranchName, verifyCommitArgv, verifyRefArgv,
  verifyRevArgv, worktreeAddArgv, worktreeListArgv, worktreeRemoveArgv,
  WORKTREE_BRANCH_PREFIX,
} from '../core/git-command.ts'
import {
  parseBranches, parseDecoration, parseGraph, parseNameStatus, parseNumstat, parsePorcelain,
  parseWorktreeBranches, parseWorktrees,
  type BranchRow, type BranchesView, type CommitDetail, type GitError, type GraphCommit, type GraphView, type PanelView,
  type PullResult, type RepoStatus, type SwitchResult, type WorktreeAddResult, type WorktreeListView,
  type WorktreeRemoveResult,
} from '../core/types.ts'
import { isManagedWorktreeOf, repoWorktreesDir, worktreePathFor } from './worktree-home.ts'

export type { GitRunResult, GitRunner } from './git-runner.ts'

export function gitSpawnArgv(platform: NodeJS.Platform, argv: readonly string[]): readonly string[] {
  return platform === 'win32' ? ['git.exe', ...argv] : ['git', ...argv]
}

export type WorkspaceVerdict = { ok: true; canonical: string } | { ok: false; error: GitError }

export type WorkspaceGate = (path: string) => Promise<WorkspaceVerdict>

export function subprocessRunner(ctx: Context): GitRunner {
  return sharedSubprocessRunner(ctx, { spawnArgv: (argv) => gitSpawnArgv(process.platform, argv) })
}

const DETACHED = 'HEAD'

/** Budgets. Each bounds a whole shared operation, including every git child. */
const STATUS_DEADLINE_MS = 15_000
const READ_DEADLINE_MS = 30_000
const WORKTREE_DEADLINE_MS = 20_000
const MUTATION_DEADLINE_MS = 60_000
/** pull/fetch talk to the network, so they get a wider budget — but still one. */
const NETWORK_DEADLINE_MS = 120_000

const WORKSPACE_UNKNOWN: GitError = {
  code: 'workspace-unknown',
  message: 'path is not a registered workspace',
}

const NOT_A_REPOSITORY: GitError = { code: 'internal', message: 'not a git repository' }

const timedOut = (what: string): GitError => ({ code: 'timeout', message: `${what} timed out` })

/**
 * Raised when a read's budget expires. A timed-out command yields empty stdout,
 * which would otherwise be parsed into a plausible-looking "clean repository"
 * answer; callers must see the failure instead.
 */
export class GitTimeoutError extends Error {
  constructor(what: string) {
    super(`${what} timed out`)
    this.name = 'GitTimeoutError'
  }
}

function requireCompleted(result: GitRunResult, what: string): GitRunResult {
  if (result.timedOut === true) throw new GitTimeoutError(what)
  return result
}

interface Counts {
  dirtyFiles: number
  untrackedFiles: number
  conflicts: number
}

interface LightSnapshot {
  root: string
  branch: string
  head: string
  counts: Counts
  operationInProgress: boolean
}

interface FullSnapshot extends LightSnapshot {
  branchRows: BranchRow[]
  commits: GraphCommit[]
  hasMore: boolean
}

interface Flight {
  promise: unknown
  controller: AbortController
}

export class GitService {
  constructor(
    private readonly runner: GitRunner,
    private readonly gate: WorkspaceGate,
  ) {}

  /**
   * In-flight only: entries are keyed by operation, never cached after settle.
   * A deadline timer evicts the entry unconditionally, so a promise that never
   * settles (hung git) cannot wedge its key for the lifetime of the process.
   */
  private readonly flights = new Map<string, Flight>()

  private shareFlight<T>(key: string, deadlineMs: number, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const existing = this.flights.get(key)
    if (existing !== undefined) return existing.promise as Promise<T>
    const controller = new AbortController()
    const promise = start(controller.signal)
    const entry: Flight = { promise, controller }
    this.flights.set(key, entry)
    const evict = (): void => {
      if (this.flights.get(key) === entry) this.flights.delete(key)
    }
    const timer = setTimeout(() => {
      controller.abort(new Error(`git deadline exceeded: ${key}`))
      evict()
    }, deadlineMs)
    timer.unref?.()
    const settle = (): void => {
      clearTimeout(timer)
      evict()
    }
    void promise.then(settle, settle)
    return promise
  }

  async gatePath(path: string): Promise<string | null> {
    const gated = await this.gate(path)
    return gated.ok ? gated.canonical : null
  }

  /** Shared preamble for every mutating operation. */
  private async resolveRoot(path: string): Promise<{ ok: true; root: string } | { ok: false; error: GitError }> {
    const gated = await this.gate(path)
    if (!gated.ok) return { ok: false, error: WORKSPACE_UNKNOWN }
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return { ok: false, error: NOT_A_REPOSITORY }
    return { ok: true, root }
  }

  status(path: string): Promise<RepoStatus | null> {
    return this.shareFlight(`status::${path}`, STATUS_DEADLINE_MS, async (signal) => {
      const snap = await this.lightSnapshot(path, signal)
      return snap === null ? null : toStatus(snap)
    })
  }

  panel(path: string, limit = 200): Promise<PanelView | null> {
    return this.shareFlight(`panel::${path}::${limit}`, READ_DEADLINE_MS, async (signal) => {
      const snap = await this.fullSnapshot(path, limit, signal)
      if (snap === null) return null
      return { status: toStatus(snap), branches: toBranches(snap), graph: toGraph(snap) }
    })
  }

  private async lightSnapshot(path: string, signal: AbortSignal): Promise<LightSnapshot | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical, signal)
    if (root === null) return null
    const read = { signal, deadlineMs: STATUS_DEADLINE_MS }
    const [identity, porcelain, markers] = await Promise.all([
      this.runner.run(identityArgv(), root, read),
      this.runner.run(statusPorcelainArgv(), root, read),
      this.runner.run(operationMarkersArgv(), root, read),
    ])
    return this.buildLight(
      root,
      requireCompleted(identity, 'git rev-parse'),
      requireCompleted(porcelain, 'git status'),
      await this.operationFromMarkers(root, requireCompleted(markers, 'git rev-parse --git-path'), signal),
    )
  }

  private async fullSnapshot(path: string, limit: number, signal: AbortSignal): Promise<FullSnapshot | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical, signal)
    if (root === null) return null
    const read = { signal, deadlineMs: READ_DEADLINE_MS }
    const [identity, porcelain, markers, refs] = await Promise.all([
      this.runner.run(identityArgv(), root, read),
      this.runner.run(statusPorcelainArgv(), root, read),
      this.runner.run(operationMarkersArgv(), root, read),
      this.runner.run(forEachRefArgv(), root, read),
    ])
    const light = this.buildLight(
      root,
      requireCompleted(identity, 'git rev-parse'),
      requireCompleted(porcelain, 'git status'),
      await this.operationFromMarkers(root, requireCompleted(markers, 'git rev-parse --git-path'), signal),
    )
    // Scope history to the current branch so unrelated refs (stale
    // cherry-picks, other remotes) don't fan out the lane graph.
    // Detached HEAD falls back to all refs.
    const logResult = await this.runner.run(
      graphLogArgv(limit + 1, light.branch === '' ? undefined : light.branch),
      root,
      read,
    )
    const commits = parseGraph(requireCompleted(logResult, 'git log').stdout)
    const hasMore = commits.length > limit
    return {
      ...light,
      branchRows: parseBranches(requireCompleted(refs, 'git for-each-ref').stdout),
      commits: hasMore ? commits.slice(0, limit) : commits,
      hasMore,
    }
  }

  private buildLight(root: string, identity: GitRunResult, porcelain: GitRunResult, operationInProgress: boolean): LightSnapshot {
    const [branchRaw = '', headRaw = ''] = identity.stdout.split('\n').map((line) => line.trim())
    return {
      root,
      branch: branchRaw === DETACHED ? '' : branchRaw,
      head: headRaw === DETACHED ? '' : headRaw,
      counts: parsePorcelain(porcelain.stdout),
      operationInProgress,
    }
  }

  /** Reads the batched marker probe, falling back to per-marker probes only when it failed. */
  private async operationFromMarkers(root: string, markers: GitRunResult, signal: AbortSignal): Promise<boolean> {
    if (markers.exitCode === 0) return this.markersPresent(root, markers.stdout)
    return this.operationInProgress(root, signal)
  }

  private markersPresent(root: string, stdout: string): boolean {
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .some((markerPath) => existsSync(resolve(root, markerPath)))
  }

  async switchBranch(path: string, branch: string): Promise<SwitchResult> {
    if (isUnsafeRefValue(branch)) {
      return { ok: false, error: { code: 'invalid-branch-name', message: `invalid branch name: "${branch.slice(0, 100)}"` } }
    }
    const resolved = await this.resolveRoot(path)
    if (!resolved.ok) return resolved
    const { root } = resolved
    const mutate = { deadlineMs: MUTATION_DEADLINE_MS }
    const formatted = await this.runner.run(checkRefFormatArgv(branch), root, mutate)
    if (formatted.timedOut === true) return { ok: false, error: timedOut('git check-ref-format') }
    if (formatted.exitCode !== 0) {
      return { ok: false, error: { code: 'invalid-branch-name', message: formatted.stderr.trim() || 'invalid branch name' } }
    }
    const verified = await this.runner.run(verifyRefArgv(branch), root, mutate)
    if (verified.exitCode !== 0) {
      return { ok: false, error: { code: 'target-branch-not-found', message: `branch "${branch}" does not exist locally` } }
    }
    const currentResult = await this.runner.run(headBranchArgv(), root, mutate)
    if (currentResult.stdout.trim() === branch) return { ok: true, branch }
    const blocked = await this.guardBlock(root, branch)
    if (blocked !== null) return { ok: false, error: blocked }
    const switched = await this.runner.run(switchArgv(branch), root, mutate)
    if (switched.timedOut === true) return { ok: false, error: timedOut('git switch') }
    if (switched.exitCode === 0) return { ok: true, branch }
    return { ok: false, error: classifySwitchFailure(switched.stderr) }
  }

  async createBranch(path: string, name: string): Promise<SwitchResult> {
    const mirrorReason = validateBranchName(name)
    if (mirrorReason !== null) {
      return { ok: false, error: { code: 'invalid-branch-name', message: `invalid branch name: ${mirrorReason}` } }
    }
    const resolved = await this.resolveRoot(path)
    if (!resolved.ok) return resolved
    const { root } = resolved
    const mutate = { deadlineMs: MUTATION_DEADLINE_MS }
    const formatted = await this.runner.run(checkRefFormatArgv(name), root, mutate)
    if (formatted.timedOut === true) return { ok: false, error: timedOut('git check-ref-format') }
    if (formatted.exitCode !== 0) {
      return { ok: false, error: { code: 'invalid-branch-name', message: formatted.stderr.trim() || 'invalid branch name' } }
    }
    const exists = await this.runner.run(verifyRefArgv(name), root, mutate)
    if (exists.exitCode === 0) {
      return { ok: false, error: { code: 'branch-already-exists', message: `branch "${name}" already exists` } }
    }
    const blocked = await this.guardBlock(root, undefined)
    if (blocked !== null) return { ok: false, error: blocked }
    const created = await this.runner.run(createBranchArgv(name), root, mutate)
    if (created.timedOut === true) return { ok: false, error: timedOut('git switch -c') }
    if (created.exitCode === 0) return { ok: true, branch: name }
    return { ok: false, error: classifySwitchFailure(created.stderr) }
  }

  async pull(path: string): Promise<PullResult> {
    const resolved = await this.resolveRoot(path)
    if (!resolved.ok) return resolved
    const { root } = resolved
    // pull writes the working tree, so it respects the same guards as a switch.
    const blocked = await this.guardBlock(root, undefined)
    if (blocked !== null) return { ok: false, error: blocked }
    const pulled = await this.runner.run(pullArgv(), root, { deadlineMs: NETWORK_DEADLINE_MS })
    if (pulled.timedOut === true) return { ok: false, error: timedOut('git pull') }
    if (pulled.exitCode === 0) return { ok: true, output: pulled.stdout.trim() }
    return { ok: false, error: { code: 'internal', message: failureMessage(pulled, 'git pull failed') } }
  }

  async fetch(path: string): Promise<PullResult> {
    const resolved = await this.resolveRoot(path)
    if (!resolved.ok) return resolved
    const { root } = resolved
    const read = { deadlineMs: MUTATION_DEADLINE_MS }
    const refs = await this.runner.run(forEachRefArgv(), root, read)
    const upstream = parseBranches(refs.stdout).find((b) => b.current)?.upstream ?? ''
    const slash = upstream.indexOf('/')
    if (upstream === '' || slash < 0) {
      return { ok: false, error: { code: 'internal', message: 'no upstream configured' } }
    }
    const fetched = await this.runner.run(
      fetchArgv(upstream.slice(0, slash), upstream.slice(slash + 1)),
      root,
      { deadlineMs: NETWORK_DEADLINE_MS },
    )
    if (fetched.timedOut === true) return { ok: false, error: timedOut('git fetch') }
    if (fetched.exitCode === 0) return { ok: true, output: fetched.stdout.trim() }
    return { ok: false, error: { code: 'internal', message: failureMessage(fetched, 'git fetch failed') } }
  }

  async commitDetail(path: string, oid: string): Promise<CommitDetail | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return null
    const clean = oid.trim()
    if (!/^[0-9a-f]{4,40}$/i.test(clean)) return null
    const read = { deadlineMs: READ_DEADLINE_MS }
    const verified = await this.runner.run(verifyCommitArgv(clean), root, read)
    if (verified.exitCode !== 0) return null
    const [header, files, numstat] = await Promise.all([
      this.runner.run(commitHeaderArgv(clean), root, read),
      this.runner.run(commitFilesArgv(clean), root, read),
      this.runner.run(commitNumstatArgv(clean), root, read),
    ])
    const record = header.stdout.split('\u001e')[0]?.replace(/^\n/, '') ?? ''
    const [fullOid, parentsRaw, author, authorTimeRaw, decoration, subject, body] = record.split('\u0000')
    if (fullOid === undefined || fullOid === '') return null
    const totals = parseNumstat(numstat.stdout)
    const trimmedBody = (body ?? '').trim()
    return {
      oid: fullOid,
      parents: parentsRaw === undefined || parentsRaw === '' ? [] : parentsRaw.split(' '),
      subject: subject ?? '',
      body: trimmedBody === '' ? undefined : trimmedBody.slice(0, 2000),
      author: author ?? '',
      authorTime: Number(authorTimeRaw ?? '0'),
      refs: parseDecoration(decoration ?? ''),
      files: parseNameStatus(files.stdout),
      filesChanged: totals.filesChanged,
      insertions: totals.insertions,
      deletions: totals.deletions,
    }
  }

  async worktrees(path: string): Promise<WorktreeListView | null> {
    return this.shareFlight(`worktrees::${path}`, WORKTREE_DEADLINE_MS, async (signal) => {
      const gated = await this.gate(path)
      if (!gated.ok) return null
      const root = await this.repoRoot(gated.canonical, signal)
      if (root === null) return null
      const result = await this.runner.run(worktreeListArgv(), root, { signal, deadlineMs: WORKTREE_DEADLINE_MS })
      if (result.exitCode !== 0) return null
      return { root, worktrees: parseWorktrees(result.stdout) }
    })
  }

  async addWorktree(path: string, rawName: string, baseRef?: string): Promise<WorktreeAddResult> {
    const name = sanitizeWorktreeName(rawName)
    if (name === null) {
      return { ok: false, error: { code: 'invalid-worktree-name', message: `invalid worktree name: ${JSON.stringify(rawName)}` } }
    }
    const resolved = await this.resolveRoot(path)
    if (!resolved.ok) return resolved
    const { root } = resolved
    const mutate = { deadlineMs: MUTATION_DEADLINE_MS }
    const branch = WORKTREE_BRANCH_PREFIX + name
    const formatted = await this.runner.run(checkRefFormatArgv(branch), root, mutate)
    if (formatted.exitCode !== 0) {
      return { ok: false, error: { code: 'invalid-worktree-name', message: formatted.stderr.trim() || 'invalid worktree name' } }
    }
    const branchExists = await this.runner.run(verifyRefArgv(branch), root, mutate)
    if (branchExists.exitCode === 0) {
      return { ok: false, error: { code: 'worktree-already-exists', message: `branch "${branch}" already exists` } }
    }
    const target = worktreePathFor(root, name)
    if (existsSync(target)) {
      return { ok: false, error: { code: 'worktree-already-exists', message: `worktree path already exists: ${target}` } }
    }
    let base = baseRef === undefined || baseRef.trim() === '' ? 'HEAD' : baseRef.trim()
    if (isUnsafeRefValue(base)) {
      return { ok: false, error: { code: 'base-ref-not-found', message: `base ref "${base.slice(0, 100)}" does not resolve` } }
    }
    const verified = await this.runner.run(verifyRevArgv(base), root, mutate)
    if (verified.exitCode !== 0) {
      if (base === 'origin/HEAD') {
        base = 'HEAD'
      } else {
        return { ok: false, error: { code: 'base-ref-not-found', message: `base ref "${base}" does not resolve` } }
      }
    }
    if (await this.operationInProgress(root)) {
      return { ok: false, error: { code: 'operation-in-progress', message: 'a git operation is in progress' } }
    }
    await mkdir(repoWorktreesDir(root), { recursive: true })
    const added = await this.runner.run(worktreeAddArgv(target, branch, base), root, mutate)
    if (added.timedOut === true) return { ok: false, error: timedOut('git worktree add') }
    if (added.exitCode === 0) return { ok: true, path: target, branch, name }
    return { ok: false, error: classifySwitchFailure(added.stderr) }
  }

  async removeWorktree(
    path: string,
    worktreePath: string,
    opts: { force?: boolean; deleteBranch?: boolean } = {},
  ): Promise<WorktreeRemoveResult> {
    if (isUnsafeRefValue(worktreePath)) {
      return { ok: false, error: { code: 'worktree-not-found', message: 'not a managed worktree of this repository' } }
    }
    const resolved = await this.resolveRoot(path)
    if (!resolved.ok) return resolved
    const { root } = resolved
    let canonical: string
    try {
      canonical = await realpath(worktreePath)
    } catch {
      return { ok: false, error: { code: 'worktree-not-found', message: `worktree path does not resolve: ${worktreePath}` } }
    }
    let canonicalHome: string
    try {
      canonicalHome = await realpath(repoWorktreesDir(root))
    } catch {
      return { ok: false, error: { code: 'worktree-not-found', message: 'this repository has no managed worktree directory' } }
    }
    if (!isManagedWorktreeOf(canonicalHome, canonical)) {
      return { ok: false, error: { code: 'worktree-not-found', message: 'not a managed worktree of this repository' } }
    }
    const listed = await this.runner.run(worktreeListArgv(), root, { deadlineMs: MUTATION_DEADLINE_MS })
    const matches = await Promise.all(parseWorktrees(listed.stdout).map(async (item) => {
      try {
        return (await realpath(item.path)) === canonical ? item : undefined
      } catch {
        return undefined
      }
    }))
    const entry = matches.find((item) => item !== undefined)
    if (entry === undefined) {
      return { ok: false, error: { code: 'worktree-not-found', message: `git does not list ${canonical} as a worktree` } }
    }
    if (entry.main) {
      return { ok: false, error: { code: 'worktree-is-main', message: 'the primary checkout cannot be removed' } }
    }
    if (opts.force !== true) {
      const porcelain = await this.runner.run(statusPorcelainArgv(), canonical, { deadlineMs: STATUS_DEADLINE_MS })
      const counts = parsePorcelain(porcelain.stdout)
      if (counts.dirtyFiles + counts.untrackedFiles + counts.conflicts > 0) {
        return { ok: false, error: { code: 'worktree-dirty', message: 'the worktree has uncommitted changes' } }
      }
      if (await this.operationInProgress(canonical)) {
        return { ok: false, error: { code: 'operation-in-progress', message: 'a git operation is in progress in the worktree' } }
      }
    }
    const removed = await this.runner.run(worktreeRemoveArgv(canonical, opts.force === true), root, { deadlineMs: MUTATION_DEADLINE_MS })
    if (removed.timedOut === true) return { ok: false, error: timedOut('git worktree remove') }
    if (removed.exitCode !== 0) {
      return { ok: false, error: { code: 'internal', message: removed.stderr.trim() || 'git worktree remove failed' } }
    }
    if (opts.deleteBranch !== true || !entry.branch.startsWith(WORKTREE_BRANCH_PREFIX)) {
      return { ok: true, branchDeleted: false }
    }
    // Only force when the caller asked for it; otherwise git refuses to drop
    // unmerged work, and that refusal is reported instead of being discarded.
    const deleted = await this.runner.run(
      branchDeleteArgv(entry.branch, opts.force === true),
      root,
      { deadlineMs: MUTATION_DEADLINE_MS },
    )
    if (deleted.exitCode === 0) return { ok: true, branchDeleted: true }
    return {
      ok: true,
      branchDeleted: false,
      branchDeleteError: deleted.stderr.trim() || `branch ${entry.branch} was not deleted`,
    }
  }

  private async repoRoot(path: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.runner.run(topLevelArgv(), path, { signal, deadlineMs: STATUS_DEADLINE_MS })
    requireCompleted(result, 'git rev-parse --show-toplevel')
    if (result.exitCode !== 0) return null
    const root = result.stdout.trim()
    return root === '' ? null : root
  }

  private async operationInProgress(root: string, signal?: AbortSignal): Promise<boolean> {
    const resolved = await this.runner.run(operationMarkersArgv(), root, { signal, deadlineMs: STATUS_DEADLINE_MS })
    if (resolved.exitCode === 0) return this.markersPresent(root, resolved.stdout)
    const checks = await Promise.all(OPERATION_MARKERS.map(async (marker) => {
      const single = await this.runner.run(gitPathArgv(marker), root, { signal, deadlineMs: STATUS_DEADLINE_MS })
      const markerPath = single.stdout.trim()
      return markerPath !== '' && existsSync(resolve(root, markerPath))
    }))
    return checks.some(Boolean)
  }

  private async guardBlock(root: string, target: string | undefined): Promise<GitError | null> {
    const [conflicts, inProgress, worktrees] = await Promise.all([
      this.runner.run(unmergedArgv(), root, { deadlineMs: MUTATION_DEADLINE_MS }),
      this.operationInProgress(root),
      target === undefined ? Promise.resolve(null) : this.runner.run(worktreeListArgv(), root, { deadlineMs: MUTATION_DEADLINE_MS }),
    ])
    const conflictCount = conflicts.stdout.split('\n').filter(line => line !== '').length
    if (conflictCount > 0) {
      return { code: 'conflicts-present', message: `repository has ${conflictCount} unresolved conflict(s)` }
    }
    if (inProgress) {
      return { code: 'operation-in-progress', message: 'a git operation is in progress' }
    }
    if (target !== undefined && worktrees !== null && parseWorktreeBranches(worktrees.stdout).includes(target)) {
      return { code: 'branch-in-other-worktree', message: `branch "${target}" is checked out in another worktree` }
    }
    return null
  }
}

function failureMessage(result: GitRunResult, fallback: string): string {
  const stderr = result.stderr.trim()
  if (stderr !== '') return stderr
  const stdout = result.stdout.trim()
  return stdout !== '' ? stdout : fallback
}

function toStatus(snap: LightSnapshot): RepoStatus {
  return {
    root: snap.root,
    branch: snap.branch,
    head: snap.head,
    dirtyFiles: snap.counts.dirtyFiles,
    untrackedFiles: snap.counts.untrackedFiles,
    conflicts: snap.counts.conflicts,
    operationInProgress: snap.operationInProgress,
  }
}

function toBranches(snap: FullSnapshot): BranchesView {
  return {
    root: snap.root,
    branch: snap.branch,
    branches: snap.branchRows,
    dirtyFiles: snap.counts.dirtyFiles,
    untrackedFiles: snap.counts.untrackedFiles,
    conflicts: snap.counts.conflicts,
    operationInProgress: snap.operationInProgress,
  }
}

function toGraph(snap: FullSnapshot): GraphView {
  return {
    root: snap.root,
    branch: snap.branch,
    commits: snap.commits,
    hasMore: snap.hasMore,
  }
}
