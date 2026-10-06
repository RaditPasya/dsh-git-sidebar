
export interface PollTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const DEFAULT_TIMERS: PollTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

export interface PollGuardOptions {
  intervalMs: number
  deadlineMs: number
  maxBackoffMs: number
  timers?: PollTimers
  onDeadline?: () => void
  onSettled?: (consecutiveFailures: number) => void
  onRun: () => Promise<void>
}

export class PollGuard {
  private readonly options: Required<PollGuardOptions>
  private handle: unknown
  private running = false
  private startedAt = 0
  private stopped = false
  private failures = 0

  constructor(options: PollGuardOptions) {
    this.options = {
      timers: DEFAULT_TIMERS,
      onDeadline: () => {},
      onSettled: () => {},
      ...options,
    }
  }

  start(): void {
    if (this.startedAt !== 0) return
    this.startedAt = Date.now()
    this.schedule(this.options.intervalMs)
  }

  stop(): void {
    this.stopped = true
    this.options.timers.clear(this.handle)
    this.handle = undefined
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    this.handle = this.options.timers.set(() => { void this.tick() }, delayMs)
  }

  private delay(): number {
    const backoff = this.options.intervalMs * 2 ** Math.min(this.failures, 8)
    return Math.min(backoff, this.options.maxBackoffMs)
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    if (this.running) return // Anti-overlap: drop ticks that arrive mid-run.
    if (Date.now() - this.startedAt >= this.options.deadlineMs) {
      this.stopped = true
      this.options.onDeadline()
      return
    }
    this.running = true
    try {
      await this.options.onRun()
      this.failures = 0
    } catch {
      this.failures += 1
    } finally {
      this.running = false
      this.options.onSettled(this.failures)
      this.schedule(this.delay())
    }
  }
}
