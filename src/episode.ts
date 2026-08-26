/**
 * Episode logging: lightweight behavior collection for the
 * auto-iteration system. Each optimization call records an Episode
 * with input metadata, cost, quality signals, and acceptance feedback.
 *
 * Pure functions + a bounded circular buffer — no harness dependency,
 * unit-testable standalone. Since 1.8.1 the log is persisted by
 * `persistence.ts` (privacy-cropped, `persistState` on by default);
 * with persistence off it stays in-memory and clears on plugin reload.
 *
 * @module episode
 */

import type { TaskType } from './meta.js'

/** One optimization episode — a single call's footprint. */
export interface Episode {
  /** Timestamp (ms since epoch). */
  ts: number
  /** Original instruction (truncated to maxInputChars for storage). */
  input: string
  /** Detected task type. */
  taskType: TaskType
  /** Detected subtype (e.g. 'writing-report', 'code-bugfix'). */
  subtype?: string
  /** Whether the result came from the local zero-token template path. */
  local: boolean
  /** Whether the local render was refined by a cheap LLM call. */
  refined: boolean
  /** Estimated output tokens. */
  outputTokens: number
  /** Estimated input tokens (system + instruction). */
  inputTokens: number
  /** Wall-clock duration (ms). */
  durationMs: number
  /** Number of model calls made. */
  callCount: number
  /** Quality score inferred from user behavior (0–1, undefined until feedback arrives). */
  quality?: number
  /** Whether the user accepted the result (true=used, false=edited/rejected, undefined=pending). */
  accepted?: boolean
  /** The optimization profile used ('balanced' | 'fast'). */
  profile: string
  /** The local template mode used ('on' | 'off' | 'hybrid'). */
  localMode: string
}

/**
 * Privacy-cropped episode for persistence (1.8.1): the raw instruction text
 * is stripped — the preference model only consumes behavioral metadata, so
 * learning is unaffected while no user content lands on disk.
 */
export type CroppedEpisode = Omit<Episode, 'input'>

/** Circular buffer of recent episodes (most recent at the end). */
export class EpisodeLog {
  private readonly episodes: Episode[] = []
  private readonly maxEntries: number

  constructor(maxEntries = 200) {
    this.maxEntries = Math.max(1, maxEntries)
  }

  /** Rebuild a log from persisted (cropped) episodes, oldest→newest. */
  static from(cropped: readonly CroppedEpisode[], maxEntries = 200): EpisodeLog {
    const log = new EpisodeLog(maxEntries)
    for (const ep of cropped) {
      log.push({ input: '', ...ep } as Episode)
    }
    return log
  }

  /** Record a new episode. Evicts the oldest when at capacity. */
  push(episode: Episode): void {
    this.episodes.push(episode)
    if (this.episodes.length > this.maxEntries) {
      this.episodes.shift()
    }
  }

  /** Return all episodes (copy, safe to mutate). */
  all(): readonly Episode[] {
    return this.episodes.slice()
  }

  /** Return the N most recent episodes. */
  recent(n: number): readonly Episode[] {
    return this.episodes.slice(-Math.min(n, this.episodes.length))
  }

  /** Total episodes logged. */
  get size(): number {
    return this.episodes.length
  }

  /** Clear all episodes. */
  clear(): void {
    this.episodes.length = 0
  }

  /** Find episodes matching a predicate. */
  filter(predicate: (ep: Episode) => boolean): readonly Episode[] {
    return this.episodes.filter(predicate)
  }

  /** Update an episode's quality/accepted fields by index. */
  updateFeedback(index: number, feedback: { quality?: number; accepted?: boolean }): void {
    const ep = this.episodes[index]
    if (ep === undefined) return
    if (feedback.quality !== undefined) ep.quality = feedback.quality
    if (feedback.accepted !== undefined) ep.accepted = feedback.accepted
  }
}

/** Maximum input characters stored per episode (to avoid unbounded memory). */
export const EPISODE_INPUT_MAX_CHARS = 200

/** Truncate input for episode storage. */
export function truncateEpisodeInput(input: string): string {
  if (input.length <= EPISODE_INPUT_MAX_CHARS) return input
  return input.slice(0, EPISODE_INPUT_MAX_CHARS) + '…'
}
