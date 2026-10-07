
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  /**
   * Reserved. Accepted and surfaced so existing configs keep validating, but no
   * code path reads it yet — automatic worktree isolation is not implemented.
   */
  autoIsolate: Volatile<boolean>
  /** Reserved alongside {@link Config.autoIsolate}; likewise unread. */
  autoBaseline: Volatile<'current' | 'default'>
  /** Registers the `git_worktree` agent tool while enabled. */
  agentTool: Volatile<boolean>
}

export interface ConfigInput {
  autoIsolate?: boolean
  autoBaseline?: 'current' | 'default'
  agentTool?: boolean
}

export type ResolvedConfig = Required<ConfigInput>

export const Config: z<ConfigInput, Config> = z.object({
  autoIsolate: z.boolean().default(false).volatile(),
  autoBaseline: z.union(['current', 'default'] as const).default('current').volatile(),
  agentTool: z.boolean().default(false).volatile(),
})

/**
 * Resolves the volatile config readers. `autoIsolate`/`autoBaseline` are
 * carried through for compatibility only; `agentTool` is the sole key that
 * currently drives behaviour.
 */
export function effectiveConfig(config?: Config): ResolvedConfig {
  return {
    autoIsolate: config?.autoIsolate?.get() ?? false,
    autoBaseline: config?.autoBaseline?.get() ?? 'current',
    agentTool: config?.agentTool?.get() ?? false,
  }
}
