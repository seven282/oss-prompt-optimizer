/**
 * State persistence for the auto-iteration system (1.8.1).
 *
 * Persists run statistics, the episode log (privacy-cropped), and recent
 * events to a single JSON file under the harness home
 * (`~/.dsh/oss-prompt-optimizer/state.json` by default, `stateFile` to
 * override). Loading is best-effort: a missing or corrupt file yields an
 * empty state without throwing. Writes are atomic (tmp file + rename) and
 * debounced by the caller; `flushSync` covers plugin disposal.
 *
 * Pure helpers (`serializeState`/`parseState`/`cropEpisodes`/`cropEvents`)
 * are harness-independent and unit-testable standalone.
 *
 * @module persistence
 */
import type { CroppedEpisode, Episode } from './episode.js';
import type { StatusEvent } from './status.js';
import type { OptimizeStats } from './optimizer.js';
import type { EvalRun } from './eval.js';
/** Schema version — bump when the on-disk shape changes (old files ignored). */
export declare const PERSIST_VERSION = 1;
/** Upper bound on persisted episodes. */
export declare const PERSIST_EPISODE_MAX = 200;
/** Upper bound on persisted recent events. */
export declare const PERSIST_EVENT_MAX = 20;
/**
 * Upper bound on persisted evaluation runs (1.11.0).
 *
 * The field was ADDED to version 1 rather than bumping the version: an older
 * file simply lacks it (defaulting to `[]`), and discarding a user's episodes
 * and statistics to store eval history would be a bad trade. `parseState`
 * validates the new field shape independently, so a file from a build without
 * the evaluation harness loads exactly as before.
 */
export declare const PERSIST_EVAL_RUN_MAX = 10;
/** Full persisted state document. */
export interface PersistData {
    version: typeof PERSIST_VERSION;
    updatedAt: number;
    stats: OptimizeStats;
    episodes: CroppedEpisode[];
    events: StatusEvent[];
    /** Evaluation runs, oldest first (1.11.0). */
    evalRuns: EvalRun[];
    /** The recorded baseline run, or `null` (1.11.0). */
    evalBaseline: EvalRun | null;
}
/** Serialize a state document to the on-disk JSON string. */
export declare function serializeState(data: PersistData): string;
/** Parse a state document; returns null for missing/corrupt/mismatched data. */
export declare function parseState(text: string): PersistData | null;
/** Crop episodes: strip the instruction text (privacy), keep the newest N. */
export declare function cropEpisodes(episodes: readonly Episode[], max?: number): CroppedEpisode[];
/** Crop recent events to the newest N. */
export declare function cropEvents(events: readonly StatusEvent[], max?: number): StatusEvent[];
/**
 * File-backed persistence. `loadSync` is called once at construction;
 * `save` is debounced by the caller; `flushSync` is the disposal fallback.
 */
export declare class FilePersistence {
    private readonly filePath;
    constructor(filePath: string);
    /** Read and parse the state file; null when missing or corrupt. */
    loadSync(): PersistData | null;
    /** Write atomically (tmp file + rename) so a crash never leaves a half file. */
    save(data: PersistData): boolean;
    /** Disposal-time flush: the same synchronous write. */
    flush(data: PersistData): boolean;
}
/**
 * Persistence adapter contract: load once at startup, save debounced,
 * flush at disposal. The noop adapter restores the pre-1.8.1 in-memory
 * behavior (persistState: false).
 */
export interface PersistAdapter {
    loadSync(): PersistData | null;
    save(data: PersistData): boolean;
    flush(data: PersistData): boolean;
}
/**
 * Resolve the harness home, mirroring `dsh-home-paths.resolveDshHome()`
 * (`$DSH_HOME` wins, then `~/.dsh`) without adding a dependency.
 */
export declare function resolveStateDir(configuredStateFile?: string): string | null;
/** Create the adapter; `persistState: false` yields the noop adapter. */
export declare function createPersistence(persistState: boolean, stateFile?: string): PersistAdapter;
