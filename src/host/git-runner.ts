
export interface GitRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface GitRunner {
  run(argv: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitRunResult>
}

export const OUTPUT_CAP_BYTES = 1 << 20

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
  failureMode?: 'throw' | 'degrade'
  errorTag?: string
}

export function subprocessRunner(ctx: { subprocess: SubprocessServiceLike }, options: GitRunnerOptions = {}): GitRunner {
  const spawnArgv = options.spawnArgv ?? ((argv) => ['git', ...argv])
  const degrade = options.failureMode === 'degrade'
  const errorTag = options.errorTag ?? 'git'
  const failure = (prefix: string, error: unknown): GitRunResult => ({
    exitCode: 127,
    stdout: '',
    stderr: prefix + (error instanceof Error ? error.message : String(error)),
  })
  return {
    async run(argv, cwd, signal) {
      signal?.throwIfAborted()
      const spec = {
        argv: spawnArgv(argv),
        cwd,
        stdio: {
          stdin: 'ignore' as const,
          stdout: { maxBytes: OUTPUT_CAP_BYTES },
          stderr: { maxBytes: OUTPUT_CAP_BYTES },
        },
        graceMs: 10_000,
        signal,
      }
      if (degrade) {
        let handle
        try {
          handle = ctx.subprocess.spawn(spec)
        } catch (error) {
          signal?.throwIfAborted()
          console.error('[' + errorTag + '] git spawn failed:', error)
          return failure('git: spawn failed: ', error)
        }
        try {
          const outcome = await handle.done
          signal?.throwIfAborted()
          const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
          const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
          return { exitCode: outcome.exitCode, stdout, stderr }
        } catch (error) {
          signal?.throwIfAborted()
          console.error('[' + errorTag + '] git run failed:', error)
          return failure('git: run failed: ', error)
        }
      }
      const handle = ctx.subprocess.spawn(spec)
      const outcome = await handle.done
      signal?.throwIfAborted()
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      return { exitCode: outcome.exitCode, stdout, stderr }
    },
  }
}
