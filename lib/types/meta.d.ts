/**
 * The optimizer meta-prompt. The raw instruction is substituted for the
 * `{{原始指令}}` placeholder at call time; the optional language rule replaces
 * `{{语言规则}}` (empty when `outputLanguage` is 'auto'); deployment extras and
 * few-shot examples replace `{{额外要求}}` / `{{示例}}` (empty when absent);
 * the detected task category replaces `{{任务类型}}` (empty when `'other'`);
 * the suggested output-length cap replaces `{{长度预算}}` (empty when disabled);
 * the situation profile replaces `{{情境画像}}` (empty when no usable signals);
 * the output structure paragraph and the pre-output self-check replace
 * `{{输出结构}}` / `{{自查}}` and depend on `outputStyle`; optional
 * conversation context replaces `{{上下文信息}}` (empty when `contextAware`
 * is off). The instruction-is-data rule is the injection guardrail.
 *
 * The role document exists in two languages: `META_PROMPT` (zh) and
 * `META_PROMPT_EN` (en), selected by `buildOptimizePrompt`'s `metaLanguage`
 * argument (mirroring GitHub Docs' per-language content trees). Both keep the
 * same `{{...}}` placeholder tokens so the substitution chain is shared.
 */
/** The language of the role document (the optimizer's system prompt). */
export type MetaLanguage = 'zh' | 'en';
/**
 * Detect the dominant language of a raw instruction: `'zh'` when CJK
 * ideographs make up at least 30% of the non-whitespace characters,
 * `'en'` otherwise. Japanese (kana, even with kanji) and any other
 * language fall back to the English role document — the safe default of
 * the two shipped versions. Pure function.
 */
export declare function detectLanguage(input: string): MetaLanguage;
/**
 * Coarse task categories the optimizer can react to (content-aware roles and
 * format defaults). A pure heuristic: keyword scoring per category, with a
 * fixed tie-break priority `code > analysis > ops > writing` (writing markers
 * like "写" are the most generic and only win on their own). `'other'` when
 * nothing matches — the role document then stays silent on the category.
 */
export type TaskType = 'code' | 'writing' | 'analysis' | 'ops' | 'other';
/**
 * Pick the item whose keyword list scores highest against `lower` (each
 * keyword matched as a case-insensitive substring scores 1). The strictly-
 * greater comparison keeps the FIRST item on ties, so iteration order is the
 * tie-break priority. Returns the winner and its score (score 0 → no winner).
 * Shared by `detectTaskType` (category table) and `detectTaskSubtype`
 * (subcategory tables) — adding a keyword category only edits the table.
 */
export declare function bestScoreByKeywords<T extends {
    keywords: readonly string[];
}>(items: readonly T[], lower: string): {
    item: T | undefined;
    score: number;
};
/** Detect the coarse task category of a raw instruction. Pure function. */
export declare function detectTaskType(input: string): TaskType;
/**
 * Role library (1.4.9): one ready-to-use "identity + capability + behavior"
 * reference per task category. Injected alongside the `{{任务类型}}` hints so
 * the model has a concrete role fallback when the situation profile carries
 * no explicit role (low-confidence cases) — never injected into the profile.
 */
export declare const ROLE_LIBRARY: Record<Exclude<TaskType, 'other'>, {
    zh: string;
    en: string;
}>;
/**
 * Scene-template library (1.5.1): one compact Role/Task/Format skeleton per
 * subcategory. Injected into the `{{任务类型}}` block when the subtype is
 * detected — the model fills in the specifics instead of inventing a shape.
 * Also drives the `/template <scene>` quick command (no model call).
 */
export declare const SUB_TOPIC_TEMPLATES: Record<TaskSubtype, {
    zh: string;
    en: string;
}>;
/**
 * Render a ready-to-fill four-section template for a subcategory (drives the
 * `/template <scene>` quick command — no model call). The scene skeleton is
 * quoted as reference, then a fillable Role/Task/Context/Format skeleton.
 * D-4 修复：占位符与主模板（templates.ts）一致——中英共用中文占位符。
 */
export declare function renderSceneTemplate(subtype: TaskSubtype, en: boolean): string;
/**
 * Match a `/template` query against subcategory keys and their zh/en labels.
 * Returns the best-matching subcategory or `undefined`.
 */
