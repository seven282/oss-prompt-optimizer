import { PromptOptimizerService } from './optimizer.js'

/** Loader-diagnostic plugin name. */
export const name = 'prompt-optimizer'
/** Services required before the plugin loads. */
export const inject = ['llm', 'tools', 'systemPrompt', 'commands']

export { Config } from './config.js'
export type { Config as ConfigType, PromptExample } from './config.js'
export { buildIteratePrompt, buildOptimizePrompt, detectLanguage, META_ITERATE, META_ITERATE_EN, META_PROMPT } from './meta.js'
import { OptimizeErrorCode as OptimizeErrorCodeValue } from './errors.js'
export { OptimizeError, OPTIMIZE_ERROR_TEXT } from './errors.js'
// 声明式同名导出:value/type 双面(该 TS 配置下 re-export 同名会 TS2300)。
export const OptimizeErrorCode = OptimizeErrorCodeValue
export type OptimizeErrorCode = (typeof OptimizeErrorCodeValue)[keyof typeof OptimizeErrorCodeValue]
export { MaxTokensError, PromptOptimizerService, PROMPT_OPTIMIZER_TIMEOUT_CODE } from './optimizer.js'
export type { OptimizeOptions, OptimizeResult } from './optimizer.js'
export { PROMPT_OPTIMIZER_EVENTS } from './events.js'
export type { OptimizeMethod, OptimizeOutcomePayload, OptimizeStartPayload } from './events.js'
export { PROMPT_OPTIMIZE_DESCRIPTION, renderOptimizeResult } from './tool.js'
export { AUTO_OPTIMIZE_NOTE, isTriggered, messageText, optimizedMessage, registerAutoOptimizeHook } from './hook.js'
export { buildContextBlock, contextMessageText, gatherConversationContext } from './context.js'
export type { ContextMessage, GatherContextOptions } from './context.js'
export { registerOptimizeCommand } from './command.js'
export { DEFAULT_TEMPLATES, validateTemplateSet } from './templates.js'
export type { TemplateSet } from './templates.js'
export {
  assertInput,
  estimateTokens,
  hasAllSections,
  hasSubstantialContent,
  hasValidSections,
  INCOMPLETE_SECTIONS_MESSAGE,
  REQUIRED_SECTIONS,
  sectionBody,
  thinOutputMessage,
  thinSectionsMessage,
  truncateByTokens,
  truncateInput,
} from './validate.js'

export default PromptOptimizerService
