import type { BlockAssembler, FinishReason } from '@deepseek-ai/dsh-llm'
import { OptimizeError, OptimizeErrorCode } from './errors.js'

/**
 * Raised when a model call stops because the output hit `maxTokens`.
 * `partial` carries the text assembled before truncation — the resume
 * (断点续传) path appends it to the accumulated output and asks the next
 * call to continue from there. Re-exported from `./optimizer.js` (and
 * `index.js`) to keep the public API surface unchanged.
 */
export class MaxTokensError extends OptimizeError {
  /** The text produced before the `max-tokens` finish (empty when none). */
  readonly partial: string

  constructor(partial = '') {
    super(OptimizeErrorCode.MAX_TOKENS, 'prompt-optimizer: model output reached maxTokens')
    this.name = 'MaxTokensError'
    this.partial = partial
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
      // C-2 修复：统一为 OptimizeError（可被 instanceof 识别、errorCode 归因不落
      // UNKNOWN），harness 原始 code 经 detailCode 保留（message 含原文）。
      const error = new OptimizeError(
        OptimizeErrorCode.UNKNOWN,
        `prompt-optimizer: ${finish.failure.message}`,
      )
      Object.assign(error, { detailCode: finish.failure.code })
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

/**
 * Extended MaxTokensError that carries the partial output for resume (断点续传).
 * Created by optimizer.ts when handling max-tokens truncation, allowing safe
 * attachment of partial data without unsafe type assertions.
 */
export class MaxTokensErrorWithPartial extends MaxTokensError {
  constructor(
    partial: string,
    original: MaxTokensError
  ) {
    super(partial)
    this.name = 'MaxTokensErrorWithPartial'
    // Preserve original error's stack and cause information
    if (original.cause) {
      this.cause = original.cause
    }
  }
}
