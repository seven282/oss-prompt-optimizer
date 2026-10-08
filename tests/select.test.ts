import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SELECT_MIN_GAIN,
  SELECT_TEMPERATURE_SPREAD,
  candidateTemperature,
  formatSelection,
  scoreCandidates,
  selectCandidatePure,
  selectionToken,
  structuralScore,
  type Candidate,
  type CandidateGate,
  type CandidateScore,
} from '../src/select.js'

/** A gate that passes everything (structure is the selector's business). */
const pass: CandidateGate = { passed: true, valid: true, missingRequired: [], leaked: [] }

/** A gate that failed (leak or missing expected content). */
const fail: CandidateGate = { passed: false, valid: false, missingRequired: ['周报'], leaked: [] }

function score(index: number, value: number | undefined, gate: CandidateGate = pass): CandidateScore {
  return {
    index,
    source: 'llm',
    chars: 100,
    gate,
    ...(value !== undefined ? { score: value } : {}),
    ...(value === undefined ? { error: 'judge-incomplete' } : {}),
  }
}

const candidates: Candidate[] = [
  { source: 'llm', prompt: 'a'.repeat(100) },
  { source: 'llm', prompt: 'b'.repeat(200) },
  { source: 'llm', prompt: 'c'.repeat(300) },
]

describe('selectCandidatePure', () => {
  it('keeps the baseline when no other candidate beats it by minGain', () => {
    const summary = selectCandidatePure(candidates, [score(0, 0.9), score(1, 0.91), score(2, 0.88)])
    expect(summary.chosenIndex).toBe(0)
    expect(summary.reason).toBe('baseline')
    expect(summary.score).toBe(0.9)
    expect(summary.eligible).toBe(3)
  })

  it('adopts a later candidate that wins by minGain or more', () => {
    const summary = selectCandidatePure(candidates, [score(0, 0.7), score(1, 0.95), score(2, 0.8)])
    expect(summary.chosenIndex).toBe(1)
    expect(summary.reason).toBe('gain')
    expect(summary.score).toBe(0.95)
  })

  it('never adopts a candidate that fails the deterministic gate, however it scores', () => {
    // Candidate 1 scores highest but leaked a canary: eligibility is decided
    // first, so the gate failure removes it from the ranking entirely.
    const summary = selectCandidatePure(candidates, [score(0, 0.5), score(1, 0.99, fail), score(2, 0.6)])
    expect(summary.chosenIndex).toBe(2)
    expect(summary.reason).toBe('gain')
    expect(summary.eligible).toBe(2)
    // The candidate is still reported — the caller can see it was rejected for
    // a reason, not that it silently disappeared.
    expect(summary.scores[1]?.gate?.passed).toBe(false)
    expect(summary.scores[1]?.score).toBe(0.99)
  })

  it('falls back to the only eligible candidate when the baseline is broken', () => {
    // Now the baseline is not merely unscored, it FAILED the gate: nothing was
    // preferred, so the reason says so (`only-eligible`).
    const summary = selectCandidatePure(candidates, [score(0, undefined, fail), score(1, 0.42), score(2, undefined, fail)])
    expect(summary.chosenIndex).toBe(1)
    expect(summary.reason).toBe('only-eligible')
    expect(summary.eligible).toBe(1)
  })

  it('adopts an eligible-but-unscored winner only over a gate-failing baseline', () => {
    // A judge that fails on the baseline is not evidence that the baseline is
    // good, but the winner here is still merely the survivor: the reason must
    // not claim a quality comparison that never happened.
    const summary = selectCandidatePure(candidates, [score(0, undefined, fail), score(1, undefined)])
    expect(summary.chosenIndex).toBe(1)
    expect(summary.reason).toBe('only-eligible')
    expect(summary.eligible).toBe(0)
  })

  it('is deterministic on a tie (the earlier candidate wins)', () => {
    const summary = selectCandidatePure(candidates, [score(0, 0.8), score(1, 0.8), score(2, 0.8)])
    expect(summary.chosenIndex).toBe(0)
    expect(summary.reason).toBe('baseline')
  })

  it('treats an unscored eligible baseline as beatable by any scored candidate', () => {
    // A judge that failed on candidate 0 is not evidence that candidate 0 is
    // good: a candidate the judge could actually score wins. (The baseline
    // itself passed the gate here — it is eligible, just unmeasured.)
    const summary = selectCandidatePure(candidates, [score(0, undefined), score(1, 0.55)])
    expect(summary.chosenIndex).toBe(1)
    expect(summary.reason).toBe('gain')
    expect(summary.scores[0]?.gate?.passed).toBe(true)
  })

  it('returns a copy of every score so callers cannot mutate the summary', () => {
    const scores = [score(0, 0.5)]
    const summary = selectCandidatePure([candidates[0]!], scores)
    summary.scores[0]!.score = 0
    expect(scores[0]?.score).toBe(0.5)
  })

  it('honours a custom minGain', () => {
    const scores = [score(0, 0.5), score(1, 0.55)]
    expect(selectCandidatePure(candidates, scores, { minGain: 0.01 }).chosenIndex).toBe(1)
    expect(selectCandidatePure(candidates, scores, { minGain: 0.2 }).chosenIndex).toBe(0)
    expect(DEFAULT_SELECT_MIN_GAIN).toBe(0.05)
  })
})

