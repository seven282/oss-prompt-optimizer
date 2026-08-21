/**
 * Local zero-token template renderer (1.5.6, 方案 A `localTemplate: 'auto'`).
 *
 * The four perception layers (task / role / situation / context) are pure
 * functions; the only model call in the whole pipeline is the prose
 * generation. For well-structured subcategories the skeleton + extracted
 * signals are enough to produce a usable four-section prompt **locally** —
 * no LLM call, no tokens, ~<5ms. A confidence gate decides when the local
 * render is appropriate; anything else falls back to the LLM pipeline.
 *
 * Pure-function layer: no harness dependency, unit-testable standalone.
 */

import { buildSituationProfile, detectMeasurable, detectTaskSubtype, extractMainVerbObject } from './situation.js'
import { ROLE_LIBRARY, SUB_TOPIC_TEMPLATES, type MetaLanguage, type TaskType } from './meta.js'

/** Local-render mode. `'auto'` renders only when the gate passes, else LLM. */
export type LocalTemplateMode = 'auto' | 'on' | 'off'

/** Why the gate rejected (`ok === true` → `'pass'`). */
export type LocalGateReason = 'pass' | 'off' | 'other-task' | 'no-subtype' | 'open-creative' | 'no-signal'

/** Whether a local (zero-token) render is appropriate for `input`. */
export interface LocalGateResult {
  ok: boolean
  reason: LocalGateReason
  taskType?: TaskType
  subtype?: string
}

/** Subcategories too open-ended for a local skeleton render. */
const OPEN_SUBTYPES: ReadonlySet<string> = new Set([
  'writing-creative',
  'writing-speech',
  'analysis-research',
  'analysis-forecast',
])

/**
 * Confidence gate: decide whether `input` can be answered with a local
 * template instead of an LLM call.
 * - `mode === 'off'` → never local.
 * - `mode === 'on'` → local whenever a subcategory matches (except
 *   open-ended ones listed above).
 * - `mode === 'auto'` (default) → additionally require at least one
 *   extractable signal (role / main-verb+object / goal / measurable /
 *   conversation context) so a bare instruction without usable details
 *   still gets the full LLM treatment.
 */
export function localTemplateGate(input: string, mode: LocalTemplateMode, context?: string): LocalGateResult {
  if (mode === 'off') return { ok: false, reason: 'off' }
  const profile = buildSituationProfile(input, context)
  const taskType = profile.task.type
  if (taskType === 'other') return { ok: false, reason: 'other-task', taskType }
  const subtype = profile.task.subtype ?? detectTaskSubtype(input, taskType)
  if (subtype === undefined) return { ok: false, reason: 'no-subtype', taskType }
  if (OPEN_SUBTYPES.has(subtype)) return { ok: false, reason: 'open-creative', taskType, subtype }
  if (mode === 'on') return { ok: true, reason: 'pass', taskType, subtype }
  // 'auto': require a usable signal beyond the bare category.
  const vo = extractMainVerbObject(input)
  const hasSignal =
    profile.role.explicit !== undefined ||
    profile.goal.primary !== undefined ||
    profile.goal.constraints.length > 0 ||
    vo !== undefined ||
    detectMeasurable(input) ||
    (context !== undefined && context.trim().length > 0)
  return hasSignal
    ? { ok: true, reason: 'pass', taskType, subtype }
    : { ok: false, reason: 'no-signal', taskType, subtype }
}

/**
 * Render a four-section prompt entirely from local signals (zero LLM calls).
 * Only call when `localTemplateGate` returned `ok`.
 */
export function buildLocalTemplate(
  input: string,
  subtype: string,
  metaLanguage: MetaLanguage = 'zh',
  context?: string,
): string {
  const en = metaLanguage === 'en'
  const profile = buildSituationProfile(input, context)
  const taskType = profile.task.type
  const skeleton = SUB_TOPIC_TEMPLATES[subtype as keyof typeof SUB_TOPIC_TEMPLATES]
  const roleRef = taskType !== undefined && taskType !== 'other' ? ROLE_LIBRARY[taskType] : undefined

  // ## Role: explicit role from the instruction, else the role-library reference.
  const role = profile.role.explicit ?? (roleRef !== undefined ? (en ? roleRef.en : roleRef.zh) : (en ? 'senior assistant' : '资深助理'))

  // ## Task: skeleton task chain + extracted verb/object (when present).
  const skelTask = en ? skeleton.en : skeleton.zh
  const vo = extractMainVerbObject(input)
  const voLine = vo !== undefined
    ? (en ? `- Core action: ${vo.verb} ${vo.object} (from the raw instruction).` : `- 核心动作：${vo.verb}「${vo.object}」（来自原始指令）。`)
    : ''
  const taskLines = [skelTask, voLine].filter((l) => l.length > 0).join('\n')

  // ## Context: goals / constraints / measurable / conversation context.
  const goalParts: string[] = []
  if (profile.goal.primary !== undefined) goalParts.push(profile.goal.primary)
  for (const c of profile.goal.constraints) goalParts.push(c)
  const measurableLine = detectMeasurable(input) ? (en ? '- Satisfy quantifiable requirements (count / deadline).' : '- 需满足可量化要求（数量/期限等）。') : ''
  const contextLines = [
    ...goalParts.map((g) => (en ? `- ${g}` : `- ${g}`)),
    measurableLine,
    ...(context !== undefined && context.trim().length > 0
      ? [en ? `- Conversation context: ${context.trim()}` : `- 对话背景：${context.trim()}`]
      : []),
  ].filter((l) => l.length > 0)
  const contextBlock = contextLines.length > 0
    ? contextLines.join('\n')
    : (en ? 'No extra context — apply general standards.' : '无额外背景，按通用标准执行。')

  // ## Format: skeleton format chain (after the last '；' or full string).
  const skelParts = (en ? skeleton.en : skeleton.zh).split('；')
  const formatBlock = skelParts.length > 1 ? skelParts[skelParts.length - 1] : (en ? skeleton.en : skeleton.zh)

  return [
    '## Role',
    role,
    '',
    '## Task',
    taskLines,
    '',
    '## Context',
    contextBlock,
    '',
    '## Format',
    formatBlock,
  ].join('\n')
}
