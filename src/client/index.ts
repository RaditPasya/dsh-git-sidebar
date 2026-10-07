
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Contributes `useSessions` to the framework standard props that the panel and
// the footer dock both consume.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
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

/**
 * A rejected slot registration (duplicate id, unavailable seat) must not take
 * the whole client plugin down, but it must be visible in the console.
 */
function guarded(label: string, register: () => () => void): () => void {
  try {
    return register()
  } catch (error: unknown) {
    console.warn(`[dsh-web-git-sidebar] ${label} registration failed: ${error instanceof Error ? error.message : String(error)}`)
    return () => {}
  }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => guarded('locale dictionaries', () => ctx.locale.register(PANEL_NS, { zh: sidebarZh, en: sidebarEn })),
    'dsh-web-git-sidebar: panel dictionaries',
  )

  const panelT = ctx.locale.bind(PANEL_NS)

  const openFullPanel = (): void => {
    try {
      ctx.layout.selectPanel(PANEL_ID)
      setFooterNavError(null)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[dsh-web-git-sidebar] openFullPanel failed: ${message}`)
      setFooterNavError(message)
    }
  }

  ctx.slots.inject('main', () => guarded('main panel', () => ctx.slots.register(
    { name: 'main', key: PANEL_ID, locale: PANEL_NS },
    GitPanel,
  )))

  ctx.slots.inject('sidebar.panellist', () => guarded('sidebar icon', () => ctx.slots.register(
    {
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 20,
      label: () => panelT('panel'),
      locale: PANEL_NS,
    },
    GitPanelIcon,
  )))

  ctx.slots.inject('sidebar.footer.action', () => guarded('footer action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'dsh-web-git-sidebar.footer',
      locale: PANEL_NS,
      inject: () => ({ openGit: () => { openFullPanel() } }),
    },
    GitFooterAction,
  )))
}