export declare function matchScene(query: string): TaskSubtype | undefined;
import { type TemplateSet } from './templates.js';
import type { PromptExample } from './config.js';
import { type GoalDrift, type SituationProfile, type SituationProfileLevel, type TaskSubtype } from './situation.js';
export { DEFAULT_TEMPLATES, META_ITERATE, META_ITERATE_EN, META_PROMPT, META_PROMPT_EN, validateTemplateSet } from './templates.js';
export type { TemplateSet } from './templates.js';
export declare function isCompactInstruction(input: string): boolean;
/**
 * Fill the raw instruction and optional tuning blocks into the meta-prompt.
 * @param input - the raw instruction to optimize.
 * @param language - `'auto'` or empty keeps the default language rule; any
 *   other non-empty value pins the output language.
 * @param extraInstructions - optional deployment-specific rules; empty/absent
 *   removes the block.
 * @param examples - optional few-shot demonstrations; injected only in the
 *   `'sections'` style (a four-section example would fight the plain-style
 *   no-headings instruction); empty/absent removes the block.
 * @param outputStyle - `'sections'` (default) emits the four section
 *   headings; `'plain'` emits a heading-free continuous prompt.
 * @param metaLanguage - the language of the role document itself: `'zh'`
 *   (default) uses the Chinese system prompt, `'en'` the English one. Both
 *   share the same placeholders and output-structure rules.
 * @param diagnosis - optional diagnosis feedback from a previous failed
 *   attempt (missing / thin sections etc.); injected as a corrective block
 *   before the self-check. Absent on the first attempt.
 * @param templates - the role-document skeleton set to build from; defaults
 *   to the built-in templates (see `templates.ts`).
 * @param context - optional conversation context (background reference only);
 *   injected as the `{{上下文信息}}` block when non-empty.
 * @param taskType - detected task category; `undefined` auto-detects from
 *   `input` and injects the `{{任务类型}}` hint when not `'other'`.
 * @param maxOutputTokens - optional suggested output-length cap (soft
 *   guideline only); `undefined`/`0` injects no `{{长度预算}}` block.
 * @param profile - optional situation profile (role/task/goal); `undefined`
 *   auto-builds it from `input` (and `context`, for role cues) and injects
 *   the `{{情境画像}}` block when it carries usable signals.
 * @param level - optional injection budget for the situation block
 *   (`'off'`/`'minimal'`/`'full'`); `undefined` behaves as `'full'`.
 */
export declare function buildOptimizePrompt(input: string, language?: string, extraInstructions?: string, examples?: readonly PromptExample[], outputStyle?: 'sections' | 'plain' | 'role-task-goal', metaLanguage?: MetaLanguage, diagnosis?: string, templates?: TemplateSet, context?: string, taskType?: TaskType, maxOutputTokens?: number, profile?: SituationProfile, level?: SituationProfileLevel, builtinExamples?: boolean, compact?: boolean, sceneRefEnabled?: boolean): string;
/**
 * Fill a previously optimized prompt and a new requirement into the iteration
 * meta-prompt. Shares the same tuning blocks and `metaLanguage` selection as
 * `buildOptimizePrompt`. The two data slots are substituted in a single pass
 * so neither piece of data can clobber a placeholder-like literal inside the
 * other. Accepts the same trailing `diagnosis` feedback as
 * `buildOptimizePrompt`.
 * @param templates - the role-document skeleton set to build from; defaults
 *   to the built-in templates (see `templates.ts`).
 * @param context - optional conversation context (background reference only);
 *   injected as the `{{上下文信息}}` block when non-empty.
 * @param taskType - detected task category; `undefined` auto-detects from
 *   the iteration instruction and injects the `{{任务类型}}` hint when not
 *   `'other'`.
 * @param maxOutputTokens - optional suggested output-length cap (soft
 *   guideline only); `undefined`/`0` injects no `{{长度预算}}` block.
 * @param profile - optional situation profile (role/task/goal); `undefined`
 *   auto-builds it from the iteration instruction (and `context`, for role
 *   cues) and injects the `{{情境画像}}` block when it carries usable signals.
 * @param drift - optional goal drift vs the previous round; appends a change
 *   line to the situation block for iteration prompts.
 * @param level - optional injection budget for the situation block
 *   (`'off'`/`'minimal'`/`'full'`); `undefined` behaves as `'full'`.
 */
export declare function buildIteratePrompt(lastResult: string, instruction: string, language?: string, extraInstructions?: string, examples?: readonly PromptExample[], outputStyle?: 'sections' | 'plain' | 'role-task-goal', metaLanguage?: MetaLanguage, diagnosis?: string, templates?: TemplateSet, context?: string, taskType?: TaskType, maxOutputTokens?: number, profile?: SituationProfile, drift?: GoalDrift, level?: SituationProfileLevel, builtinExamples?: boolean, compact?: boolean, sceneRefEnabled?: boolean): string;