describe('scoreCandidates', () => {
  it('runs the gate first and never calls the judge for a failed candidate', async () => {
    const judge = vi.fn(async () => ({ complete: true, normalized: 0.9, missing: [], rejected: [], fabricated: [] }))
    const gate = vi.fn((candidate: Candidate): CandidateGate => (candidate.source === 'bad' ? fail : pass))
    const list: Candidate[] = [{ source: 'bad', prompt: 'x' }, { source: 'good', prompt: 'y' }]
    const scores = await scoreCandidates(list, gate, { judge })
    expect(gate).toHaveBeenCalledTimes(2)
    expect(judge).toHaveBeenCalledTimes(1)
    expect(scores[0]?.error).toBe('gate-failed')
    expect(scores[0]?.score).toBeUndefined()
    expect(scores[1]?.score).toBe(0.9)
  })

  it('leaves an incomplete judge answer unscored rather than averaging it', async () => {
    const scores = await scoreCandidates(candidates.slice(0, 1), () => pass, {
      judge: async () => ({ complete: false, missing: ['context'], rejected: [], fabricated: [] }),
    })
    expect(scores[0]?.score).toBeUndefined()
    expect(scores[0]?.error).toBe('judge-incomplete')
  })

  it('keeps a candidate eligible when the judge call throws', async () => {
    const scores = await scoreCandidates(candidates.slice(0, 1), () => pass, {
      judge: async () => { throw new Error('judge exploded') },
    })
    expect(scores[0]?.score).toBeUndefined()
    expect(scores[0]?.error).toBe('judge-error')
    expect(scores[0]?.gate?.passed).toBe(true)
  })

  it('ranks structurally at zero judge cost when no judge is supplied', async () => {
    const scores = await scoreCandidates(candidates, () => pass)
    expect(scores.map((entry) => entry.score)).toEqual([0.05, 0.1, 0.15])
    expect(scores[2]?.error).toBeUndefined()
  })

  it('judges in parallel, not one after another', async () => {
    let active = 0
    let maxActive = 0
    await scoreCandidates(candidates, () => pass, {
      judge: async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
        return { complete: true, normalized: 0.5, missing: [], rejected: [], fabricated: [] }
      },
    })
    expect(maxActive).toBe(3)
  })
})

describe('structuralScore', () => {
  it('scales into the judge band and clamps at 1', () => {
    expect(structuralScore(0)).toBe(0)
    expect(structuralScore(-5)).toBe(0)
    expect(structuralScore(Number.NaN)).toBe(0)
    expect(structuralScore(1000)).toBe(0.5)
    expect(structuralScore(5000)).toBe(1)
  })
})

describe('candidateTemperature', () => {
  it('keeps the baseline at the configured temperature and spreads the rest', () => {
    expect(candidateTemperature(0.2, 0)).toBe(0.2)
    expect(candidateTemperature(0.2, 1)).toBe(0.55)
    expect(candidateTemperature(0.2, 2)).toBeCloseTo(0.2 + 2 * SELECT_TEMPERATURE_SPREAD, 5)
  })

  it('clamps to the harness range', () => {
    expect(candidateTemperature(1.9, 3)).toBe(2)
  })
})

describe('formatting', () => {
  it('states the chosen candidate, its score and the reason', () => {
    const summary = selectCandidatePure(candidates, [score(0, 0.7), score(1, 0.95), score(2, 0.8)])
    const zh = formatSelection(summary, 'zh')
    expect(zh).toContain('候选 2/3')
    expect(zh).toContain('0.95')
    expect(zh).toContain('择优')
    expect(zh).toContain('结构门 3/3')
    expect(formatSelection(summary, 'en')).toContain('candidate 2/3')
  })

  it('emits a machine-readable token with no prose', () => {
    const summary = selectCandidatePure(candidates, [score(0, 0.7), score(1, 0.95)])
    const token = selectionToken(summary)
    expect(token).toContain('SELECT:2/2')
    expect(token).toContain('SELECTREASON:GAIN')
    expect(token).toContain('SELECTGATE:2')
    expect(token).toContain('SELECTSCORES:0.700/0.950')
  })

  it('reports an unscored candidate as na rather than a zero', () => {
    const summary = selectCandidatePure(candidates.slice(0, 2), [score(0, undefined, fail), score(1, 0.5)])
    expect(selectionToken(summary)).toContain('SELECTSCORES:na/0.500')
  })
})
