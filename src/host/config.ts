
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  autoIsolate: Volatile<boolean>
  autoBaseline: Volatile<'current' | 'default'>
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

export function effectiveConfig(config?: Config): ResolvedConfig {
  return {
    autoIsolate: config?.autoIsolate?.get() ?? false,
    autoBaseline: config?.autoBaseline?.get() ?? 'current',
    agentTool: config?.agentTool?.get() ?? false,
  }
}
