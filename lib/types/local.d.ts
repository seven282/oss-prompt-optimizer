/**
 * Local zero-token template renderer (1.5.6, 方案 A).
 *
 * The four perception layers (task / role / situation / context) are pure
 * functions; the only model call in the whole pipeline is the prose
 * generation. For well-structured subcategories the skeleton + extracted
 * signals are enough to produce a usable four-section prompt **locally** —
 * no LLM call, no tokens, ~<5ms. A confidence gate decides when the local
 * render is appropriate; anything else falls back to the LLM pipeline.
 *
 * Pure-function layer: no harness dependency, unit-testable standalone.
 */
import { type SituationProfile } from './situation.js';
import { type MetaLanguage, type TaskType } from './meta.js';
/**
 * Local-render mode. `'off'` disables the local path (LLM only); `'on'` renders
 * unconditionally when the gate passes; `'hybrid'` renders when the gate passes
 * and refines mismatches with a cheap LLM call.
 * `'on'` forces local whenever a subcategory matches; `'off'` never local;
 * `'hybrid'` (1.6.1) renders locally and then checks goal-anchor alignment —
 * aligned results return at zero tokens, misaligned ones go through a cheap
 * LLM refinement (~400-800 tokens vs ~1300-2300 for the full pipeline).
 */
export type LocalTemplateMode = 'on' | 'off' | 'hybrid';
/** Why the gate rejected (`ok === true` → `'pass'`). */
export type LocalGateReason = 'pass' | 'off' | 'other-task' | 'no-subtype' | 'open-creative' | 'no-signal';
/** Whether a local (zero-token) render is appropriate for `input`. */
export interface LocalGateResult {
    ok: boolean;
    reason: LocalGateReason;
    taskType?: TaskType;
    subtype?: string;
}
/**
 * Goal-anchor alignment score 0-1 (1.6.1, P1 `hybrid`): how well the goal /
 * constraint / audience / role anchors are covered by extracted signals. The
 * local render copies these into the result, so a low score means the local
 * result likely misses the user's deep goal and deserves a cheap refinement.
 * Threshold-driven in the optimizer (`hybridAlignThreshold`).
 */
export declare function goalAnchorsScore(profile: SituationProfile): number;
/**
 * Confidence gate: decide whether `input` can be answered with a local
 * template instead of an LLM call.
 * - `mode === 'off'` → never local.
 * - `mode === 'on'` → local whenever a subcategory matches (except
 *   open-ended ones listed above).
 * - `mode === 'hybrid'` → require at least one
 *   extractable signal (role / main-verb+object / goal / measurable /
 *   conversation context) so a bare instruction without usable details
 *   still gets the full LLM treatment.
 * - `mode === 'hybrid'` → same pass rule (usable signal required); the result carries
 *   `confidence` and the caller decides whether to refine locally (1.6.1).
 */
export declare function localTemplateGate(input: string, mode: LocalTemplateMode, context?: string): LocalGateResult;
/**
 * Build the cheap refinement system prompt (1.6.1 `hybrid`, 1.6.2 `auto`):
 * the locally generated reference template (seed) + the original
 * instruction. The model only patches gaps (missing goals/constraints/
 * audience, conflicts) instead of regenerating — input side stays
 * ~300-500 tokens vs ~1000-1500 for the full pipeline. When a `profile` is
 * given, the extracted goal/constraint/audience anchors are injected so the
 * refinement is explicitly goal-aware (1.6.2); an optional `diagnosis`
 * (e.g. goal-misalignment feedback from the previous attempt) is appended
 * for the retry path.
 */
export declare function buildRefinePrompt(localPrompt: string, input: string, en: boolean, profile?: SituationProfile, diagnosis?: string, outputStyle?: 'sections' | 'plain' | 'role-task-goal'): string;
/**
 * Render a plain-text prompt entirely from local signals (zero LLM calls).
 * Only call when `localTemplateGate` returned `ok`.
 *
 * Uses `FILL_RULES` (complete four-element production data) directly —
 * role / task / context / format are finished text fragments ready for output.
 * The `task` template's `{{VO}}` placeholder is replaced with the extracted
 * verb-object from the instruction; if no VO is extracted, the template is
 * used as-is.
 *
 * Explicit signals from the instruction (role / goal / audience) always win
 * over the static FILL_RULES defaults.
 */
export declare function buildLocalTemplate(input: string, subtype: string, metaLanguage?: MetaLanguage, context?: string): string;
