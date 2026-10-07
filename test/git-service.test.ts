import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GitService,
  GitTimeoutError,
  type GitRunner,
  type WorkspaceGate,
} from '../src/host/git-service.ts'
import type { GitRunResult } from '../src/host/git-runner.ts'
import { subprocessRunner } from '../src/host/git-runner.ts'

/**
 * The product's per-command deadline timers are `unref`'d, which is right for a
 * long-lived server but means this file has to hold the event loop open while
 * it waits for a deadline to fire.
 */
const keepAlive = setInterval(() => {}, 1000)
after(() => { clearInterval(keepAlive) })

const ROOT = '/home/sdtdev/Documents/deepseek-harness/default-workspace/dsh-web-git-sidebar'

const allowAll: WorkspaceGate = async (path) => ({ ok: true, canonical: path })

interface FakeState {
  calls: string[]
  failLog?: boolean
  conflicts?: boolean
  pulled?: boolean
}

function fakeRunner(state: FakeState): GitRunner {
  return {
    async run(argv: readonly string[]): Promise<GitRunResult> {
      state.calls.push(argv.join(' '))
      const done = (stdout: string): GitRunResult => ({ exitCode: 0, stdout, stderr: '' })
      if (argv[0] === 'rev-parse' && argv[1] === '--show-toplevel') return done(`${ROOT}\n`)
      if (argv[0] === 'rev-parse' && argv[1] === '--abbrev-ref') return done('main\nabc1234\n')
      if (argv[0] === 'rev-parse' && argv[1] === '--git-path') {
        return done('MERGE_HEAD\nCHERRY_PICK_HEAD\nREVERT_HEAD\nBISECT_LOG\nrebase-merge\nrebase-apply\nsequencer\n')
      }
      if (argv[0] === 'status') return done(' M file.txt\n?? new.txt\n')
      if (argv[0] === 'for-each-ref') return done('main\u0000*\u0000abc1234\u0000origin/main\u0000[ahead 1]\n')
      if (argv[0] === 'log') {
        if (state.failLog === true) return { exitCode: 124, stdout: '', stderr: 'deadline', timedOut: true }
        return done('abc1234\u0000\u0000Ada\u00001700000000\u0000HEAD -> main\u0000first commit\u001e')
      }
      if (argv[0] === 'diff') return done(state.conflicts === true ? 'file.txt\n' : '')
      if (argv[0] === 'pull') { state.pulled = true; return done('Already up to date.\n') }
      return done('')
    },
  }
}

// ─────────────────────────────────────────────── runner deadlines

test('a normal command returns its exit code and stdout', async () => {
  const runner = subprocessRunner({
    subprocess: {
      spawn: () => ({
        done: Promise.resolve({ exitCode: 0 }),
        collected: { stdout: { readFrom: () => ({ text: 'hello' }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }),
    },
  })
  const result = await runner.run(['status'], '/tmp', { deadlineMs: 50 })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'hello')
  assert.notEqual(result.timedOut, true)
})

test('a hung command is bounded by its deadline', async () => {
  const runner = subprocessRunner({
    // A provider that never settles `done`, even after the signal aborts.
    subprocess: { spawn: () => ({ done: new Promise(() => {}), collected: {} }) },
  })
  const started = Date.now()
  const result = await runner.run(['status'], '/tmp', { deadlineMs: 60 })
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, 124)
  assert.ok(Date.now() - started < 3000, 'the deadline must fire promptly')
})

test('an already-spent budget reports a timeout rather than running', async () => {
  const runner = subprocessRunner({
    subprocess: {
      spawn: () => ({
        done: Promise.resolve({ exitCode: 0 }),
        collected: { stdout: { readFrom: () => ({ text: 'should not run' }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }),
    },
  })
  const controller = new AbortController()
  controller.abort(new Error('spent'))
  const result = await runner.run(['status'], '/tmp', { signal: controller.signal, deadlineMs: 5000 })
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, 124)
})

test('a genuine spawn failure is not masked as a timeout', async () => {
  const runner = subprocessRunner({
    subprocess: { spawn: () => ({ done: Promise.reject(new Error('spawn exploded')), collected: {} }) },
  })
  await assert.rejects(() => runner.run(['status'], '/tmp', { deadlineMs: 5000 }), /spawn exploded/)
})

// ─────────────────────────────────────────────── panel assembly + flights

test('panel returns a full view from exactly 6 git invocations', async () => {
  const state: FakeState = { calls: [] }
  const service = new GitService(fakeRunner(state), allowAll)
  const view = await service.panel('/w/a', 200)
  assert.ok(view !== null)
  assert.equal(view.status.branch, 'main')
  assert.equal(view.graph.commits.length, 1)
  assert.equal(state.calls.length, 6, state.calls.join(' | '))
})

test('panel parses porcelain counts and branch tracking', async () => {
  const service = new GitService(fakeRunner({ calls: [] }), allowAll)
  const view = await service.panel('/w/a', 200)
  assert.equal(view?.status.dirtyFiles, 1)
  assert.equal(view?.status.untrackedFiles, 1)
  assert.equal(view?.branches.branches[0]?.upstream, 'origin/main')
})

test('concurrent identical panels share one flight', async () => {
  const state: FakeState = { calls: [] }
  const service = new GitService(fakeRunner(state), allowAll)
  const [first, second] = await Promise.all([service.panel('/w/b', 200), service.panel('/w/b', 200)])
  assert.equal(state.calls.length, 6, `expected 6 spawns for two joiners, saw ${state.calls.length}`)
  assert.equal(first?.status.head, second?.status.head)
})

test('a timed-out read rejects instead of fabricating a clean repository', async () => {
  const state: FakeState = { calls: [], failLog: true }
  const service = new GitService(fakeRunner(state), allowAll)
  await assert.rejects(() => service.panel('/w/c', 200), GitTimeoutError)
})

test('a settled failure is evicted, so the next call re-runs and succeeds', async () => {
  const state: FakeState = { calls: [], failLog: true }
  const service = new GitService(fakeRunner(state), allowAll)
  await assert.rejects(() => service.panel('/w/c', 200), GitTimeoutError)
  const afterFailure = state.calls.length
  state.failLog = false
  const recovered = await service.panel('/w/c', 200)
  assert.ok(recovered !== null, 'a failed flight must not be cached forever')
  assert.ok(state.calls.length > afterFailure, 'the retry should re-run git')
})

// ─────────────────────────────────────────────── mutation guards

test('pull is refused while conflicts are present', async () => {
  const state: FakeState = { calls: [], conflicts: true }
  const service = new GitService(fakeRunner(state), allowAll)
  const result = await service.pull('/w/d')
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'conflicts-present')
  assert.notEqual(state.pulled, true, 'git pull must not have run')
})

test('pull runs when the tree is clean', async () => {
  const state: FakeState = { calls: [] }
  const service = new GitService(fakeRunner(state), allowAll)
  const result = await service.pull('/w/e')
  assert.equal(result.ok, true)
  assert.equal(state.pulled, true)
})

test('an unregistered workspace is rejected before any git runs', async () => {
  const state: FakeState = { calls: [] }
  const denyAll: WorkspaceGate = async () => ({ ok: false, error: { code: 'workspace-unknown', message: 'nope' } })
  const service = new GitService(fakeRunner(state), denyAll)
  assert.equal(await service.panel('/w/f', 200), null)
  assert.equal(state.calls.length, 0)
})
