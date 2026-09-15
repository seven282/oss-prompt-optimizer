import { PromptOptimizerService } from './optimizer.js'

/** Loader-diagnostic plugin name. */
export const name = 'prompt-optimizer'
/**
 * Services required before the plugin loads.
 *
 * 1.8.2: reduced from `['llm','tools','systemPrompt','commands']` to the one
 * service the plugin genuinely cannot work without. The rest are injected per
 * feature through `ctx.inject()` inside `PromptOptimizerService`, so a harness
 * service rename disables a single feature instead of the whole plugin.
 */
export const inject = ['llm']

export { Config } from './config.js'
export type { Config as ConfigType, PromptExample } from './config.js'
export { buildIteratePrompt, buildOptimizePrompt, detectLanguage, detectTaskType, META_ITERATE, META_ITERATE_EN, META_PROMPT } from './meta.js'
export type { MetaLanguage, TaskType } from './meta.js'
import { OptimizeErrorCode as OptimizeErrorCodeValue } from './errors.js'
export { OptimizeError, OPTIMIZE_ERROR_TEXT, INCOMPLETE_SECTIONS_MESSAGE, metaContentMessage, plainHeadingsMessage, thinOutputMessage, thinSectionsMessage } from './errors.js'
// 声明式同名导出:value/type 双面(该 TS 配置下 re-export 同名会 TS2300)。
export const OptimizeErrorCode = OptimizeErrorCodeValue
export type OptimizeErrorCode = (typeof OptimizeErrorCodeValue)[keyof typeof OptimizeErrorCodeValue]
export { MaxTokensError, PromptOptimizerService, PROMPT_OPTIMIZER_TIMEOUT_CODE } from './optimizer.js'
export type { OptimizeOptions, OptimizeResult } from './optimizer.js'
export { PROMPT_OPTIMIZER_EVENTS } from './events.js'
export type { OptimizeMethod, OptimizeOutcomePayload, OptimizeStartPayload } from './events.js'
export { renderOptimizeResult } from './tool.js'
export { AUTO_OPTIMIZE_NOTE, isTriggered, messageText, optimizedMessage, registerAutoOptimizeHook } from './hook.js'
// 1.8.2 (方案 D) 兼容层：能力探测结果可供宿主状态页/命令展示，也让发布前的
// preflight 能在真实环境里断言"哪些功能处于降级"。
export { describeDegradations, formatCompatReport, probeCapabilities } from './compat/index.js'
export type { Capabilities, Degradation } from './compat/index.js'
export { buildContextBlock, contextMessageText, gatherConversationContext } from './context.js'
export type { ContextMessage, GatherContextOptions } from './context.js'
export { buildSituationProfile, detectMeasurable, detectTaskSubtype, goalAlignment, goalDrift, mergeGoals, renderSituationBlock, subtypeLabel } from './situation.js'
export type { GoalDrift, GoalProfile, RoleProfile, SituationProfile, SituationProfileLevel, TaskProfile, TaskSubtype } from './situation.js'
export { registerOptimizeCommand } from './command.js'
export { createSettingsBridge } from './settings.js'
export { formatStatus } from './status.js'
export type { StatusSnapshot, StatusEvent } from './status.js'
export type { SettingsBridge } from './settings.js'
export { DEFAULT_TEMPLATES, validateTemplateSet } from './templates.js'
export type { TemplateSet } from './templates.js'
export {
  assertInput,
  estimateTokens,
  hasAllSections,
  hasOptimizedSections,
  hasSubstantialContent,
  hasValidSections,
  REQUIRED_SECTIONS,
  sectionBody,
  truncateByTokens,
  truncateInput,
} from './validate.js'

export default PromptOptimizerService
