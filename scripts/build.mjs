/**
 * Minimal build for dsh-web-git-sidebar.
 * - host: esbuild src/index.ts -> lib/index.js (node ESM, externals kept)
 * - client: esbuild src/client/index.ts -> lib/client.js wrapped in
 *   window.__ModuleLoader__.load({ id, factory }) so the DSH web shell
 *   serves it at /plugins/<id>/client.js like the upstream plugin.
 */
import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

const { name: PKG_ID } = JSON.parse(await readFile('package.json', 'utf8'))

/**
 * Minification is on by default (the shipped client bundle is ~45% smaller raw
 * / ~22% smaller gzipped). Set MINIFY=0 for a `link:` dev install when readable
 * output and intact stack traces matter more than bytes.
 */
const SHOULD_MINIFY = process.env.MINIFY !== '0'

await rm('lib', { recursive: true, force: true })
await mkdir('lib', { recursive: true })

// ---- host (node) ----
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'lib/index.js',
  external: [
    'node:*',
    '@deepseek-ai/*',
  ],
  // Whitespace and syntax only: identifiers are preserved so host stack traces
  // and log output stay readable. Still ~26% smaller.
  minifyWhitespace: SHOULD_MINIFY,
  minifySyntax: SHOULD_MINIFY,
  resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
  logLevel: 'info',
})

// ---- client (browser) ----
await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: ['es2022'],
  outfile: 'lib/__client_bundle.cjs',
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    '@deepseek-ai/*',
  ],
  // Full minify: this is the file the browser downloads. Every dependency is
  // external, so there are no third-party legal comments to preserve.
  minify: SHOULD_MINIFY,
  legalComments: SHOULD_MINIFY ? 'none' : 'eof',
  resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
  logLevel: 'info',
})

const bundle = await readFile('lib/__client_bundle.cjs', 'utf8')
const wrapped = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(PKG_ID)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${bundle}\n\t\treturn module.exports;\n\t}\n});\n`
await writeFile('lib/client.js', wrapped, 'utf8')
await rm('lib/__client_bundle.cjs', { force: true })

// minimal types stub so the "types" export resolves; real d.ts comes from tsc in upstream.
// We keep src as the source of truth (package exports ./src/*).
try {
  await mkdir('lib/types', { recursive: true })
  await writeFile('lib/types/index.d.ts', `export * from "../../src/index.ts";\n`, 'utf8')
  await mkdir('lib/types/client', { recursive: true })
  await writeFile('lib/types/client/index.d.ts', `export * from "../../../src/client/index.ts";\n`, 'utf8')
} catch { /* ignore */ }

console.log(`built ${PKG_ID}: lib/index.js + lib/client.js`)
