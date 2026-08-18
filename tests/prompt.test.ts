import { describe, expect, it } from 'vitest'
import { buildIterateSystem, buildOptimizeSystem, type PromptBuildContext } from '../src/prompt.js'
import { DEFAULT_TEMPLATES } from '../src/templates.js'

const ctx: PromptBuildContext = {
  outputStyle: 'sections',
  extraInstructions: '必须面向产品经理',
  examples: [{ input: '写诗', output: '## Role\n诗人' }],
  metaLanguage: 'zh',
  templates: DEFAULT_TEMPLATES,
}

describe('buildOptimizeSystem', () => {
  it('carries the input and the extra instructions into the prompt', () => {
    const system = buildOptimizeSystem(ctx, '写一份周报', 'auto')
    expect(system).toContain('写一份周报')
    expect(system).toContain('必须面向产品经理')
    expect(system).not.toContain('{{原始指令}}')
  })

  it('uses the English role document when the language is English', () => {
    const system = buildOptimizeSystem({ ...ctx, metaLanguage: 'en' }, '写一份周报', 'auto')
    expect(system).toContain('optimization expert')
  })

  it('injects the diagnosis into the prompt', () => {
    const system = buildOptimizeSystem(ctx, '写一份周报', 'auto', '缺少以下段落：## Context。')
    expect(system).toContain('缺少以下段落：## Context。')
  })

  it('omits examples in plain style', () => {
    const system = buildOptimizeSystem({ ...ctx, outputStyle: 'plain' }, '写一份周报', 'auto')
    expect(system).not.toContain('示例 1')
  })
})

describe('buildIterateSystem', () => {
  const LAST = '## Role\n分析师\n\n## Task\n写周报\n\n## Context\n团队 5 人\n\n## Format\n300 字'

  it('carries the previous result and the new instruction', () => {
    const system = buildIterateSystem(ctx, LAST, '改成 500 字', 'auto')
    expect(system).toContain(LAST)
    expect(system).toContain('改成 500 字')
    expect(system).not.toContain('{{上次结果}}')
    expect(system).not.toContain('{{迭代指令}}')
  })
})
