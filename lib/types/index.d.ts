import { PromptOptimizerService } from './optimizer.js';
/** Loader-diagnostic plugin name. */
export declare const name = "prompt-optimizer";
/**
 * Services required before the plugin loads.
 *
 * 1.8.2: reduced from `['llm','tools','systemPrompt','commands']` to the one
 * service the plugin genuinely cannot work without. The rest are injected per
 * feature through `ctx.inject()` inside `PromptOptimizerService`, so a harness
 * service rename disables a single feature instead of the whole plugin.
 */
export declare const inject: string[];
export { Config } from './config.js';
export type { Config as ConfigType, PromptExample } from './config.js';
export { buildIteratePrompt, buildOptimizePrompt, detectLanguage, detectTaskType, META_ITERATE, META_ITERATE_EN, META_PROMPT } from './meta.js';
export type { MetaLanguage, TaskType } from './meta.js';
import { OptimizeErrorCode as OptimizeErrorCodeValue } from './errors.js';
export { OptimizeError, OPTIMIZE_ERROR_TEXT, INCOMPLETE_SECTIONS_MESSAGE, metaContentMessage, plainHeadingsMessage, thinOutputMessage, thinSectionsMessage } from './errors.js';
export declare const OptimizeErrorCode: {
    readonly EMPTY_INPUT: "EMPTY_INPUT";
    readonly NO_MODEL_ROUTE: "NO_MODEL_ROUTE";
    readonly TIMEOUT: "TIMEOUT";
    readonly MAX_TOKENS: "MAX_TOKENS";
    readonly TOO_MANY_CALLS: "TOO_MANY_CALLS";
    readonly BUDGET_EXCEEDED: "BUDGET_EXCEEDED";
    readonly MISSING_SECTIONS: "MISSING_SECTIONS";
    readonly THIN_SECTIONS: "THIN_SECTIONS";
    readonly THIN_OUTPUT: "THIN_OUTPUT";
    readonly HEADINGS_IN_PLAIN: "HEADINGS_IN_PLAIN";
    readonly GOAL_MISALIGNED: "GOAL_MISALIGNED";
    readonly META_CONTENT: "META_CONTENT";
    readonly TOOL_CALL: "TOOL_CALL";
    readonly UNSUPPORTED_FINISH: "UNSUPPORTED_FINISH";
    readonly NO_TEXT: "NO_TEXT";
    readonly UNSUPPORTED_ENV: "UNSUPPORTED_ENV";
    readonly UNKNOWN: "UNKNOWN";
};
export type OptimizeErrorCode = (typeof OptimizeErrorCodeValue)[keyof typeof OptimizeErrorCodeValue];
export { MaxTokensError, PromptOptimizerService, PROMPT_OPTIMIZER_TIMEOUT_CODE } from './optimizer.js';
export type { OptimizeOptions, OptimizeResult } from './optimizer.js';
export { PROMPT_OPTIMIZER_EVENTS } from './events.js';
export type { OptimizeMethod, OptimizeOutcomePayload, OptimizeStartPayload } from './events.js';
export { renderOptimizeResult } from './tool.js';
export { AUTO_OPTIMIZE_NOTE, isTriggered, messageText, optimizedMessage, registerAutoOptimizeHook } from './hook.js';
export { describeDegradations, formatCompatReport, probeCapabilities } from './compat/index.js';
export type { Capabilities, Degradation } from './compat/index.js';
export { buildContextBlock, contextMessageText, gatherConversationContext } from './context.js';
export type { ContextMessage, GatherContextOptions } from './context.js';
export { buildSituationProfile, detectMeasurable, detectTaskSubtype, goalAlignment, goalDrift, mergeGoals, renderSituationBlock, subtypeLabel } from './situation.js';
export type { GoalDrift, GoalProfile, RoleProfile, SituationProfile, SituationProfileLevel, TaskProfile, TaskSubtype } from './situation.js';
export { registerOptimizeCommand } from './command.js';
export { createSettingsBridge } from './settings.js';
export { formatStatus } from './status.js';
export type { StatusSnapshot, StatusEvent } from './status.js';
export { selectCandidatePure, scoreCandidates, candidateTemperature, structuralScore, formatSelection, selectionToken } from './select.js';
export type { Candidate, CandidateGate, CandidateJudge, CandidateScore, SelectionSummary } from './select.js';
export { feedbackBias, feedbackItems, formatFeedback, mergeItems, normalizeItem } from './feedback.js';
export type { FeedbackLedger, MessageFeedbackLike } from './feedback.js';
export type { SettingsBridge } from './settings.js';
export { DEFAULT_TEMPLATES, validateTemplateSet } from './templates.js';
export type { TemplateSet } from './templates.js';
export { assertInput, estimateTokens, hasAllSections, hasOptimizedSections, hasSubstantialContent, hasValidSections, REQUIRED_SECTIONS, sectionBody, truncateByTokens, truncateInput, } from './validate.js';
export default PromptOptimizerService;
