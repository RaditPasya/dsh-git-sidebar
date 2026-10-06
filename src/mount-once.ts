
const MOUNTED = Symbol.for('dsh-web-git-sidebar.mounted-plugins')

const WAITERS = Symbol.for('dsh-web-git-sidebar.mounted-plugins.waiters')

interface MountContext {
  effect?: (effect: () => unknown) => unknown
}

interface PendingMount {
  run(): void
}

interface MountRegistry {
  [MOUNTED]?: unknown
  [WAITERS]?: Map<string, PendingMount[]>
}

function mountedSet(): Set<string> {
  const registry = globalThis as MountRegistry
  const existing = registry[MOUNTED]
  if (existing instanceof Set) return existing as Set<string>
  const created = new Set<string>()
  registry[MOUNTED] = created
  return created
}

function mountWaiters(): Map<string, PendingMount[]> {
  const registry = globalThis as MountRegistry
  return (registry[WAITERS] ??= new Map())
}

export function mountOnce<T extends (...args: any[]) => unknown>(packageName: string, fn: T): T {
  const mount = (...args: unknown[]): unknown => {
    const mounted = mountedSet()
    const ctx = args[0] as MountContext | undefined
    if (mounted.has(packageName)) {
      const waiters = mountWaiters()
      const queue = waiters.get(packageName) ?? []
      let alive = true
      const pending: PendingMount = {
        run: () => {
          if (alive) mount(...args)
        },
      }
      ctx?.effect?.(() => () => {
        alive = false
        const index = queue.indexOf(pending)
        if (index >= 0) queue.splice(index, 1)
      })
      queue.push(pending)
      waiters.set(packageName, queue)
      return
    }
    mounted.add(packageName)
    ctx?.effect?.(() => () => {
      mounted.delete(packageName)
      const waiters = mountWaiters()
      const queue = waiters.get(packageName)
      if (queue === undefined) return
      waiters.delete(packageName)
      for (const waiter of queue.splice(0)) queueMicrotask(() => { waiter.run() })
    })
    return fn(...args)
  }
  return mount as T
}
