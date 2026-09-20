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
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
/** Schema version — bump when the on-disk shape changes (old files ignored). */
export const PERSIST_VERSION = 1;
/** Upper bound on persisted episodes. */
export const PERSIST_EPISODE_MAX = 200;
/** Upper bound on persisted recent events. */
export const PERSIST_EVENT_MAX = 20;
/** Serialize a state document to the on-disk JSON string. */
export function serializeState(data) {
    return JSON.stringify(data, null, 2);
}
/** Parse a state document; returns null for missing/corrupt/mismatched data. */
export function parseState(text) {
    try {
        const raw = JSON.parse(text);
        if (!raw || typeof raw !== 'object')
            return null;
        if (raw.version !== PERSIST_VERSION)
            return null;
        if (!raw.stats || typeof raw.stats !== 'object')
            return null;
        if (!Array.isArray(raw.episodes))
            return null;
        if (!Array.isArray(raw.events))
            return null;
        return {
            version: PERSIST_VERSION,
            updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
            stats: raw.stats,
            episodes: raw.episodes,
            events: raw.events,
        };
    }
    catch {
        return null;
    }
}
/** Crop episodes: strip the instruction text (privacy), keep the newest N. */
export function cropEpisodes(episodes, max = PERSIST_EPISODE_MAX) {
    return episodes.slice(-max).map((ep) => {
        const { input: _input, ...rest } = ep;
        return rest;
    });
}
/** Crop recent events to the newest N. */
export function cropEvents(events, max = PERSIST_EVENT_MAX) {
    return events.slice(-max);
}
/**
 * File-backed persistence. `loadSync` is called once at construction;
 * `save` is debounced by the caller; `flushSync` is the disposal fallback.
 */
export class FilePersistence {
    filePath;
    constructor(filePath) {
        this.filePath = filePath;
    }
    /** Read and parse the state file; null when missing or corrupt. */
    loadSync() {
        try {
            if (!existsSync(this.filePath))
                return null;
            const text = readFileSync(this.filePath, 'utf8');
            return parseState(text);
        }
        catch {
            return null;
        }
    }
    /** Write atomically (tmp file + rename) so a crash never leaves a half file. */
    save(data) {
        try {
            mkdirSync(dirname(this.filePath), { recursive: true });
            const tmp = `${this.filePath}.tmp`;
            writeFileSync(tmp, serializeState(data), 'utf8');
            renameSync(tmp, this.filePath);
            return true;
        }
        catch (err) {
            console.warn('prompt-optimizer: state persistence failed', err);
            return false;
        }
    }
    /** Disposal-time flush: the same synchronous write. */
    flush(data) {
        return this.save(data);
    }
}
const noopAdapter = {
    loadSync: () => null,
    save: () => true,
    flush: () => true,
};
/**
 * Resolve the harness home, mirroring `dsh-home-paths.resolveDshHome()`
 * (`$DSH_HOME` wins, then `~/.dsh`) without adding a dependency.
 */
export function resolveStateDir(configuredStateFile) {
    if (configuredStateFile !== undefined && configuredStateFile.trim().length > 0) {
        return configuredStateFile.trim();
    }
    const env = process.env.DSH_HOME;
    const home = env !== undefined && env.trim().length > 0 ? env.trim() : join(homedir(), '.dsh');
    return join(home, 'oss-prompt-optimizer', 'state.json');
}
/** Create the adapter; `persistState: false` yields the noop adapter. */
export function createPersistence(persistState, stateFile) {
    if (!persistState)
        return noopAdapter;
    const filePath = resolveStateDir(stateFile);
    if (filePath === null)
        return noopAdapter;
    return new FilePersistence(filePath);
}
