
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { GitPanel } from './sidebar/GitPanel.tsx'
import { GitPanelIcon } from './sidebar/GitPanelIcon.tsx'
import { GitFooterAction } from './sidebar/GitFooterAction.tsx'
import { setFooterNavError } from './sidebar/footer-popup-state.ts'
import { sidebarEn, sidebarZh, type GitSidebarKey } from './sidebar/locales.ts'

export type { GitSidebarKey } from './sidebar/locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-web-git-sidebar': GitSidebarKey
  }
}

const PANEL_NS = 'dsh-web-git-sidebar'

const PANEL_ID = 'dsh-web-git-sidebar' as MainPanelId

export const inject = ['slots', 'layout', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(PANEL_NS, { zh: sidebarZh, en: sidebarEn })
    } catch (error: unknown) {
      try {
        console.warn(`[dsh-web-git-sidebar] slot registration failed: ${error instanceof Error ? error.message : String(error)}`)
      } catch {
      }
      return () => {}
    }
  }, 'dsh-web-git-sidebar: panel dictionaries')

  const panelT = ctx.locale.bind(PANEL_NS)

  const openFullPanel = (): void => {
    try {
      const layout = (ctx as unknown as { layout?: { selectPanel?: (id: MainPanelId) => void } }).layout
      if (layout === undefined || typeof layout.selectPanel !== 'function') {
        throw new Error('layout service not ready')
      }
      layout.selectPanel(PANEL_ID)
      setFooterNavError(null)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        console.error(`[dsh-web-git-sidebar] openFullPanel failed: ${message}`)
      } catch {
      }
      setFooterNavError(message)
    }
  }

  ctx.slots.inject('main', () => {
    try {
      return ctx.slots.register(
        { name: 'main', key: PANEL_ID, locale: PANEL_NS },
        GitPanel)
    } catch (error: unknown) {
      try {
        console.warn(`[dsh-web-git-sidebar] slot registration failed: ${error instanceof Error ? error.message : String(error)}`)
      } catch {
      }
      return () => {}
    }
  })

  ctx.slots.inject('sidebar.panellist', () => {
    try {
      return ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => panelT('panel'),
          locale: PANEL_NS,
        },
        GitPanelIcon)
    } catch (error: unknown) {
      try {
        console.warn(`[dsh-web-git-sidebar] slot registration failed: ${error instanceof Error ? error.message : String(error)}`)
      } catch {
      }
      return () => {}
    }
  })

  ctx.slots.inject('sidebar.footer.action', () => {
    try {
      return ctx.slots.register(
        {
          name: 'sidebar.footer.action',
          id: 'dsh-web-git-sidebar.footer',
          locale: PANEL_NS,
          inject: () => ({
            openGit: () => {
              openFullPanel()
            },
          }),
        },
        GitFooterAction)
    } catch (error: unknown) {
      try {
        console.warn(`[dsh-web-git-sidebar] slot registration failed: ${error instanceof Error ? error.message : String(error)}`)
      } catch {
      }
      return () => {}
    }
  })

}
