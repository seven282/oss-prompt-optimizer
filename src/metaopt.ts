/**
 * Offline meta-optimization advice (P4, 2026-11-22) — the deliberately safe
 * slice of "GEPA-style" reflection that fits this product's privacy stance.
 *
 * GEPA's core signal is `{ score, feedback }`. Here the only `feedback` we are
 * allowed to keep is *numeric and categorical*: rubric dimension scores and
 * error codes. We therefore produce **advice about which rubric dimension to
 * strengthen**, never a rewritten prompt and never a diff — a diff would have
 * to quote the optimized prompt text, which the privacy contract forbids.
 *
 * Opt-in by construction: this module is never called from the optimize hot
 * path. It is exposed only through `/optimize-eval advise`, an explicit
 * offline command, and returns structured counts/categories.
 *
 * @module metaopt
 */

import type { EvalRun } from './eval.js'

/** One structured, text-free advice item. */
export interface MetaAdvice {
  /** Rubric dimension id this advice concerns. */
  dimension: string
  /** Mean score of the dimension across the given runs (1–5). */
  mean: number
  /** How many runs contributed a score for this dimension. */
  samples: number
  /** Coarse category — a label, never a prompt rewrite. */
  category: 'strengthen' | 'maintain' | 'watch'
}

export interface MetaAdviceReport {
  runs: number
  /** Weakest-first dimension advice (mean ascending). */
  advice: MetaAdvice[]
  /** Aggregate score across runs that have one; undefined when none scored. */
  aggregate: number | undefined
  /** Total judged cases across runs. */
  scoredCases: number
}

/**
 * Derive structured advice from recent eval runs.
 *
 * A dimension below `weakThreshold` (default 3 of 5) → `strengthen`; above
 * `strongThreshold` (default 4) → `maintain`; otherwise `watch`. Runs without
 * a per-dimension score contribute nothing — an absent score is never treated
 * as a zero, matching the rest of the eval surface.
 */
export function adviseFromRuns(
  runs: readonly EvalRun[],
  options: { weakThreshold?: number; strongThreshold?: number; limit?: number } = {},
): MetaAdviceReport {
  const weak = options.weakThreshold ?? 3
  const strong = options.strongThreshold ?? 4
  const accumulator = new Map<string, { sum: number; n: number }>()
  let aggregateSum = 0
  let aggregateN = 0
  let scoredCases = 0

  for (const run of runs) {
    scoredCases += run.scored
    if (run.aggregate !== undefined) {
      aggregateSum += run.aggregate
      aggregateN++
    }
    for (const [dimension, score] of Object.entries(run.perDimension)) {
      if (!Number.isFinite(score)) continue
      const current = accumulator.get(dimension) ?? { sum: 0, n: 0 }
      current.sum += score
      current.n++
      accumulator.set(dimension, current)
    }
  }

  const advice: MetaAdvice[] = [...accumulator.entries()]
    .map(([dimension, value]) => {
      const mean = Math.round((value.sum / value.n) * 100) / 100
      const category: MetaAdvice['category'] = mean < weak ? 'strengthen' : mean >= strong ? 'maintain' : 'watch'
      return { dimension, mean, samples: value.n, category }
    })
    .sort((a, b) => a.mean - b.mean || a.dimension.localeCompare(b.dimension))

  const limit = options.limit
  return {
    runs: runs.length,
    advice: limit === undefined ? advice : advice.slice(0, Math.max(0, limit)),
    aggregate: aggregateN > 0 ? Math.round((aggregateSum / aggregateN) * 1000) / 1000 : undefined,
    scoredCases,
  }
}

/** Render advice as human text. Only numbers and category labels — no prompt text. */
export function formatMetaAdvice(report: MetaAdviceReport, lang: 'zh' | 'en' = 'zh'): string {
  const zh = lang === 'zh'
  const lines: string[] = []
  lines.push(zh
    ? `离线优化建议（基于 ${report.runs} 次评测 / ${report.scoredCases} 个判分用例）`
    : `Offline advice (${report.runs} runs / ${report.scoredCases} scored cases)`)
  lines.push('')
  const aggregate = report.aggregate === undefined
    ? (zh ? 'n/a' : 'n/a')
    : report.aggregate.toFixed(3)
  lines.push(zh ? `综合分均值：${aggregate}` : `Mean aggregate: ${aggregate}`)
  if (report.advice.length === 0) {
    lines.push(zh ? '暂无维度评分——先运行带判官的评测。' : 'No dimension scores yet — run a judged evaluation first.')
    return lines.join('\n')
  }
  const label: Record<MetaAdvice['category'], string> = zh
    ? { strengthen: '需加强', maintain: '保持', watch: '关注' }
    : { strengthen: 'strengthen', maintain: 'maintain', watch: 'watch' }
  for (const item of report.advice) {
    lines.push(`  · ${item.dimension}: ${item.mean.toFixed(2)} (${item.samples}) → ${label[item.category]}`)
  }
  lines.push('')
  lines.push(zh
    ? '仅输出结构化评分与类别；出于隐私约束，不生成提示词原文或前后对比。'
    : 'Structured scores and categories only; by privacy design no prompt text or diff is produced.')
  return lines.join('\n')
}
