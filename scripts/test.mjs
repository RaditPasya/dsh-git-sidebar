/**
 * Test runner for dsh-web-git-sidebar.
 *
 * The sources use TypeScript parameter properties, which Node's native type
 * stripping rejects, so each suite is bundled with esbuild into a temp directory
 * and then executed by Node's built-in test runner. Bundling also keeps the
 * suites exercising the same module graph the plugin ships.
 *
 * `pnpm test` builds `lib/` first because test/bundles.test.ts loads the artifacts.
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_DIR = join(ROOT, 'test')

const entries = (await readdir(TEST_DIR))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()

if (entries.length === 0) {
  console.error(`no *.test.ts files found in ${TEST_DIR}`)
  process.exit(1)
}

const outDir = await mkdtemp(join(tmpdir(), 'dsh-web-git-sidebar-test-'))
let exitCode = 1
try {
  const bundles = []
  for (const entry of entries) {
    const outfile = join(outDir, entry.replace(/\.ts$/, '.mjs'))
    await build({
      entryPoints: [join(TEST_DIR, entry)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile,
      // Runtime deps stay external and resolve from the repo's node_modules.
      external: ['@deepseek-ai/*'],
      logLevel: 'warning',
    })
    bundles.push(outfile)
  }

  console.log(`running ${entries.length} suite(s): ${entries.join(', ')}\n`)
  const child = spawn(process.execPath, ['--test', ...bundles], {
    stdio: 'inherit',
    env: { ...process.env, PLUGIN_ROOT: ROOT },
  })
  exitCode = await new Promise((resolveCode) => {
    child.on('close', (code) => { resolveCode(code ?? 1) })
  })
} finally {
  await rm(outDir, { recursive: true, force: true })
}

process.exit(exitCode)
