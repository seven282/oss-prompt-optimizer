/**
 * Machine-readable error codes for the prompt-optimizer capability. Every
 * failure path — the loud `OptimizeError` throws and the graceful
 * `OptimizeResult.errorCode` fallback field — shares this vocabulary so
 * callers (commands, tools, other plugins) can react programmatically
 * instead of matching on message text.
 */

/** Stable, typed error-code vocabulary. */
export const OptimizeErrorCode = {
  /** The instruction was empty or not a string. */
  EMPTY_INPUT: 'EMPTY_INPUT',
  /** No model route could be resolved (incomplete config pair / no default model). */
  NO_MODEL_ROUTE: 'NO_MODEL_ROUTE',
  /** The per-call deadline elapsed before the model call finished. */
  TIMEOUT: 'TIMEOUT',
  /** The model output hit `maxTokens`. */
  MAX_TOKENS: 'MAX_TOKENS',
  /** The output was missing one or more required sections. */
  MISSING_SECTIONS: 'MISSING_SECTIONS',
  /** A section body was shorter than `minSectionChars`. */
  THIN_SECTIONS: 'THIN_SECTIONS',
  /** A plain-style output was shorter than `minSectionChars`. */
  THIN_OUTPUT: 'THIN_OUTPUT',
  /** A plain-style output still carried four-section headings. */
  HEADINGS_IN_PLAIN: 'HEADINGS_IN_PLAIN',
  /** The model unexpectedly requested a tool call. */
  TOOL_CALL: 'TOOL_CALL',
  /** The model returned an unrecognized finish reason. */
  UNSUPPORTED_FINISH: 'UNSUPPORTED_FINISH',
  /** The model produced no text at all. */
  NO_TEXT: 'NO_TEXT',
  /** Any other failure not covered above. */
  UNKNOWN: 'UNKNOWN',
} as const

/** Union of all stable error codes. */
export type OptimizeErrorCode = (typeof OptimizeErrorCode)[keyof typeof OptimizeErrorCode]

/** An error carrying a stable machine-readable code. */
export class OptimizeError extends Error {
  constructor(
    readonly code: OptimizeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'OptimizeError'
  }
}

/** Command-facing Chinese text per error code (stable, caller-rendered). */
export const OPTIMIZE_ERROR_TEXT: Record<OptimizeErrorCode, string> = {
  [OptimizeErrorCode.EMPTY_INPUT]: 'prompt-optimize: 指令不能为空',
  [OptimizeErrorCode.NO_MODEL_ROUTE]: 'prompt-optimize: 未配置模型路由，请配置 provider/model 或挂载 agentDefaultModel 服务',
  [OptimizeErrorCode.TIMEOUT]: 'prompt-optimize: 优化超时，请稍后重试或调大 timeoutMs',
  [OptimizeErrorCode.MAX_TOKENS]: 'prompt-optimize: 输出超出长度上限，建议调大 maxTokens',
  [OptimizeErrorCode.MISSING_SECTIONS]: 'prompt-optimize: 模型输出缺少必需段落（## Role / ## Task / ## Context / ## Format）',
  [OptimizeErrorCode.THIN_SECTIONS]: 'prompt-optimize: 模型输出的段落内容过短',
  [OptimizeErrorCode.THIN_OUTPUT]: 'prompt-optimize: 模型输出的内容过短',
  [OptimizeErrorCode.HEADINGS_IN_PLAIN]: 'prompt-optimize: 模型输出包含小节标题（plain 模式不应出现 ## Role 等标题）',
  [OptimizeErrorCode.TOOL_CALL]: 'prompt-optimize: 模型意外请求调用工具',
  [OptimizeErrorCode.UNSUPPORTED_FINISH]: 'prompt-optimize: 模型返回了不支持的结束原因',
  [OptimizeErrorCode.NO_TEXT]: 'prompt-optimize: 模型未输出任何文本',
  [OptimizeErrorCode.UNKNOWN]: 'prompt-optimize: 未知错误',
}
