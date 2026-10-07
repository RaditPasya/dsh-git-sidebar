
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-workspace'
import type { GitFeatureConfig } from './core/types.ts'
import { Config, effectiveConfig } from './host/config.ts'
import { GitService, subprocessRunner, type WorkspaceGate } from './host/git-service.ts'
import { registerGitRoutes } from './host/routes.ts'
import { buildWorktreeTool } from './host/agent-tool.ts'
import { worktreesHome } from './host/worktree-home.ts'
import { mountOnce } from './mount-once.ts'

export const inject = ['webServer', 'subprocess', 'workspaceRegistry']

export { Config } from './host/config.ts'
export type { ConfigInput, ResolvedConfig } from './host/config.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

function createWorkspaceGate(ctx: Context): WorkspaceGate {
  return async (path) => {
    let canonical: string
    try {
      canonical = await realpath(path)
    } catch {
      return { ok: false, error: { code: 'workspace-unknown', message: 'path does not resolve on disk' } }
    }
    const registered = ctx.workspaceRegistry.list()
    if (registered.some(workspace => workspace.path === canonical)) {
      return { ok: true, canonical }
    }
    for (const workspace of registered) {
      try {
        if (await realpath(workspace.path) === canonical) {
          return { ok: true, canonical }
        }
      } catch {
      }
    }
    return { ok: false, error: { code: 'workspace-unknown', message: 'path is not a registered workspace' } }
  }
}

export const apply = mountOnce('dsh-web-git-sidebar', applyImpl)

function applyImpl(ctx: Context, config?: Config): void {
  const service = new GitService(subprocessRunner(ctx), createWorkspaceGate(ctx))
  const home = worktreesHome()

  const featureConfig = (): GitFeatureConfig => {
    const active = effectiveConfig(config)
    return {
      autoIsolate: active.autoIsolate,
      autoBaseline: active.autoBaseline,
      worktreesHome: home,
    }
  }

  let toolFiber: ReturnType<Context['inject']> | undefined
  const syncTool = (): void => {
    const want = effectiveConfig(config).agentTool
    if (want && toolFiber === undefined) {
      toolFiber = ctx.inject(['tools'], (toolCtx: Context) => {
        toolCtx.effect(() => toolCtx.tools.register(buildWorktreeTool(ctx, service)), 'dsh-web-git-sidebar: git_worktree tool')
      })
    } else if (!want && toolFiber !== undefined) {
      toolFiber.dispose()
      toolFiber = undefined
    }
  }

  ctx.effect(() => {
    const dispose = ctx.on('loader/volatile-update', (paths) => {
      if (paths.some(path => path[0] === 'agentTool')) syncTool()
    })
    return () => { dispose() }
  }, 'dsh-web-git-sidebar: settings-committed tool sync')

  ctx.effect(() => {
    syncTool()
    const disposeRoutes = registerGitRoutes(ctx, service, featureConfig)
    return () => {
      disposeRoutes()
      toolFiber?.dispose()
      toolFiber = undefined
    }
  }, 'dsh-web-git-sidebar: /git routes + tool')
}