import { buildIteratePrompt, buildOptimizePrompt } from './meta.js';
/** Build the system prompt for one `optimize` model call. Pure function. */
export function buildOptimizeSystem(ctx, input, outputLanguage, diagnosis, profile) {
    return buildOptimizePrompt(input, outputLanguage, ctx.extraInstructions, ctx.examples, ctx.outputStyle, ctx.metaLanguage, diagnosis, ctx.templates, ctx.context, undefined, ctx.maxOutputTokens, profile, ctx.situationProfileLevel, ctx.builtinExamples, ctx.compact, ctx.sceneRefEnabled);
}
/** Build the system prompt for one `iterate` / `selfRefine` model call. Pure function. */
export function buildIterateSystem(ctx, last, next, outputLanguage, diagnosis, profile, drift) {
    return buildIteratePrompt(last, next, outputLanguage, ctx.extraInstructions, ctx.examples, ctx.outputStyle, ctx.metaLanguage, diagnosis, ctx.templates, ctx.context, undefined, ctx.maxOutputTokens, profile, drift, ctx.situationProfileLevel, ctx.builtinExamples, ctx.compact, ctx.sceneRefEnabled);
}
