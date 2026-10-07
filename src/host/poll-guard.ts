
/**
 * Interval scheduler with anti-overlap and a bounded idle backoff.
 *
 * `onRun` reports whether anything changed. An unchanged tick widens the delay;
 * a changed tick snaps back to the base interval. The ceiling is intentionally
 * shallow, because this poll is the only way the UI learns about changes it did
 * not cause (agent commits, git run in a terminal).
 */
export interface PollGuardOptions {
  intervalMs: number
  /** Idle ceiling. Defaults to `intervalMs`, which disables backoff entirely. */
  maxIntervalMs?: number
  onRun: () => Promise<boolean>
}

/** Pure so the backoff policy is verifiable without waiting on timers. */
export function nextInterval(currentMs: number, baseMs: number, maxMs: number, changed: boolean): number {
  if (changed) return baseMs
  return Math.min(currentMs * 2, Math.max(baseMs, maxMs))
}

export class PollGuard {
  private handle: ReturnType<typeof setTimeout> | undefined
  private running = false
  private stopped = false
  private readonly baseMs: number
  private readonly maxMs: number
  private currentMs: number

  constructor(private readonly options: PollGuardOptions) {
    this.baseMs = options.intervalMs
    this.maxMs = options.maxIntervalMs ?? options.intervalMs
    this.currentMs = this.baseMs
  }

  start(): void {
    if (this.stopped || this.handle !== undefined) return
    this.currentMs = this.baseMs
    this.schedule(this.currentMs)
  }

  stop(): void {
    this.stopped = true
    if (this.handle !== undefined) clearTimeout(this.handle)
    this.handle = undefined
  }

  /** The delay currently scheduled — observability, and the test seam. */
  interval(): number {
    return this.currentMs
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    this.handle = setTimeout(() => { void this.tick() }, delayMs)
    this.handle.unref?.()
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    if (this.running) {
      // A run outlived its interval. Keep the cadence instead of stacking.
      this.schedule(this.currentMs)
      return
    }
    this.running = true
    let changed = false
    try {
      changed = await this.options.onRun()
    } catch {
      // A thrown tick is not evidence of change, so let the backoff widen.
      changed = false
    } finally {
      this.running = false
      this.currentMs = nextInterval(this.currentMs, this.baseMs, this.maxMs, changed)
      this.schedule(this.currentMs)
    }
  }
}
