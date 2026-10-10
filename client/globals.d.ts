/**
 * Ambient globals of the dsh web client runtime — provided by the host page,
 * typed nowhere in the dependency tree.
 */

declare interface Window {
  /** ModuleLoader boot API: the host calls `load({ id, factory })` per plugin. */
  __ModuleLoader__: { load(spec: unknown): void }
}
