
import type { GitError, GitErrorCode } from './types.ts'

export const topLevelArgv = (): string[] => ['rev-parse', '--show-toplevel']

export const headBranchArgv = (): string[] => ['rev-parse', '--abbrev-ref', 'HEAD']

export const identityArgv = (): string[] => ['rev-parse', '--abbrev-ref', 'HEAD', '--short', 'HEAD']

export const headShortArgv = (): string[] => ['rev-parse', '--short', 'HEAD']

export const forEachRefArgv = (): string[] => [
  'for-each-ref', 'refs/heads',
  '--format=%(refname:short)%00%(HEAD)%00%(objectname)%00%(upstream:short)%00%(upstream:track)',
]

export const commitFilesArgv = (oid: string): string[] => [
  'show', '--name-status', '--no-renames', '--format=',
  oid, '--',
]

export const commitNumstatArgv = (oid: string): string[] => [
  'show', '--numstat', '--format=',
  oid, '--',
]

export const commitHeaderArgv = (oid: string): string[] => [
  'show', '-s',
  '--format=%H%x00%P%x00%an%x00%at%x00%D%x00%s%x00%b%x1e',
  oid, '--',
]

export const verifyCommitArgv = (oid: string): string[] => ['rev-parse', '--verify', '--quiet', `${oid}^{commit}`, '--']

export const statusPorcelainArgv = (): string[] => ['status', '--porcelain']

export const unmergedArgv = (): string[] => ['diff', '--name-only', '--diff-filter=U']

export const worktreeListArgv = (): string[] => ['worktree', 'list', '--porcelain']

export const worktreeAddArgv = (path: string, branch: string, baseRef: string): string[] => [
  'worktree', 'add', '-b', branch, path, baseRef,
]

export const worktreeRemoveArgv = (path: string, force: boolean): string[] =>
  force ? ['worktree', 'remove', '--force', path] : ['worktree', 'remove', path]

export const branchDeleteForceArgv = (name: string): string[] => ['branch', '-D', '--', name]

export const verifyRevArgv = (rev: string): string[] => ['rev-parse', '--verify', '--quiet', rev, '--']

export const WORKTREE_BRANCH_PREFIX = 'wt/'

export function sanitizeWorktreeName(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 64)
    .replace(/[-.]+$/, '')
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return null
  return cleaned
}

