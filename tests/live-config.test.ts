import { describe, expect, it } from 'vitest'
import {
  adoptLiveConfig,
  followVolatileUpdates,
  isVolatileRef,
  plainConfig,
  VOLATILE_UPDATE_EVENT,
} from '../src/live-config.js'

/**
 * The volatile-config handshake, with NO harness in the loop: a reference is
 * just `{ get() }` tagged with a registry symbol, so the whole contract can be
 * exercised with local objects. `tests/optimizer.test.ts` covers the service
 * end (that a real config holding references produces plain reads).
 */

const WRITE = Symbol.for('cosmokit.volatile.write')

/** A faithful cosmokit-style reference: tagged, value swapped in place. */
function reference<T>(initial: T): { ref: Record<string | symbol, unknown>; write(next: T): void } {
  let current: T = initial
  const ref: Record<string | symbol, unknown> = {
    get: () => current,
    [WRITE]: (next: T) => {
      current = next
    },
  }
  return { ref, write: (next: T) => { current = next } }
}

describe('isVolatileRef', () => {
  it('recognises the protocol marker, whatever built the object', () => {
    // Symbol.for, not a package-local symbol: the host may hand over references
    // built by ITS copy of cosmokit, and those have to be recognised.
    expect(isVolatileRef(reference('x').ref)).toBe(true)
    expect(isVolatileRef({ get: () => 'x' })).toBe(false)
    expect(isVolatileRef(null)).toBe(false)
    expect(isVolatileRef('x')).toBe(false)
    expect(isVolatileRef({ [WRITE]: () => {} })).toBe(true)
  })
})

describe('plainConfig', () => {
  it('unwraps references and leaves ordinary fields untouched', () => {
    const { ref } = reference(true)
    const config = { hot: ref, cold: { a: 1 }, n: 2 }
    const plain = plainConfig(config)
    expect(plain).toEqual({ hot: true, cold: { a: 1 }, n: 2 })
    // A fresh object: the service must never hand the loader's reference-shaped
    // object to code that reads values.
    expect(plain).not.toBe(config)
    expect(plain.hot).toBe(true)
  })

  it('reports the CURRENT value, not the one at construction', () => {
    const { ref, write } = reference(false)
    expect(plainConfig({ hot: ref }).hot).toBe(false)
    write(true)
    expect(plainConfig({ hot: ref }).hot).toBe(true)
  })
})

describe('adoptLiveConfig', () => {
  it('refreshes in place so holders of the object see the change', () => {
    const { ref, write } = reference('off')
    const source = { hot: ref, other: 1 }
    const target = plainConfig(source)
    const holder = target
    expect(target.hot).toBe('off')
    write('on')
    const returned = adoptLiveConfig(target, source)
    // Same identity — the tool / hook / command layers captured this object.
    expect(returned).toBe(target)
    expect(holder.hot).toBe('on')
  })

  it('unwraps a reference for a key the snapshot did not carry', () => {
    const target: Record<string, unknown> = { a: 1 }
    const { ref } = reference('new')
    adoptLiveConfig(target, { a: 9, b: ref })
    expect(target).toEqual({ a: 9, b: 'new' })
  })
})

describe('followVolatileUpdates', () => {
  it('refreshes the snapshot when the loader commits an edit', () => {
    const { ref, write } = reference('plain')
    const source = { hot: ref }
    const target = plainConfig(source)
    const listeners: Record<string, () => void> = {}
    const registered = followVolatileUpdates(
      { on: (name: string, listener: () => void) => { listeners[name] = listener } },
      target,
      source,
    )
    expect(registered).toBe(true)
    expect(Object.keys(listeners)).toEqual([VOLATILE_UPDATE_EVENT])
    write('sections')
    expect(target.hot).toBe('plain')
    listeners[VOLATILE_UPDATE_EVENT]()
    expect(target.hot).toBe('sections')
  })

  it('reports false on a context with no event API', () => {
    // The service calls this from its constructor, so it must never throw there.
    expect(followVolatileUpdates({}, {}, {})).toBe(false)
    expect(followVolatileUpdates(undefined, {}, {})).toBe(false)
  })

  it('returns false rather than throwing when `on` is not a function', () => {
    expect(followVolatileUpdates({ on: 42 }, {}, {})).toBe(false)
  })
})
