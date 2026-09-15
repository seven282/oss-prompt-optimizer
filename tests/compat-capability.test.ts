import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_SOURCES,
  DEGRADATION_NOTES,
  describeDegradations,
  formatCapabilitySummary,
  formatCompatReport,
  probeCapabilities,
  type Capabilities,
} from '../src/compat/capability.js'

/** Build a capability set with the named entries removed. */
function without(...missing: (keyof Capabilities)[]): Capabilities {
  const full = probeCapabilities()
  const copy: Record<string, unknown> = { ...full }
  for (const key of missing) copy[key] = null
  return copy as unknown as Capabilities
}

describe('probeCapabilities', () => {
  it('resolves every capability against the installed harness packages', () => {
    const caps = probeCapabilities()
    expect(caps.defineTool).not.toBeNull()
    expect(caps.createUserMessage).not.toBeNull()
    expect(caps.BlockAssembler).not.toBeNull()
  })

  it('is safe to call repeatedly', () => {
    expect(probeCapabilities()).toEqual(probeCapabilities())
  })

  it('names the exact package and export each capability comes from', () => {
    expect(CAPABILITY_SOURCES.defineTool).toEqual(['@deepseek-ai/dsh-tools', 'defineTool'])
    expect(CAPABILITY_SOURCES.createUserMessage).toEqual(['@deepseek-ai/dsh-llm', 'createUserMessage'])
    expect(CAPABILITY_SOURCES.BlockAssembler).toEqual(['@deepseek-ai/dsh-llm', 'BlockAssembler'])
  })
})

describe('formatCapabilitySummary', () => {
  it('marks each capability ok or MISSING', () => {
    expect(formatCapabilitySummary(probeCapabilities())).toBe(
      'defineTool=ok createUserMessage=ok BlockAssembler=ok',
    )
    expect(formatCapabilitySummary(without('defineTool'))).toBe(
      'defineTool=MISSING createUserMessage=ok BlockAssembler=ok',
    )
  })
})

describe('describeDegradations', () => {
  it('reports nothing when every capability is present', () => {
    expect(describeDegradations(probeCapabilities())).toEqual([])
  })

  it('maps a missing capability to the feature it disables and what survives', () => {
    const degradations = describeDegradations(without('defineTool'))
    expect(degradations).toHaveLength(1)
    expect(degradations[0].capability).toBe('defineTool')
    expect(degradations[0].feature).toContain('prompt_optimize')
    expect(degradations[0].stillWorks).toContain('/optimize')
  })

  it('covers every capability with a note, so none can degrade silently', () => {
    const covered = new Set(DEGRADATION_NOTES.map((note) => note.capability))
    expect(covered).toEqual(new Set(['defineTool', 'createUserMessage', 'BlockAssembler']))
  })

  it('lists degradations in a stable order', () => {
    const degradations = describeDegradations(without('defineTool', 'createUserMessage', 'BlockAssembler'))
    expect(degradations.map((d) => d.capability)).toEqual([
      'defineTool',
      'createUserMessage',
      'BlockAssembler',
    ])
  })
})

describe('formatCompatReport', () => {
  it('reports a healthy host on one line', () => {
    const report = formatCompatReport(probeCapabilities())
    expect(report).toContain('host compat ok')
    expect(report).not.toContain('DEGRADED')
  })

  it('names every missing capability when degraded', () => {
    const report = formatCompatReport(without('defineTool', 'BlockAssembler'))
    expect(report).toContain('DEGRADED')
    expect(report).toContain('defineTool=MISSING')
    expect(report).toContain('BlockAssembler=MISSING')
    expect(report).toContain('prompt_optimize')
    expect(report).toContain('UNSUPPORTED_ENV')
  })

  it('stays a single line so it reads as one startup log entry', () => {
    expect(formatCompatReport(without('defineTool')).split('\n')).toHaveLength(1)
  })
})
