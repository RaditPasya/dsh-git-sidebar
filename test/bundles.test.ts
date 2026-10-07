import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Smoke tests over the BUILT artifacts rather than the sources, so a minification
 * or bundling regression fails here instead of in the browser.
 *
 * `pnpm test` builds first; PLUGIN_ROOT is exported by scripts/test.mjs because
 * this file is itself bundled into a temp directory and cannot use a relative path.
 */
const ROOT = process.env.PLUGIN_ROOT ?? process.cwd()
const nodeRequire = createRequire(join(ROOT, 'package.json'))

interface HostModule {
  apply: (ctx: unknown) => void
  inject: string[]
  Config: unknown
}

interface ClientModule {
  apply: (ctx: unknown) => void
  inject: string[]
}

interface RegisteredSlot {
  name: string
  id?: string
  inject?: () => { openGit: () => void }
}

function fakeHostContext(): { ctx: unknown; routes: Array<{ kind: string; path: string }> } {
  const routes: Array<{ kind: string; path: string }> = []
  return {
    routes,
    ctx: {
      effect: (fn: () => unknown) => fn(),
      on: () => () => {},
      // Only reached if a git command actually runs; these tests never execute one.
      subprocess: { spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {} }) },
      webServer: { register: (route: { kind: string; path: string }) => { routes.push(route); return () => {} } },
      workspaceRegistry: { list: () => [] },
      logger: { warn: () => {} },
      inject: () => ({ dispose: () => {} }),
    },
  }
}

test('host bundle exports its plugin surface', async () => {
  const module = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href) as HostModule
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['webServer', 'subprocess', 'workspaceRegistry'])
  // schemastery schemas are callable, not plain objects.
  assert.equal(typeof module.Config, 'function')
})

test('host bundle mounts both routes exactly once', async () => {
  const module = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href) as HostModule
  const { ctx, routes } = fakeHostContext()
  module.apply(ctx)
  assert.ok(
    routes.some((route) => route.kind === 'prefix' && route.path === '/git-sidebar'),
    `missing prefix route: ${JSON.stringify(routes)}`,
  )
  assert.ok(
    routes.some((route) => route.kind === 'exact' && route.path === '/git-sidebar/events'),
    `missing SSE route: ${JSON.stringify(routes)}`,
  )
  const mounted = routes.length
  module.apply(ctx)
  assert.equal(routes.length, mounted, 'a second apply() must not double-mount')
})

test('client bundle loads and registers its three slots', () => {
  const code = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const registered: RegisteredSlot[] = []
  const dictionaries: string[][] = []
  const panelSelections: string[] = []
  let captured: ClientModule | null = null

  const fakeWindow = {
    __ModuleLoader__: {
      load: (mod: { id: string; factory: (require: unknown) => unknown }) => {
        captured = mod.factory(nodeRequire) as ClientModule
      },
    },
  }
  // At load time the bundle touches only `window`; no other global is required.
  new Function('window', code)(fakeWindow)

  if (captured === null) throw new Error('client bundle never called window.__ModuleLoader__.load')
  const client: ClientModule = captured
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['slots', 'layout', 'locale'])

  client.apply({
    effect: (fn: () => unknown) => fn(),
    locale: {
      register: (ns: string, dicts: Record<string, unknown>) => {
        dictionaries.push([ns, ...Object.keys(dicts)])
        return () => {}
      },
      bind: (ns: string) => (key: string) => `${ns}.${key}`,
    },
    slots: {
      inject: (_name: string, factory: () => unknown) => { factory() },
      register: (options: RegisteredSlot) => { registered.push(options); return () => {} },
    },
    layout: { selectPanel: (id: string) => { panelSelections.push(id) } },
  })

  assert.equal(dictionaries.length, 1, 'one namespace should be registered')
  assert.deepEqual(dictionaries[0]?.slice(1).sort(), ['en', 'zh'], 'both shipped locales are required')
  assert.deepEqual(
    registered.map((slot) => slot.name).sort(),
    ['main', 'sidebar.footer.action', 'sidebar.panellist'],
  )

  const footer = registered.find((slot) => slot.name === 'sidebar.footer.action')
  if (footer?.inject === undefined) throw new Error('the footer slot must inject openGit()')
  footer.inject().openGit()
  assert.deepEqual(panelSelections, ['dsh-web-git-sidebar'], 'openGit() should select the Git panel')
})

test('client bundle keeps wiring that cannot be exercised without a DOM', () => {
  const code = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  // A tab becoming visible must refresh the snapshot (no DOM here to render it).
  assert.ok(code.includes('visibilitychange'), 'tab-visibility refresh wiring is missing')
  // The round sync glyph spins while fetching.
  assert.ok(code.includes('gs-rotate'), 'the fetch spinner keyframes are missing')
})
