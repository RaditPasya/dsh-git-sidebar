
import { existsSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { subprocessRunner as sharedSubprocessRunner, type GitRunner } from './git-runner.ts'
import {
  branchDeleteForceArgv, checkRefFormatArgv, classifySwitchFailure, commitFilesArgv,
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
  type BranchesView, type CommitDetail, type GitError, type GraphView, type PanelView,
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

const WORKSPACE_UNKNOWN: GitError = {
  code: 'workspace-unknown',
  message: 'path is not a registered workspace',
}

export class GitService {
  constructor(
    private readonly runner: GitRunner,
    private readonly gate: WorkspaceGate,
  ) {}

  private readonly statusFlights = new Map<string, Promise<RepoStatus | null>>()

  private readonly branchesFlights = new Map<string, Promise<BranchesView | null>>()

  private readonly graphFlights = new Map<string, Promise<GraphView | null>>()

  private readonly panelFlights = new Map<string, Promise<PanelView | null>>()

  private readonly worktreesFlights = new Map<string, Promise<WorktreeListView | null>>()

  private shareFlight<T>(flights: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
    const existing = flights.get(key)
    if (existing !== undefined) return existing
    const flight = start()
    flights.set(key, flight)
    const clear = (): void => {
      if (flights.get(key) === flight) flights.delete(key)
    }
    void flight.then(clear, clear)
    return flight
  }

  private async snapshotFromRoot(root: string, signal?: AbortSignal): Promise<{
    root: string
    branch: string
    head: string
    counts: ReturnType<typeof parsePorcelain>
    operationInProgress: boolean
  }> {
    const [identity, porcelain] = await Promise.all([
      this.runner.run(identityArgv(), root, signal),
      this.runner.run(statusPorcelainArgv(), root, signal),
    ])
    const [branchRaw = '', headRaw = ''] = identity.stdout.split('\n')
    const branch = branchRaw.trim()
    return {
      root,
      branch: branch === DETACHED ? '' : branch,
      head: headRaw.trim(),
      counts: parsePorcelain(porcelain.stdout),
      operationInProgress: await this.operationInProgress(root, signal),
    }
  }

  private async snapshot(path: string, signal?: AbortSignal): Promise<Awaited<ReturnType<GitService['snapshotFromRoot']>> | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical, signal)
    if (root === null) return null
    return this.snapshotFromRoot(root, signal)
  }

  async gatePath(path: string): Promise<string | null> {
    const gated = await this.gate(path)
    return gated.ok ? gated.canonical : null
  }

  status(path: string, signal?: AbortSignal): Promise<RepoStatus | null> {
    return this.shareFlight(this.statusFlights, path, () => this.statusFromPath(path, signal))
  }

  private async statusFromPath(path: string, signal?: AbortSignal): Promise<RepoStatus | null> {
    const snap = await this.snapshot(path, signal)
    if (snap === null) return null
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

  async branches(path: string): Promise<BranchesView | null> {
    return this.shareFlight(this.branchesFlights, path, () => this.branchesFromPath(path))
  }

  private async branchesFromPath(path: string): Promise<BranchesView | null> {
    const snap = await this.snapshot(path)
    if (snap === null) return null
    const refs = await this.runner.run(forEachRefArgv(), snap.root)
    return {
      root: snap.root,
      branch: snap.branch,
      branches: parseBranches(refs.stdout),
      dirtyFiles: snap.counts.dirtyFiles,
      untrackedFiles: snap.counts.untrackedFiles,
      conflicts: snap.counts.conflicts,
      operationInProgress: snap.operationInProgress,
    }
  }

  async switchBranch(path: string, branch: string): Promise<SwitchResult> {
    if (isUnsafeRefValue(branch)) {
      return { ok: false, error: { code: 'invalid-branch-name', message: `invalid branch name: "${branch.slice(0, 100)}"` } }
    }
    const gated = await this.gate(path)
    if (!gated.ok) return { ok: false, error: WORKSPACE_UNKNOWN }
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return { ok: false, error: { code: 'internal', message: 'not a git repository' } }
    const formatted = await this.runner.run(checkRefFormatArgv(branch), root)
    if (formatted.exitCode !== 0) {
      return { ok: false, error: { code: 'invalid-branch-name', message: formatted.stderr.trim() || 'invalid branch name' } }
    }
    const verified = await this.runner.run(verifyRefArgv(branch), root)
    if (verified.exitCode !== 0) {
      return { ok: false, error: { code: 'target-branch-not-found', message: `branch "${branch}" does not exist locally` } }
    }
    const currentResult = await this.runner.run(headBranchArgv(), root)
    const current = currentResult.stdout.trim()
    if (current === branch) return { ok: true, branch }
    const blocked = await this.guardBlock(root, branch)
    if (blocked !== null) return { ok: false, error: blocked }
    const switched = await this.runner.run(switchArgv(branch), root)
    if (switched.exitCode === 0) return { ok: true, branch }
    return { ok: false, error: classifySwitchFailure(switched.stderr) }
  }

  async createBranch(path: string, name: string): Promise<SwitchResult> {
    const mirrorReason = validateBranchName(name)
    if (mirrorReason !== null) {
      return { ok: false, error: { code: 'invalid-branch-name', message: `invalid branch name: ${mirrorReason}` } }
    }
    const gated = await this.gate(path)
    if (!gated.ok) return { ok: false, error: WORKSPACE_UNKNOWN }
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return { ok: false, error: { code: 'internal', message: 'not a git repository' } }
    const formatted = await this.runner.run(checkRefFormatArgv(name), root)
    if (formatted.exitCode !== 0) {
      return { ok: false, error: { code: 'invalid-branch-name', message: formatted.stderr.trim() || 'invalid branch name' } }
    }
    const exists = await this.runner.run(verifyRefArgv(name), root)
    if (exists.exitCode === 0) {
      return { ok: false, error: { code: 'branch-already-exists', message: `branch "${name}" already exists` } }
    }
    const blocked = await this.guardBlock(root, undefined)
    if (blocked !== null) return { ok: false, error: blocked }
    const created = await this.runner.run(createBranchArgv(name), root)
    if (created.exitCode === 0) return { ok: true, branch: name }
    return { ok: false, error: classifySwitchFailure(created.stderr) }
  }

  async pull(path: string): Promise<PullResult> {
    const gated = await this.gate(path)
    if (!gated.ok) return { ok: false, error: WORKSPACE_UNKNOWN }
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return { ok: false, error: { code: 'internal', message: 'not a git repository' } }
    const pulled = await this.runner.run(pullArgv(), root)
    if (pulled.exitCode === 0) return { ok: true, output: pulled.stdout.trim() }
    const message = (pulled.stderr.trim() !== '' ? pulled.stderr : pulled.stdout).trim()
    return { ok: false, error: { code: 'internal', message: message !== '' ? message : 'git pull failed' } }
  }

  async fetch(path: string): Promise<PullResult> {
    const gated = await this.gate(path)
    if (!gated.ok) return { ok: false, error: WORKSPACE_UNKNOWN }
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return { ok: false, error: { code: 'internal', message: 'not a git repository' } }
    const refs = await this.runner.run(forEachRefArgv(), root)
    const upstream = parseBranches(refs.stdout).find((b) => b.current)?.upstream ?? ''
    const slash = upstream.indexOf('/')
    if (upstream === '' || slash < 0) {
      return { ok: false, error: { code: 'internal', message: 'no upstream configured' } }
    }
    const fetched = await this.runner.run(fetchArgv(upstream.slice(0, slash), upstream.slice(slash + 1)), root)
    if (fetched.exitCode === 0) return { ok: true, output: fetched.stdout.trim() }
    const message = (fetched.stderr.trim() !== '' ? fetched.stderr : fetched.stdout).trim()
    return { ok: false, error: { code: 'internal', message: message !== '' ? message : 'git fetch failed' } }
  }

  async graph(path: string, limit = 200): Promise<GraphView | null> {
    return this.shareFlight(this.graphFlights, `${path}::${limit}`, () => this.graphFromPath(path, limit))
  }

  private async graphFromPath(path: string, limit: number): Promise<GraphView | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return null
    const [logResult, branchResult] = await Promise.all([
      this.runner.run(graphLogArgv(limit + 1), root),
      this.runner.run(headBranchArgv(), root),
    ])
    const commits = parseGraph(logResult.stdout)
    const hasMore = commits.length > limit
    const branch = branchResult.stdout.trim()
    return {
      root,
      branch: branch === DETACHED ? '' : branch,
      commits: hasMore ? commits.slice(0, limit) : commits,
      hasMore,
    }
  }


  async commitDetail(path: string, oid: string): Promise<CommitDetail | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return null
    const clean = oid.trim()
    if (!/^[0-9a-f]{4,40}$/i.test(clean)) return null
    const verified = await this.runner.run(verifyCommitArgv(clean), root)
    if (verified.exitCode !== 0) return null
    const [header, files, numstat] = await Promise.all([
      this.runner.run(commitHeaderArgv(clean), root),
      this.runner.run(commitFilesArgv(clean), root),
      this.runner.run(commitNumstatArgv(clean), root),
    ])
    const record = header.stdout.split('\u001e')[0]?.replace(/^\n/, '') ?? ''
    const [fullOid, parentsRaw, author, authorTimeRaw, decoration, subject, body] = record.split('\u0000')
    if (fullOid === undefined || fullOid === '') return null
    const totals = parseNumstat(numstat.stdout)
    return {
      oid: fullOid,
      parents: parentsRaw === undefined || parentsRaw === '' ? [] : parentsRaw.split(' '),
      subject: subject ?? '',
      body: (body ?? '').trim() === '' ? undefined : (body ?? '').trim().slice(0, 2000),
      author: author ?? '',
      authorTime: Number(authorTimeRaw ?? '0'),
      refs: parseDecoration(decoration ?? ''),
      files: parseNameStatus(files.stdout),
      filesChanged: totals.filesChanged,
      insertions: totals.insertions,
      deletions: totals.deletions,
    }
  }

  async panel(path: string, limit = 200): Promise<PanelView | null> {
    return this.shareFlight(this.panelFlights, `${path}::${limit}`, () => this.panelFromPath(path, limit))
  }

  private async panelFromPath(path: string, limit: number): Promise<PanelView | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return null
    const [identity, porcelain, refs, logResult, markers] = await Promise.all([
      this.runner.run(identityArgv(), root),
      this.runner.run(statusPorcelainArgv(), root),
      this.runner.run(forEachRefArgv(), root),
      this.runner.run(graphLogArgv(limit + 1), root),
      this.runner.run(operationMarkersArgv(), root),
    ])
    const lines = identity.stdout.split('\n').map((line) => line.trim())
    const rawBranch = lines[0] ?? ''
    const rawHead = lines[1] ?? ''
    const branch = rawBranch === '' || rawBranch === DETACHED ? '' : rawBranch
    const head = rawHead === '' || rawHead === DETACHED ? '' : rawHead
    const counts = parsePorcelain(porcelain.stdout)
    const branchRows = parseBranches(refs.stdout)
    const commits = parseGraph(logResult.stdout)
    const hasMore = commits.length > limit
    const markerPaths = markers.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    const operationInProgress = markers.exitCode === 0
      ? markerPaths.some((markerPath) => existsSync(resolve(root, markerPath)))
      : await this.operationInProgress(root)
    const status: RepoStatus = {
      root, branch, head,
      dirtyFiles: counts.dirtyFiles,
      untrackedFiles: counts.untrackedFiles,
      conflicts: counts.conflicts,
      operationInProgress,
    }
    return {
      status,
      branches: {
        root, branch, branches: branchRows,
        dirtyFiles: counts.dirtyFiles,
        untrackedFiles: counts.untrackedFiles,
        conflicts: counts.conflicts,
        operationInProgress,
      },
      graph: {
        root, branch,
        commits: hasMore ? commits.slice(0, limit) : commits,
        hasMore,
      },
    }
  }

  async worktrees(path: string, signal?: AbortSignal): Promise<WorktreeListView | null> {
    return this.shareFlight(this.worktreesFlights, path, () => this.worktreesFromPath(path, signal))
  }

  private async worktreesFromPath(path: string, signal?: AbortSignal): Promise<WorktreeListView | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical, signal)
    if (root === null) return null
    const result = await this.runner.run(worktreeListArgv(), root, signal)
    if (result.exitCode !== 0) return null
    return { root, worktrees: parseWorktrees(result.stdout) }
  }

  async addWorktree(path: string, rawName: string, baseRef?: string): Promise<WorktreeAddResult> {
    const name = sanitizeWorktreeName(rawName)
    if (name === null) {
      return { ok: false, error: { code: 'invalid-worktree-name', message: `invalid worktree name: ${JSON.stringify(rawName)}` } }
    }
    const gated = await this.gate(path)
    if (!gated.ok) return { ok: false, error: WORKSPACE_UNKNOWN }
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return { ok: false, error: { code: 'internal', message: 'not a git repository' } }
    const branch = WORKTREE_BRANCH_PREFIX + name
    const formatted = await this.runner.run(checkRefFormatArgv(branch), root)
    if (formatted.exitCode !== 0) {
      return { ok: false, error: { code: 'invalid-worktree-name', message: formatted.stderr.trim() || 'invalid worktree name' } }
    }
    const branchExists = await this.runner.run(verifyRefArgv(branch), root)
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
    const verified = await this.runner.run(verifyRevArgv(base), root)
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
    const added = await this.runner.run(worktreeAddArgv(target, branch, base), root)
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
    const gated = await this.gate(path)
    if (!gated.ok) return { ok: false, error: WORKSPACE_UNKNOWN }
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return { ok: false, error: { code: 'internal', message: 'not a git repository' } }
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
    const listed = await this.runner.run(worktreeListArgv(), root)
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
      const porcelain = await this.runner.run(statusPorcelainArgv(), canonical)
      const counts = parsePorcelain(porcelain.stdout)
      if (counts.dirtyFiles + counts.untrackedFiles + counts.conflicts > 0) {
        return { ok: false, error: { code: 'worktree-dirty', message: 'the worktree has uncommitted changes' } }
      }
      if (await this.operationInProgress(canonical)) {
        return { ok: false, error: { code: 'operation-in-progress', message: 'a git operation is in progress in the worktree' } }
      }
    }
    const removed = await this.runner.run(worktreeRemoveArgv(canonical, opts.force === true), root)
    if (removed.exitCode !== 0) {
      return { ok: false, error: { code: 'internal', message: removed.stderr.trim() || 'git worktree remove failed' } }
    }
    if (opts.deleteBranch === true && entry.branch.startsWith(WORKTREE_BRANCH_PREFIX)) {
      await this.runner.run(branchDeleteForceArgv(entry.branch), root)
    }
    return { ok: true }
  }
  private async repoRoot(path: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.runner.run(topLevelArgv(), path, signal)
    if (result.exitCode !== 0) return null
    const root = result.stdout.trim()
    return root === '' ? null : root
  }

  private async operationInProgress(root: string, signal?: AbortSignal): Promise<boolean> {
    const resolved = await this.runner.run(operationMarkersArgv(), root, signal)
    if (resolved.exitCode === 0) {
      const markerPaths = resolved.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
      return markerPaths.some((markerPath) => existsSync(resolve(root, markerPath)))
    }
    const checks = await Promise.all(OPERATION_MARKERS.map(async (marker) => {
      const single = await this.runner.run(gitPathArgv(marker), root, signal)
      const markerPath = single.stdout.trim()
      return markerPath !== '' && existsSync(resolve(root, markerPath))
    }))
    return checks.some(Boolean)
  }

  private async guardBlock(root: string, target: string | undefined): Promise<GitError | null> {
    const [conflicts, inProgress, worktrees] = await Promise.all([
      this.runner.run(unmergedArgv(), root),
      this.operationInProgress(root),
      target === undefined ? Promise.resolve(null) : this.runner.run(worktreeListArgv(), root),
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
