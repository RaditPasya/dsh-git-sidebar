
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isAbsolute as posixIsAbsolute, join as posixJoin } from 'node:path/posix'

export function expandHome(path: string, home: string = homedir()): string {
  const isPosix = home.startsWith('/')
  const j = isPosix ? posixJoin : join
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return j(home, path.slice(2))
  return path
}

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const isPosix = home.startsWith('/')
  const j = isPosix ? posixJoin : join
  const isAbs = isPosix ? posixIsAbsolute : isAbsolute
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const expanded = expandHome(raw.trim(), home)
    return isAbs(expanded) ? expanded : j(process.cwd(), expanded)
  }
  return j(home, '.dsh')
}

export function dshHome(): string {
  return resolveDshHome()
}
