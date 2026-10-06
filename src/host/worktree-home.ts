
import { createHash } from 'node:crypto'
import { basename, join, sep } from 'node:path'
import { dshHome } from './dsh-home.ts'
import { sanitizeWorktreeName } from '../core/git-command.ts'

export function worktreesHome(): string {
  return join(dshHome(), 'worktrees')
}

export function repoKeyFor(root: string): string {
  const base = sanitizeWorktreeName(basename(root)) ?? 'repo'
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

export function worktreePathFor(root: string, name: string): string {
  return join(worktreesHome(), repoKeyFor(root), name)
}

export function repoWorktreesDir(root: string): string {
  return join(worktreesHome(), repoKeyFor(root))
}

export function isManagedWorktreeOf(dir: string, candidate: string): boolean {
  if (!candidate.startsWith(dir + sep)) return false
  return !candidate.slice(dir.length + 1).includes(sep)
}