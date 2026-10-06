import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { isPairedOrLoopbackAllowed } from './pair-access.ts'

export function isGitAllowed(ctx: Context, request: IncomingMessage): boolean {
  return isPairedOrLoopbackAllowed(ctx, request)
}
