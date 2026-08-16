import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'

/** Schemastery's callable types input as the full output; the loader passes
 *  partial user config, so tests cast through `never` to model that. */
const validate = (input: unknown) => Config(input as never)

describe('Config schema', () => {
  it('fills defaults for an empty config', () => {
    const value = validate({})
    expect(value).toMatchObject({
      temperature: 0.2,
      maxTokens: 1200,
      maxRetries: 1,
      maxInputChars: 4000,
      timeoutMs: 60000,
      outputLanguage: 'auto',
      autoOptimize: false,
      autoOptimizePrefix: '/optimize ',
      minSectionChars: 10,
      maxTokenRetryFactor: 1.5,
      retryTemperatureStep: 0.3,
      skipIfAlreadyOptimized: false,
      autoOptimizeAll: false,
      hookIncludeOriginal: false,
      maxInputTokens: 3000,
    })
    expect(value.provider).toBeUndefined()
    expect(value.model).toBeUndefined()
    expect(value.extraInstructions).toBeUndefined()
    expect(value.examples).toEqual([])
  })

  it('accepts explicit values including new fields', () => {
    const value = validate({
      temperature: 0.5,
      maxRetries: 3,
      outputLanguage: '英文',
      autoOptimize: true,
      autoOptimizePrefix: '/优化 ',
      extraInstructions: '必须面向产品经理',
      examples: [{ input: 'a', output: 'b' }],
      minSectionChars: 20,
      maxTokenRetryFactor: 2,
      retryTemperatureStep: 0.5,
      skipIfAlreadyOptimized: true,
      autoOptimizeAll: true,
      hookIncludeOriginal: true,
      maxInputTokens: 5000,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    expect(value).toMatchObject({
      temperature: 0.5,
      maxRetries: 3,
      outputLanguage: '英文',
      autoOptimize: true,
      autoOptimizePrefix: '/优化 ',
      extraInstructions: '必须面向产品经理',
      examples: [{ input: 'a', output: 'b' }],
      minSectionChars: 20,
      maxTokenRetryFactor: 2,
      retryTemperatureStep: 0.5,
      skipIfAlreadyOptimized: true,
      autoOptimizeAll: true,
      hookIncludeOriginal: true,
      maxInputTokens: 5000,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
  })

  it('fails loudly on invalid values', () => {
    expect(() => validate({ temperature: 3 })).toThrow()
    expect(() => validate({ temperature: -0.1 })).toThrow()
    expect(() => validate({ maxTokens: 0 })).toThrow()
    expect(() => validate({ maxRetries: -1 })).toThrow()
    expect(() => validate({ maxRetries: 1.5 })).toThrow()
    expect(() => validate({ maxInputChars: 0 })).toThrow()
    expect(() => validate({ timeoutMs: 0 })).toThrow()
    expect(() => validate({ provider: 42 })).toThrow()
    expect(() => validate({ minSectionChars: -1 })).toThrow()
    expect(() => validate({ maxTokenRetryFactor: 0.5 })).toThrow()
    expect(() => validate({ retryTemperatureStep: 3 })).toThrow()
    expect(() => validate({ examples: [{ input: 'a' }] })).toThrow()
  })

  it('passes unknown keys through the schema (the constructor rejects them loudly)', () => {
    // Schemastery object schemas tolerate unknown keys; PromptOptimizerService
    // rejects them at construction so a config typo still fails the load.
    const value = validate({ unknownKey: true })
    expect(value).toMatchObject({ unknownKey: true, temperature: 0.2 })
  })
})