export const verifyRefArgv = (branch: string): string[] => ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`, '--']

export const checkRefFormatArgv = (name: string): string[] => ['check-ref-format', '--branch', name]

export const switchArgv = (branch: string): string[] => ['switch', '--no-guess', '--', branch]

export const createBranchArgv = (name: string): string[] => ['switch', '--no-guess', '-c', name, '--']

export const pullArgv = (): string[] => ['pull', '--ff-only']

export const fetchArgv = (remote: string, branch: string): string[] => ['fetch', '--quiet', '--', remote, branch]

export const graphLogArgv = (limit: number): string[] => [
  'log', '--branches', '--tags', '--remotes', '--topo-order', '--parents',
  '--format=%H%x00%P%x00%an%x00%at%x00%D%x00%s%x1e',
  '--max-count', String(Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 200))),
]

export const OPERATION_MARKERS = [
  'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG',
  'rebase-merge', 'rebase-apply', 'sequencer',
] as const

export const gitPathArgv = (marker: string): string[] => ['rev-parse', '--git-path', marker]

export const operationMarkersArgv = (): string[] => [
  'rev-parse',
  ...OPERATION_MARKERS.flatMap((marker) => ['--git-path', marker]),
]

interface OverwritePattern {
  code: Extract<GitErrorCode, 'tracked-changes-would-be-overwritten' | 'untracked-changes-would-be-overwritten'>
  header: RegExp
  end?: RegExp
}

const OVERWRITE_PATTERNS: OverwritePattern[] = [
  {
    code: 'tracked-changes-would-be-overwritten',
    header: /Your local changes to the following files would be overwritten by checkout/,
  },
  {
    code: 'untracked-changes-would-be-overwritten',
    header: /The following untracked working tree files would be overwritten by checkout/,
  },
  {
    code: 'tracked-changes-would-be-overwritten',
    header: /Your local changes to the following files would be overwritten by merge/,
  },
]

const gitPathEncoder = new TextEncoder()
const gitPathDecoder = new TextDecoder()

const GIT_SIMPLE_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 }

function pushEncoded(bytes: number[], text: string): void {
  const encoded = gitPathEncoder.encode(text)
  for (let i = 0; i < encoded.length; i += 1) {
    const byte = encoded[i]
    if (byte !== undefined) bytes.push(byte)
  }
}

function decodeGitQuoted(input: string): string {
  if (!input.includes('\\')) return input
  const bytes: number[] = []
  const pattern = /\\(?:([0-7]{3})|([\s\S]))/g
  let index = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input)) !== null) {
    pushEncoded(bytes, input.slice(index, match.index))
    const octal = match[1]
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8) & 0xff)
    } else {
      const escaped = match[2]!
      const control = GIT_SIMPLE_ESCAPES[escaped]
      if (control === undefined) pushEncoded(bytes, escaped)
      else bytes.push(control)
    }
    index = match.index + match[0].length
  }
  pushEncoded(bytes, input.slice(index))
  return gitPathDecoder.decode(new Uint8Array(bytes))
}

export function extractBlockedPaths(
  stderr: string,
  header: RegExp,
): { paths: string[]; moreFiles: number } {
  const found = stderr.search(header)
  if (found < 0) return { paths: [], moreFiles: 0 }
  const start = stderr.indexOf('\n', found)
  if (start === -1) return { paths: [], moreFiles: 0 }
  const paths: string[] = []
  let moreFiles = 0
  for (const line of stderr.slice(start + 1).split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || !line.startsWith('\t')) break
    if (paths.length < 2) {
      const quoted = /^"(.+)"$/.exec(trimmed)
      const path = quoted === null
        ? decodeGitQuoted(trimmed)
        : decodeGitQuoted(quoted[1] ?? '')
      paths.push(path)
    } else {
      moreFiles += 1
    }
  }
  return { paths, moreFiles }
}

export function classifySwitchFailure(stderr: string): GitError {
  const trimmed = stderr.trim()
  const cut = trimmed.indexOf('\n')
  const head = (cut < 0 ? trimmed : trimmed.slice(0, cut)).slice(0, 500)
  for (const pattern of OVERWRITE_PATTERNS) {
    if (pattern.header.test(stderr)) {
      const { paths, moreFiles } = extractBlockedPaths(stderr, pattern.header)
      return { code: pattern.code, message: head, paths, moreFiles }
    }
  }
  if (/did not match any file\(s\) known to git|invalid reference|not a valid branch/.test(stderr)) {
    return { code: 'target-branch-not-found', message: head }
  }
  if (/already used by worktree|is already checked out at/.test(stderr)) {
    return { code: 'branch-in-other-worktree', message: head }
  }
  if (/local changes to the following files would be overwritten/.test(stderr)) {
    return { code: 'tracked-changes-would-be-overwritten', message: head }
  }
  return { code: 'internal', message: head || 'git switch failed' }
}

export function validateBranchName(name: string): string | null {
  if (name === '') return 'empty'
  if (name === '@') return 'at-sign'
  if (name.startsWith('-')) return 'leading-dash'
  if (name.endsWith('.')) return 'trailing-dot'
  if (name.endsWith('.lock')) return 'lock-suffix'
  if (name.includes('..')) return 'double-dot'
  if (name.includes('@{')) return 'at-brace'
  if (name.includes('//')) return 'double-slash'
  if (name.includes(' ')) return 'space'
  if (name.includes('~') || name.includes('^') || name.includes(':')) return 'forbidden-char'
  if (name.includes('?') || name.includes('*') || name.includes('[') || name.includes('\\')) return 'forbidden-char'
  for (const ch of name) {
    const code = ch.codePointAt(0)
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return 'control-char'
  }
  for (const component of name.split('/')) {
    if (component === '') return 'empty-component'
    if (component.startsWith('.')) return 'dot-component'
    if (component.endsWith('.lock')) return 'lock-suffix'
  }
  if (name.length > 1000) return 'too-long'
  return null
}

export function isUnsafeRefValue(value: string): boolean {
  return value.startsWith('-') || value.includes('\0') || value.includes('\n')
}
