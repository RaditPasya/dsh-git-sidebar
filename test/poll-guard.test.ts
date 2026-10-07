import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PollGuard, nextInterval } from '../src/host/poll-guard.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

test('nextInterval widens an unchanged tick', () => {
  assert.equal(nextInterval(30_000, 30_000, 60_000, false), 60_000)
})

test('nextInterval stops at the ceiling', () => {
  assert.equal(nextInterval(60_000, 30_000, 60_000, false), 60_000)
})

test('nextInterval snaps back to base when something changed', () => {
  assert.equal(nextInterval(60_000, 30_000, 60_000, true), 30_000)
})

test('an omitted ceiling disables backoff', () => {
  assert.equal(nextInterval(30_000, 30_000, 30_000, false), 30_000)
})

test('a ceiling below base cannot shrink the interval', () => {
  assert.equal(nextInterval(30_000, 30_000, 10_000, false), 30_000)
})

test('start() schedules at the base interval', async () => {
  let ticks = 0
  const guard = new PollGuard({ intervalMs: 5, onRun: async () => { ticks += 1; return false } })
  guard.start()
  await sleep(40)
  guard.stop()
  assert.equal(guard.interval(), 5)
  assert.ok(ticks >= 2, `expected repeat ticks, saw ${ticks}`)
})

test('an idle repository still gets polled, just less often', async () => {
  let idleTicks = 0
  const backoff = new PollGuard({
    intervalMs: 5,
    maxIntervalMs: 20,
    onRun: async () => { idleTicks += 1; return false },
  })
  backoff.start()
  await sleep(80)
  backoff.stop()

  let flatTicks = 0
  const flat = new PollGuard({ intervalMs: 5, onRun: async () => { flatTicks += 1; return false } })
  flat.start()
  await sleep(80)
  flat.stop()

  assert.equal(backoff.interval(), 20, 'idle guard should have widened to its ceiling')
  assert.ok(idleTicks >= 3, `idle guard should still tick, saw ${idleTicks}`)
  assert.ok(idleTicks < flatTicks, `backoff should reduce ticks (${idleTicks} vs ${flatTicks})`)
})

test('a changing repository holds the base cadence', async () => {
  let ticks = 0
  const guard = new PollGuard({
    intervalMs: 5,
    maxIntervalMs: 20,
    onRun: async () => { ticks += 1; return true },
  })
  guard.start()
  await sleep(60)
  guard.stop()
  assert.equal(guard.interval(), 5, 'a change must reset the backoff')
  assert.ok(ticks >= 5, `expected fast polling, saw ${ticks}`)
})

test('a throwing tick is treated as idle, not as change', async () => {
  const guard = new PollGuard({
    intervalMs: 5,
    maxIntervalMs: 20,
    onRun: async () => { throw new Error('probe failed') },
  })
  guard.start()
  await sleep(60)
  guard.stop()
  assert.equal(guard.interval(), 20)
})

test('stop() halts scheduling', async () => {
  let ticks = 0
  const guard = new PollGuard({ intervalMs: 5, onRun: async () => { ticks += 1; return false } })
  guard.start()
  await sleep(30)
  guard.stop()
  const frozen = ticks
  await sleep(30)
  assert.equal(ticks, frozen)
})

test('start() is idempotent', async () => {
  let ticks = 0
  const guard = new PollGuard({ intervalMs: 5, onRun: async () => { ticks += 1; return false } })
  guard.start()
  guard.start()
  guard.start()
  await sleep(40)
  guard.stop()
  assert.ok(ticks <= 10, `a second start() must not stack timers, saw ${ticks} ticks`)
})
