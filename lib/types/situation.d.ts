/**
 * Situation-awareness layer: pure, harness-free extraction of a structured
 * 角色/任务/目标 (role / task / goal) profile from a raw instruction, plus a
 * goal-alignment check for the validation loop and goal-drift detection for
 * iteration.
 *
 * Everything here is a pure function over plain strings — no harness
 * dependency, no `llm`, no config. P0 delivered explicit-role extraction,
 * goal/constraint extraction, `goalAlignment`, and the `{{情境画像}}` block
 * renderer. P1 added two-level task classification (`detectTaskSubtype`),
 * measurability detection, `goalDrift`, profile memoization, and
 * conversation-role fallback via `context`. P2 adds profile schema
 * versioning (`SITUATION_PROFILE_VERSION`), the injection-budget gate
 * (`SituationProfileLevel`), and session-goal merging (`mergeGoals`, used by
 * the service's session registry). P1 (role-design 方案) extends the role
 * extraction with capability (精通/擅长/Proficient in…) and behavior
 * (先给…/拒绝…/avoid…) signals plus scene-style identities (以…的身份 /
 * acting as…) — `RoleProfile` v2. The `mainVerb` / `object` /
 * `successCriteria` fields are declared for interface stability.
 */
import { type TaskType } from './meta.js';
/** Perceived role of the executor derived from the instruction. */
export interface RoleProfile {
    /** Explicit role clause extracted verbatim (e.g. "你是一名资深产品经理"). */
    explicit?: string;
    /** Role archetype suggested by the detected task category. */
    archetype?: TaskType;
    /** Perceived expertise marker (e.g. 资深 / senior / 10 年经验). */
    expertise?: string;
    /** Capability clause extracted verbatim (精通/擅长/Proficient in…, P1). */
    capability?: string;
    /** Behavior rule clause extracted verbatim (先给…/拒绝…/avoid…, P1). */
    behavior?: string;
    /** Perceived target audience (e.g. 产品经理 / C-level). */
    audience?: string;
    /** Perceived tone (e.g. 正式 / 口语化). */
    tone?: string;
    /**
     * Confidence score 0–8: 2 for an explicit role clause, 2 each for
     * capability and behavior clauses, 1 each for archetype (non-`other`),
     * expertise, audience and tone signals. Content-level signals
     * (capability / behavior) outweigh soft ones so a bare capability clause
     * can pass the injection gate on its own (P1).
     */
    confidence: number;
}
/** Perceived task shape. P0 fills only `type`; the rest arrive in P1. */
export interface TaskProfile {
    /** Coarse task category (see `detectTaskType`). */
    type: TaskType;
    /** Two-level subcategory (globally unique key, see `detectTaskSubtype`). */
    subtype?: TaskSubtype;
    /** Main action verb (P1). */
    mainVerb?: string;
    /** Action object (P1). */
    object?: string;
    /** Whether the instruction carries measurable signals (deadline/quantity). */
    measurable?: boolean;
}
/** Perceived goal: what the user wants, and what must not be violated. */
export interface GoalProfile {
    /** Explicit goal sentence (目标是/目的是/希望…). */
    primary?: string;
    /** Constraint clauses (必须/不要/不超过/至少…). */
    constraints: string[];
    /** Measurable acceptance criteria (P1). */
    successCriteria: string[];
}
/** The combined situation profile. */
export interface SituationProfile {
    /** Schema version (see `SITUATION_PROFILE_VERSION`); consumers can react to shape changes. */
    version: number;
    role: RoleProfile;
    task: TaskProfile;
    goal: GoalProfile;
}
/** Current `SituationProfile` schema version (P2: 画像版本化对外公开; P1: v2 增 capability/behavior). */
export declare const SITUATION_PROFILE_VERSION = 2;
/** How much of the situation profile the role document injects (P2 config). */
export type SituationProfileLevel = 'off' | 'minimal' | 'full';
/**
 * Replaceable task classifier (ADR-011, step 1-2, 1.5.0). The interface lives
 * in the pure-function layer; the default `heuristicClassifier` wraps the
 * existing `detectTaskType` / `detectTaskSubtype` / `extractMainVerbObject`
 * heuristics. An optional LLM implementation (step 3) lives in the service
 * layer and is injected via `classifier: 'llm'` — the pure-function layer
 * never depends on the harness.
 */
export interface ClassifiedTask {
    type: TaskType;
    subtype?: TaskSubtype;
    /** 0–1 confidence; the caller decides the injection gate. */
    confidence: number;
}
/** Sync pure-function classifier contract (heuristic by default). */
export interface TaskClassifier {
    classify(input: string, context?: string): ClassifiedTask;
}
/** Default classifier: wraps the existing keyword/regex heuristics. */
export declare const heuristicClassifier: TaskClassifier;
/**
 * Merge a previously registered session goal into the current instruction's
 * goal (P2 会话级目标注册表). Fallback semantics — the current instruction
 * wins whenever it states something: its primary replaces the registry's,
 * and a non-empty constraint list replaces the registry's. This keeps goals
 * alive across turns without resurrecting constraints the user has moved on
 * from. Pure function.
 */
