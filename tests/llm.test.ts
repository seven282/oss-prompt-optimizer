import { describe, expect, it } from 'vitest'
import { BlockAssembler, type FinishReason, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { assembleStream, finishToError, MaxTokensError } from '../src/llm.js'
import { OptimizeError, OptimizeErrorCode } from '../src/errors.js'

describe('finishToError', () => {
  it('accepts a stop finish', () => {
    expect(finishToError({ kind: 'stop' } as FinishReason)).toBeUndefined()
  })

  it('classifies max-tokens as MaxTokensError', () => {
    const error = finishToError({ kind: 'max-tokens' } as FinishReason)
    expect(error).toBeInstanceOf(MaxTokensError)
    expect(error).toBeInstanceOf(OptimizeError)
    expect((error as OptimizeError).code).toBe(OptimizeErrorCode.MAX_TOKENS)
  })

  it('rejects an unexpected tool-call finish', () => {
    const error = finishToError({ kind: 'tool-calls' } as FinishReason)
    expect(error).toBeInstanceOf(OptimizeError)
    expect((error as OptimizeError).code).toBe(OptimizeErrorCode.TOOL_CALL)
  })

  it('translates an error finish with its code', () => {
    const error = finishToError({ kind: 'error', failure: { message: 'boom', code: 'RATE_LIMIT' } } as FinishReason)
    expect(error?.message).toBe('prompt-optimizer: boom')
    expect((error as { code?: string }).code).toBe('RATE_LIMIT')
  })

  it('translates an aborted finish with its code', () => {
    const error = finishToError({ kind: 'aborted', failure: { message: 'gone', code: 'AUTH' } } as FinishReason)
    expect(error?.message).toBe('prompt-optimizer: gone')
    expect((error as { code?: string }).code).toBe('AUTH')
  })

  it('rejects an unknown finish kind', () => {
    const error = finishToError({ kind: 'weird' } as unknown as FinishReason)
    expect(error).toBeInstanceOf(OptimizeError)
    expect((error as OptimizeError).code).toBe(OptimizeErrorCode.UNSUPPORTED_FINISH)
  })
})

describe('assembleStream', () => {
  it('concatenates text blocks and ignores other block types', () => {
    const assembler = new BlockAssembler()
    for (const chunk of [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '角色：' },
      { type: 'text-delta', index: 0, text: '分析师' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '角色：分析师' } },
      { type: 'block-start', index: 1, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 1, text: '思考中' },
      { type: 'block-end', index: 1, block: { type: 'reasoning', text: '思考中' } },
      { type: 'block-start', index: 2, blockType: 'text' },
      { type: 'text-delta', index: 2, text: '。' },
      { type: 'block-end', index: 2, block: { type: 'text', text: '。' } },
    ] as StreamChunk[]) {
      assembler.push(chunk)
    }
    expect(assembleStream(assembler)).toBe('角色：分析师。')
  })
})
