import { buildIteratePrompt, buildOptimizePrompt, type MetaLanguage } from './meta.js'
import type { PromptExample } from './config.js'
import type { TemplateSet } from './templates.js'
import type { GoalDrift, SituationProfile, SituationProfileLevel } from './situation.js'

/**
 * The per-call inputs the service maps onto the meta-prompt builders. One
 * stable context object keeps the three call sites (optimize / iterate /
 * refine) from each re-translating config fields into builder arguments.
 */
export interface PromptBuildContext {
  outputStyle: 'sections' | 'plain' | 'role-task-goal'
  extraInstructions: string | undefined
  examples: PromptExample[] | undefined
  metaLanguage: MetaLanguage
  templates: TemplateSet
  /** Optional conversation context (background reference only). */
  context?: string
  /** Suggested output-length cap in tokens (soft guideline; 0/absent disables). */
  maxOutputTokens?: number
  /** Situation-profile injection budget (`situationProfileLevel`). */
  situationProfileLevel?: SituationProfileLevel
  /** Whether to inject the built-in example pair when no explicit examples
   *  are configured (`builtinExamples`; undefined = on). */
  builtinExamples?: boolean
  /** P-A compact tier (1.6.8): strip hint blocks for simple instructions. */
  compact?: boolean
  /** Whether to inject scene reference (role library + sub-topic templates).
   *  `false` disables it — saves ~200 input tokens per call. */
  sceneRefEnabled?: boolean
}

/** Build the system prompt for one `optimize` model call. Pure function. */
export function buildOptimizeSystem(
  ctx: PromptBuildContext,
  input: string,
  outputLanguage: string,
  diagnosis?: string,
  profile?: SituationProfile,
): string {
  return buildOptimizePrompt(
    input,
    outputLanguage,
    ctx.extraInstructions,
    ctx.examples,
    ctx.outputStyle,
    ctx.metaLanguage,
    diagnosis,
    ctx.templates,
    ctx.context,
    undefined,
    ctx.maxOutputTokens,
    profile,
    ctx.situationProfileLevel,
    ctx.builtinExamples,
    ctx.compact,
    ctx.sceneRefEnabled,
  )
}

/** Build the system prompt for one `iterate` / `selfRefine` model call. Pure function. */
export function buildIterateSystem(
  ctx: PromptBuildContext,
  last: string,
  next: string,
  outputLanguage: string,
  diagnosis?: string,
  profile?: SituationProfile,
  drift?: GoalDrift,
): string {
  return buildIteratePrompt(
    last,
    next,
    outputLanguage,
    ctx.extraInstructions,
    ctx.examples,
    ctx.outputStyle,
    ctx.metaLanguage,
    diagnosis,
    ctx.templates,
    ctx.context,
    undefined,
    ctx.maxOutputTokens,
    profile,
    drift,
    ctx.situationProfileLevel,
    ctx.builtinExamples,
    ctx.compact,
    ctx.sceneRefEnabled,
  )
}