export declare function mergeGoals(registry: GoalProfile, current: GoalProfile): GoalProfile;
/** Role archetype label per task category (used by the block renderer). */
export declare function archetypeLabel(type: TaskType, en: boolean): string | undefined;
/** Two-level subcategory keys (globally unique, prefixed by task category). */
export type TaskSubtype = 'code-bugfix' | 'code-feature' | 'code-refactor' | 'code-review' | 'code-script' | 'writing-report' | 'writing-email' | 'writing-copy' | 'writing-translate' | 'writing-creative' | 'writing-polish' | 'writing-resume' | 'writing-speech' | 'writing-presentation' | 'analysis-data' | 'analysis-research' | 'analysis-review' | 'analysis-forecast' | 'ops-deploy' | 'ops-install' | 'ops-troubleshoot' | 'ops-maintain';
/**
 * Normalize an instruction for matching: full-width → half-width, lowercase,
 * collapse whitespace. Pure (1.4.8, stage-1 heuristic enhancement).
 */
export declare function normalizeInstruction(input: string): string;
/**
 * Conservatively extract the main verb + object of an instruction (P1
 * reserved fields `mainVerb`/`object`). Returns `undefined` unless a known
 * verb directly follows an optional polite prefix — low-confidence inputs
 * stay empty so the injection gate never fires on noise.
 */
export declare function extractMainVerbObject(input: string): {
    verb: string;
    object: string;
} | undefined;
/** Detect the two-level subcategory of an instruction (given its coarse type). */
export declare function detectTaskSubtype(input: string, type: TaskType): TaskSubtype | undefined;
/** Human label for a subcategory key. */
export declare function subtypeLabel(key: TaskSubtype, en: boolean): string;
/** Keywords of a subcategory (scene matching, e.g. `/template`, 1.5.1). */
export declare function subtypeKeywords(key: TaskSubtype): readonly string[];
/** Whether the instruction carries measurable signals (quantity/deadline). */
export declare function detectMeasurable(input: string): boolean;
/** The four goal-drift states between two iterations. */
export type GoalDrift = 'unchanged' | 'added' | 'modified' | 'dropped';
/**
 * Compare the goal of the previous round with the new instruction's goal:
 * `'dropped'` when previous anchors were lost, `'added'` when the new
 * instruction introduces anchors the previous round lacked, `'modified'`
 * when the primary text changed without an anchor shift, `'unchanged'`
 * otherwise (including both being empty). Pure function.
 */
export declare function goalDrift(prev: GoalProfile, next: GoalProfile): GoalDrift;
/**
 * Build the situation profile for an instruction. Pure and deterministic,
 * memoized per (input, context) pair. P1: when the instruction carries no
 * explicit role clause, a role clause found in `context` is used as a
 * fallback (conversation role cues, e.g. "你是我的翻译" from an earlier turn).
 */
export declare function buildSituationProfile(input: string, context?: string): SituationProfile;
/**
 * Derive the alignment anchors of one piece of goal text: digit runs plus
 * meaningful tokens (particles split off, stopwords dropped, short tokens
 * rejected). `goalAlignment` is lenient — an anchor set matches when ANY
 * anchor appears in the output.
 */
export declare function goalAnchors(text: string): string[];
/**
 * Check whether the optimized output kept the goal and its constraints.
 * Returns the failed goal/constraint labels; `aligned` is false when the
 * primary goal has anchors and none survive, or when any constraint lost
 * every anchor. Lenient by design (any-anchor matching) so it only flags
 * clear drops — the retry gate is intentionally loose in P0.
 */
export declare function goalAlignment(goal: GoalProfile, output: string): {
    missing: string[];
    aligned: boolean;
};
/**
 * Render the `{{情境画像}}` block for the role document (zh/en). Role
 * signals are only injected above a confidence gate (≥2 — an explicit role
 * clause or two soft signals) to avoid noisy hints from generic inputs; the
 * goal part injects whenever a goal or constraint was found; an optional
 * `drift` line is appended for iteration prompts. The `level` gate (P2,
 * `situationProfileLevel`) controls the injection budget: `'off'` renders
 * nothing, `'minimal'` skips the role signals (goal/constraints/drift only),
 * `'full'` (default) renders everything. Returns `''` when there is nothing
 * to say — the placeholder then renders away.
 */
export declare function renderSituationBlock(profile: SituationProfile, en: boolean, drift?: GoalDrift, level?: SituationProfileLevel): string;
