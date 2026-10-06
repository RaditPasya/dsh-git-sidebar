
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GitService } from './git-service.ts'

export const GIT_WORKTREE_TOOL = 'git_worktree'

interface ToolArgs {
  action?: unknown
  name?: unknown
  baseRef?: unknown
  worktreePath?: unknown
  force?: unknown
  deleteBranch?: unknown
}

function callingCwd(exec: { agent?: unknown }): string | undefined {
  const agent = exec.agent as { session?: { header?: { cwd?: unknown } } } | undefined
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

export function buildWorktreeTool(ctx: Context, service: GitService): ToolDefinition {
  return {
    name: GIT_WORKTREE_TOOL,
    description: [
      'Manage isolated git worktrees of the current session\'s repository.',
      'create makes a new worktree under the DSH-managed worktrees home on a new wt/<name> branch and registers it as a workspace;',
      'the returned path is ready for a new session (or for direct use when the sandbox permits).',
      'list shows every worktree; remove deletes a managed worktree (uncommitted changes reject unless force).',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'remove'],
          description: 'The worktree operation to perform.',
        },
        name: {
          type: 'string',
          description: 'create: worktree name (sanitized to [a-z0-9._-]); omit for an auto-generated one.',
        },
        baseRef: {
          type: 'string',
          description: "create: base revision (branch or rev); omit for the checkout's current HEAD. 'origin/HEAD' falls back to HEAD when no remote exists.",
        },
        worktreePath: {
          type: 'string',
          description: 'remove: absolute worktree path, exactly as reported by list/create.',
        },
        force: {
          type: 'boolean',
          description: 'remove: override the uncommitted-changes guard.',
        },
        deleteBranch: {
          type: 'boolean',
          description: 'remove: also delete the wt/<name> branch after removal.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    timeoutMs: 60_000,
    async execute(args: unknown, exec) {
      const input = (typeof args === 'object' && args !== null ? args : {}) as ToolArgs
      const cwd = callingCwd(exec)
      if (cwd === undefined) {
        return { ok: false, code: 'workspace-unknown', message: 'git_worktree needs a calling session with a project cwd' }
      }
      switch (input.action) {
        case 'list': {
          const view = await service.worktrees(cwd, exec.signal)
          if (view === null) return { ok: false, code: 'workspace-unknown', message: 'not a git workspace' }
          return { ok: true, root: view.root, worktrees: view.worktrees }
        }
        case 'create': {
          const rawName = typeof input.name === 'string' && input.name.trim() !== ''
            ? input.name
            : `agent-${Date.now().toString(36)}`
          const baseRef = typeof input.baseRef === 'string' && input.baseRef.trim() !== '' ? input.baseRef : undefined
          const result = await service.addWorktree(cwd, rawName, baseRef)
          if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message }
          const workspace = await ctx.workspaceRegistry.create(result.path, `wt: ${result.name}`)
          return {
            ok: true,
            path: result.path,
            branch: result.branch,
            name: result.name,
            workspaceId: String(workspace.id),
            note: 'The current session stays in its original checkout; open a new session on the registered workspace to work inside the worktree.',
          }
        }
        case 'remove': {
          if (typeof input.worktreePath !== 'string' || input.worktreePath === '') {
            return { ok: false, code: 'invalid-worktree-name', message: 'remove requires worktreePath' }
          }
          const result = await service.removeWorktree(cwd, input.worktreePath, {
            force: input.force === true,
            deleteBranch: input.deleteBranch === true,
          })
          if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message }
          const linked = ctx.workspaceRegistry.list().find(item => item.path === input.worktreePath)
          if (linked !== undefined) await ctx.workspaceRegistry.delete(linked.id)
          return { ok: true, removed: input.worktreePath }
        }
        default:
          return { ok: false, code: 'internal', message: "action must be one of 'create', 'list', 'remove'" }
      }
    },
  }
}