import { describe, expect, it } from 'vitest'
import {
  FEEDBACK_MIN_ITEMS,
  FEEDBACK_TEMPERATURE_STEP,
  FEEDBACK_TTL_MS,
  applyBias,
  emptyLedger,
  feedbackBias,
  feedbackItems,
  feedbackToken,
  formatFeedback,
  isStale,
  ledgerTotal,
  mergeItems,
  negativeRate,
  normalizeItem,
} from '../src/feedback.js'

describe('normalizeItem', () => {
  it('accepts the two host ratings, a category and a note flag', () => {
    expect(normalizeItem({ rating: 'positive' })).toEqual({ rating: 'positive', withNote: false })
    expect(normalizeItem({ rating: 'negative', category: 'correctness', note: ' nope ', createdAt: 7 }))
      .toEqual({ rating: 'negative', category: 'correctness', withNote: true, ts: 7 })
  })

  it('drops an unknown rating instead of inventing a category for it', () => {
    expect(normalizeItem({ rating: 'maybe' })).toBeUndefined()
    expect(normalizeItem({})).toBeUndefined()
    expect(normalizeItem(null)).toBeUndefined()
    expect(normalizeItem('positive')).toBeUndefined()
  })

  it('treats a blank or non-string note as no note and never returns its text', () => {
    expect(normalizeItem({ rating: 'positive', note: '   ' })?.withNote).toBe(false)
    expect(normalizeItem({ rating: 'positive', note: 42 })?.withNote).toBe(false)
    // The note content is structurally absent from the result, not merely
    // omitted in practice.
    expect(JSON.stringify(normalizeItem({ rating: 'positive', note: 'SECRET' }))).not.toContain('SECRET')
  })
})

describe('feedbackItems', () => {
  it('unwraps the Remote envelope', () => {
    expect(feedbackItems({ ok: true, value: { items: [{ rating: 'positive' }] } })).toEqual([{ rating: 'positive' }])
    expect(feedbackItems({ ok: true, value: [{ rating: 'negative' }] })).toEqual([{ rating: 'negative' }])
    expect(feedbackItems([{ rating: 'negative' }])).toEqual([{ rating: 'negative' }])
  })

  it('distinguishes a definite miss from an unreadable answer', () => {
    expect(feedbackItems({ ok: false, error: { code: 'session-not-found' } })).toBeUndefined()
    expect(feedbackItems({ ok: true, value: { unexpected: true } })).toBeUndefined()
    expect(feedbackItems(undefined)).toBeUndefined()
  })
})

describe('mergeItems', () => {
  it('replaces counts rather than accumulating them (the list is the truth)', () => {
    const first = mergeItems('s1', [{ rating: 'positive' }, { rating: 'negative' }], 100)
    expect(ledgerTotal(first)).toBe(2)
    const second = mergeItems('s1', [{ rating: 'positive' }], 200)
    expect(ledgerTotal(second)).toBe(1)
    expect(second.fetchedAt).toBe(200)
  })

  it('counts categories and the newest item timestamp', () => {
    const ledger = mergeItems('s1', [
      { rating: 'negative', category: 'correctness', createdAt: 10 },
      { rating: 'negative', category: 'correctness', createdAt: 30 },
      { rating: 'positive', category: 'style', createdAt: 20 },
      { rating: 'positive', note: 'thanks', createdAt: 5 },
    ])
    expect(ledger.positive).toBe(2)
    expect(ledger.negative).toBe(2)
    expect(ledger.withNote).toBe(1)
    expect(ledger.categories).toEqual({ correctness: 2, style: 1 })
    expect(ledger.latestTs).toBe(30)
    expect(negativeRate(ledger)).toBe(0.5)
  })

  it('ignores junk entries and tolerates a missing list', () => {
    const ledger = mergeItems('s1', [null, 'x', { rating: 'nope' }, { rating: 'positive' }])
    expect(ledger.positive).toBe(1)
    expect(ledger.categories).toEqual({})
    expect(ledgerTotal(mergeItems('s2', undefined))).toBe(0)
  })
})

describe('staleness', () => {
  it('treats an unknown or old ledger as stale', () => {
    expect(isStale(undefined, 1000)).toBe(true)
    const ledger = emptyLedger('s1', 1000)
    expect(isStale(ledger, 1000 + FEEDBACK_TTL_MS - 1)).toBe(false)
    expect(isStale(ledger, 1000 + FEEDBACK_TTL_MS)).toBe(true)
  })
})

describe('feedbackBias', () => {
  it('stays neutral while the sample is too small', () => {
    const ledger = { ...emptyLedger('s1'), negative: FEEDBACK_MIN_ITEMS - 1 }
    expect(feedbackBias(ledger)).toEqual({ delta: 0 })
  })

  it('raises the temperature when negatives dominate', () => {
    const ledger = { ...emptyLedger('s1'), negative: 4, positive: 1 }
    const bias = feedbackBias(ledger)
    expect(bias.delta).toBe(FEEDBACK_TEMPERATURE_STEP)
    expect(bias.reason).toContain('more sampling diversity')
  })

  it('lowers the temperature when negatives are rare', () => {
    const ledger = { ...emptyLedger('s1'), negative: 1, positive: 9 }
    expect(feedbackBias(ledger).delta).toBe(-FEEDBACK_TEMPERATURE_STEP)
  })

  it('stays neutral in the middle band', () => {
    const ledger = { ...emptyLedger('s1'), negative: 3, positive: 4 }
    expect(feedbackBias(ledger).delta).toBe(0)
  })

  it('is disabled by the flag and by a missing ledger', () => {
    const angry = { ...emptyLedger('s1'), negative: 9, positive: 1 }
    expect(feedbackBias(angry, false).delta).toBe(0)
    expect(feedbackBias(undefined).delta).toBe(0)
  })
})

describe('applyBias', () => {
  it('clamps into the harness temperature range', () => {
    expect(applyBias(0.2, 0.1)).toBe(0.3)
    expect(applyBias(0.05, -0.1)).toBe(0)
    expect(applyBias(1.95, 0.1)).toBe(2)
    expect(applyBias(0.2, 0)).toBe(0.2)
  })
})

describe('formatting', () => {
  it('says the host has no service rather than showing an empty list', () => {
    expect(formatFeedback([], 'zh', false)).toContain('宿主未提供 messageFeedback')
    expect(formatFeedback([], 'en', false)).toContain('no messageFeedback service')
  })

  it('says nothing was recorded when no judgment exists', () => {
    const ledgers = [emptyLedger('s1', 5)]
    expect(formatFeedback(ledgers, 'zh')).toContain('暂无宿主反馈记录')
  })

  it('renders counts, categories and the privacy note — never note text', () => {
    const ledger = mergeItems('session-abcdefgh', [{ rating: 'negative', category: 'correctness', note: 'SECRET NOTE' }], 5)
    const text = formatFeedback([ledger], 'zh')
    expect(text).toContain('session-')
    expect(text).toContain('👎 1')
    expect(text).toContain('correctness×1')
    expect(text).toContain('备注原文永不落盘')
    expect(text).not.toContain('SECRET NOTE')
  })

  it('emits a counts-only machine token', () => {
    const ledgers = [mergeItems('s1', [{ rating: 'positive' }, { rating: 'negative' }])]
    expect(feedbackToken(ledgers, 0.1)).toBe('FEEDBACK:SESSIONS:1|POSITIVE:1|NEGATIVE:1|BIAS:0.1')
  })
})
