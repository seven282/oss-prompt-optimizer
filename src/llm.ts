import type { BlockAssembler, FinishReason } from '@deepseek-ai/dsh-llm'
import { OptimizeError, OptimizeErrorCode } from './errors.js'

/**
 * Raised when a model call stops because the output hit `maxTokens`.
 * Re-exported from `./optimizer.js` (and `index.js`) to keep the public
 * API surface unchanged.
 */
export class MaxTokensError extends OptimizeError {
  constructor() {
    super(OptimizeErrorCode.MAX_TOKENS, 'prompt-optimizer: model output reached maxTokens')
    this.name = 'MaxTokensError'
  }
}

/** Translate a terminal finish reason into a thrown error, or accept `stop`. Pure function. */
export function finishToError(finish: FinishReason): Error | undefined {
  const kind = (finish as { kind: string }).kind
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(`prompt-optimizer: ${finish.failure.message}`)
      Object.assign(error, { code: finish.failure.code })
      return error
    }
    case 'max-tokens':
      return new MaxTokensError()
    case 'tool-calls':
      return new OptimizeError(OptimizeErrorCode.TOOL_CALL, 'prompt-optimizer: model unexpectedly requested a tool')
    default:
      return new OptimizeError(
        OptimizeErrorCode.UNSUPPORTED_FINISH,
        `prompt-optimizer: unsupported finish reason "${kind}"`,
      )
  }
}

/** Concatenate the text blocks of a finished stream assembler. Pure function. */
export function assembleStream(assembler: BlockAssembler): string {
  return assembler
    .blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}
