import { buildIteratePrompt, buildOptimizePrompt, type MetaLanguage } from './meta.js'
import type { PromptExample } from './config.js'
import type { TemplateSet } from './templates.js'

/**
 * The per-call inputs the service maps onto the meta-prompt builders. One
 * stable context object keeps the three call sites (optimize / iterate /
 * refine) from each re-translating config fields into builder arguments.
 */
export interface PromptBuildContext {
  outputStyle: 'sections' | 'plain'
  extraInstructions: string | undefined
  examples: PromptExample[] | undefined
  metaLanguage: MetaLanguage
  templates: TemplateSet
}

/** Build the system prompt for one `optimize` model call. Pure function. */
export function buildOptimizeSystem(
  ctx: PromptBuildContext,
  input: string,
  outputLanguage: string,
  diagnosis?: string,
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
  )
}

/** Build the system prompt for one `iterate` / `selfRefine` model call. Pure function. */
export function buildIterateSystem(
  ctx: PromptBuildContext,
  last: string,
  next: string,
  outputLanguage: string,
  diagnosis?: string,
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
  )
}
