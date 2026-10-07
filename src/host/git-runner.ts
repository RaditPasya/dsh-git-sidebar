
export interface GitRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  /** Set when the command was killed because its deadline fired. */
  timedOut?: boolean
}

export interface GitRunOptions {
  /** Caller cancellation. Combined with the per-command deadline. */
  signal?: AbortSignal
  /** Per-command ceiling. Defaults to DEFAULT_COMMAND_DEADLINE_MS. */
  deadlineMs?: number
}

export interface GitRunner {
  run(argv: readonly string[], cwd: string, options?: GitRunOptions): Promise<GitRunResult>
}

export const OUTPUT_CAP_BYTES = 1 << 20

/** TERM-to-KILL cleanup grace. This is not a timeout; deadlines are separate. */
const TERMINATION_GRACE_MS = 10_000

/**
 * Every git command is bounded. `GitRunner` callers own their own budgets, but
 * no invocation is allowed to run forever: an unbounded `git status` on a
 * network mount would otherwise pin a shared flight open indefinitely.
 */
export const DEFAULT_COMMAND_DEADLINE_MS = 20_000

/** Mirrors the shell convention for "terminated by timeout". */
export const TIMEOUT_EXIT_CODE = 124

const TIMEOUT_STDERR = 'git: command deadline exceeded'

export interface SubprocessServiceLike {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: {
      stdin: 'ignore'
      stdout: { maxBytes: number }
      stderr: { maxBytes: number }
    }
    graceMs: number
    signal?: AbortSignal
  }): {
    done: Promise<{ exitCode: number | null }>
    collected: {
      stdout?: { readFrom(offset: number): { text: string } }
      stderr?: { readFrom(offset: number): { text: string } }
    }
  }
}

export interface GitRunnerOptions {
  spawnArgv?: (argv: readonly string[]) => readonly string[]
}

function readCollected(stream: { readFrom(offset: number): { text: string } } | undefined): string {
  if (stream === undefined) return ''
  try {
    return stream.readFrom(0).text
  } catch {
    return ''
  }
}

export function subprocessRunner(ctx: { subprocess: SubprocessServiceLike }, options: GitRunnerOptions = {}): GitRunner {
  const spawnArgv = options.spawnArgv ?? ((argv) => ['git', ...argv])
  return {
    async run(argv, cwd, runOptions = {}) {
      const parent = runOptions.signal
      // The only signal source is the caller's operation deadline, so an
      // already-aborted signal means the budget is spent, not that the request
      // was cancelled externally.
      if (parent?.aborted === true) {
        return { exitCode: TIMEOUT_EXIT_CODE, stdout: '', stderr: TIMEOUT_STDERR, timedOut: true }
      }
      const deadline = new AbortController()
      const timer = setTimeout(() => {
        deadline.abort(new Error(TIMEOUT_STDERR))
      }, runOptions.deadlineMs ?? DEFAULT_COMMAND_DEADLINE_MS)
      timer.unref?.()
      const signal = parent === undefined ? deadline.signal : AbortSignal.any([parent, deadline.signal])
      let removeAbortListener: (() => void) | undefined
      try {
        const handle = ctx.subprocess.spawn({
          argv: spawnArgv(argv),
          cwd,
          stdio: {
            stdin: 'ignore' as const,
            stdout: { maxBytes: OUTPUT_CAP_BYTES },
            stderr: { maxBytes: OUTPUT_CAP_BYTES },
          },
          graceMs: TERMINATION_GRACE_MS,
          signal,
        })
        // The abort already asks the subprocess layer to terminate the process.
        // Racing it here as well means a provider that never settles `done` on
        // abort still cannot park this call forever.
        const abortRace = new Promise<never>((_, reject) => {
          const onAbort = (): void => { reject(new Error(TIMEOUT_STDERR)) }
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
          removeAbortListener = () => { signal.removeEventListener('abort', onAbort) }
        })
        let exitCode: number | null = null
        let failed: unknown
        try {
          exitCode = (await Promise.race([handle.done, abortRace])).exitCode
        } catch (error) {
          failed = error
        }
        const stdout = readCollected(handle.collected.stdout)
        const stderr = readCollected(handle.collected.stderr)
        // Either deadline (this command's or the enclosing operation's) means
        // the same thing to the caller: the result is not trustworthy.
        if (signal.aborted) {
          return {
            exitCode: TIMEOUT_EXIT_CODE,
            stdout,
            stderr: stderr !== '' ? stderr : TIMEOUT_STDERR,
            timedOut: true,
          }
        }
        if (failed !== undefined) throw failed
        return { exitCode, stdout, stderr }
      } finally {
        clearTimeout(timer)
        removeAbortListener?.()
      }
    },
  }
}
