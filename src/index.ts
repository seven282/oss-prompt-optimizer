import { PromptOptimizerService } from './optimizer.js'

/** Loader-diagnostic plugin name. */
export const name = 'prompt-optimizer'
/** Services required before the plugin loads. */
export const inject = ['llm', 'tools', 'systemPrompt', 'commands']

export { Config } from './config.js'
export type { Config as ConfigType, PromptExample } from './config.js'
export { buildOptimizePrompt, META_PROMPT } from './meta.js'
export { MaxTokensError, PromptOptimizerService, PROMPT_OPTIMIZER_TIMEOUT_CODE } from './optimizer.js'
export type { OptimizeOptions, OptimizeResult } from './optimizer.js'
export { PROMPT_OPTIMIZE_DESCRIPTION, renderOptimizeResult } from './tool.js'
export { AUTO_OPTIMIZE_NOTE, isTriggered, messageText, optimizedMessage, registerAutoOptimizeHook } from './hook.js'
export { registerOptimizeCommand } from './command.js'
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
