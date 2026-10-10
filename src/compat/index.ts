/**
 * Compatibility layer: everything that lets this plugin survive a harness
 * upgrade without taking `dsh web` down with it.
 *
 * Two rules, enforced by `scripts/preflight.mjs` and
 * `tests/policy-static-imports.test.ts`:
 *
 *   R1  `src/**` may statically import only (a) packages declared in this
 *       package's own `dependencies` and (b) `@deepseek-ai/cordis`.
 *   R2  Every other host package goes through {@link loadHostPackage} /
 *       {@link resolveExport}, which return `null` rather than throwing.
 *
 * @module compat
 * @see docs/compatibility.md §2
 */

export { deepFreeze, isFrozen } from './freeze.js'
export { deadline, MAX_TIMER_DELAY_MS, TimeoutReason, timeoutOf, type Deadline } from './timing.js'
export { loadHostPackage, resetHostPackageCache, resolveConstructor, resolveExport, type ExportKind } from './loader.js'
export {
  CAPABILITY_SOURCES,
  DEGRADATION_NOTES,
  describeDegradations,
  formatCapabilitySummary,
  formatCompatReport,
  probeCapabilities,
  type Capabilities,
  type CreateUserMessageFn,
  type DefineToolFn,
  type Degradation,
  type StreamAssembler,
  type StreamAssemblerCtor,
} from './capability.js'
export { scopedInject } from './scope.js'
