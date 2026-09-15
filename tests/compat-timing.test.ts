import { describe, expect, it } from 'vitest'
import { TimeoutReason as HostTimeoutReason } from '@deepseek-ai/dsh-timeout'
import { deadline, MAX_TIMER_DELAY_MS, TimeoutReason, timeoutOf } from '../src/compat/timing.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('MAX_TIMER_DELAY_MS', () => {
  it('is the largest delay Node schedules without clamping (2^31-1)', () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647)
    expect(MAX_TIMER_DELAY_MS).toBe(2 ** 31 - 1)
  })
})

describe('TimeoutReason', () => {
  it('carries the capability code, the elapsed deadline and a stable name', () => {
    const reason = new TimeoutReason('MY_CODE', 1500)
    expect(reason.code).toBe('MY_CODE')
    expect(reason.timeoutMs).toBe(1500)
    expect(reason.name).toBe('TimeoutReason')
    expect(reason).toBeInstanceOf(Error)
    expect(reason.message).toContain('MY_CODE after 1500ms')
  })
})

describe('deadline', () => {
  it('does not abort before the deadline elapses', () => {
    const budget = deadline(undefined, 1000, 'TEST_CODE')
    expect(budget.signal.aborted).toBe(false)
    budget[Symbol.dispose]()
  })

  it('aborts with a coded TimeoutReason once the deadline elapses', async () => {
    const budget = deadline(undefined, 10, 'TEST_CODE')
    await sleep(40)
    expect(budget.signal.aborted).toBe(true)
    const reason = timeoutOf(budget.signal, 'TEST_CODE')
    expect(reason?.timeoutMs).toBe(10)
    budget[Symbol.dispose]()
  })

  it('fuses upstream cancellation into the returned signal', () => {
    const upstream = new AbortController()
    const budget = deadline(upstream.signal, 60_000, 'TEST_CODE')
    expect(budget.signal.aborted).toBe(false)
    upstream.abort()
    expect(budget.signal.aborted).toBe(true)
    budget[Symbol.dispose]()
  })

  it('arms no timer when timeoutMs <= 0 and keeps following upstream', () => {
    const upstream = new AbortController()
    const budget = deadline(upstream.signal, 0, 'TEST_CODE')
    expect(budget.signal.aborted).toBe(false)
    upstream.abort()
    expect(budget.signal.aborted).toBe(true)
    budget[Symbol.dispose]()
  })

  it('returns a live signal even with no upstream and no timer', () => {
    const budget = deadline(undefined, -1, 'TEST_CODE')
    expect(budget.signal).toBeInstanceOf(AbortSignal)
    expect(budget.signal.aborted).toBe(false)
    budget[Symbol.dispose]()
  })

  it('rejects a non-positive-finite delay instead of arming a broken timer', () => {
    expect(() => deadline(undefined, Number.POSITIVE_INFINITY, 'C')).toThrow()
    expect(() => deadline(undefined, MAX_TIMER_DELAY_MS + 1, 'C')).toThrow()
  })

  it('stops the timer on dispose', async () => {
    const budget = deadline(undefined, 10, 'TEST_CODE')
    budget[Symbol.dispose]()
    await sleep(40)
    expect(budget.signal.aborted).toBe(false)
  })
})

describe('timeoutOf', () => {
  it('matches its own reason for the exact code', () => {
    const reason = new TimeoutReason('CODE_A', 5)
    expect(timeoutOf({ reason }, 'CODE_A')).toBe(reason)
  })

  it('ignores a reason carrying a different code', () => {
    const reason = new TimeoutReason('CODE_A', 5)
    expect(timeoutOf({ reason }, 'CODE_B')).toBeUndefined()
  })

  it("matches the harness's own TimeoutReason", () => {
    // The host's copy of the helper raises the reason when a nested upstream
    // deadline fires. Classification is shape-based on purpose, so a foreign
    // copy is still recognised instead of surfacing as a plain cancellation.
    const reason = new HostTimeoutReason('CODE_A', 7)
    expect(timeoutOf({ reason }, 'CODE_A')?.timeoutMs).toBe(7)
  })

  it('ignores unrelated errors and missing reasons', () => {
    expect(timeoutOf({ reason: new Error('boom') })).toBeUndefined()
    expect(timeoutOf({})).toBeUndefined()
    expect(timeoutOf({ reason: null })).toBeUndefined()
    expect(timeoutOf({ reason: 'CODE_A' })).toBeUndefined()
  })

  it('accepts a real aborted signal as the carrier', async () => {
    const budget = deadline(undefined, 10, 'SIGNAL_CODE')
    await sleep(40)
    expect(timeoutOf(budget.signal, 'SIGNAL_CODE')?.code).toBe('SIGNAL_CODE')
    budget[Symbol.dispose]()
  })
})
