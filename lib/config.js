import z from '@deepseek-ai/schemastery';
// 1.8.2: MAX_TIMER_DELAY_MS used to come from `@deepseek-ai/dsh-timeout` as a
// static import — a host peer whose export list can change at any rc release.
// Owning the constant here keeps the config schema loadable on any host.
import { MAX_TIMER_DELAY_MS } from './compat/timing.js';
/**
 * Fields the settings panel can change **without restarting the plugin**.
 *
 * These — and only these — are declared `volatile()` in the schema below. The
 * loader turns each one into a live reference, commits an edit to it in place
 * (`updateVolatile`), and emits `loader/volatile-update`; the plugin then
 * refreshes its plain-value copy (`live-config.ts`).
 *
 * ⭐ Two properties are required of a key on this list, and both are checked by
 * tests rather than by the type system:
 *
 * 1. **The panel needs at least one of them.** dsh-settings projects a Config
 *    schema through `volatileForm()`; a schema with no volatile node yields no
 *    form at all, the namespace never reaches `configForms.describe()`, and the
 *    client form sits at `unavailable` forever. Without a volatile field there
 *    is no editable panel, whatever the client does.
 * 2. **The field must be read per use, never cached at construction.** Anything
 *    resolved once in the constructor (`templates`, the cache's capacity, the
 *    persistence adapter, the judge rubric) cannot change in place: marking such
 *    a field volatile would let the panel report a successful save while the
 *    running service kept the old behaviour — the exact failure this list has to
 *    avoid.
 *
 * The list mirrors the client's `PO_FIELDS` (the core switches on the plugin's
 * own settings page); `tests/client-apply.test.ts` asserts the two stay aligned.
 */
export const LIVE_CONFIG_KEYS = [
    'outputStyle',
    'situationProfileLevel',
    'contextAware',
    'cacheEnabled',
    'optimizationProfile',
    'localTemplate',
    'autoOptimize',
    'autoAdapt',
];
/**
 * Loader schema: validates configuration and fills defaults at plugin load.
 * Invalid configuration fails the load loudly (harness convention).
 *
 * ⚠️ Two shapes meet here; the `as unknown as` at the end of the literal is the
 * seam between them, not a silenced mismatch:
 *
 *  - **Runtime** — eight keys carry `volatile()`, so schemastery hands the
 *    loader cosmokit *references* (`{ get(), [Symbol.for('cosmokit.volatile.write')] }`)
 *    for them rather than values. `adoptLiveConfig()` (`live-config.ts`) reads
 *    those references into a plain `Config` before the plugin ever touches them.
 *  - **Published types** — `Config` stays the plain-value shape, so
 *    `@deepseek-ai/cosmokit` never becomes part of this package's public surface
 *    for every consumer.
 *
 * schemastery types the schema faithfully (volatile fields *are* references),
 * so a plain output type can no longer be inferred. `tests/config.test.ts`
 * pins both halves: the volatile set matches `LIVE_CONFIG_KEYS`, and the
 * remaining keys really are plain values.
 */
export const Config = z.object({
    temperature: z.number().min(0).max(2).default(0.2),
    maxTokens: z.number().step(1).min(1).max(128000).default(1200),
    maxRetries: z.number().step(1).min(0).max(5).default(1),
    maxCalls: z.number().step(1).min(1).max(20).default(4),
    maxInputChars: z.number().step(1).min(1).max(100000).default(4000),
    maxInputTokens: z.number().step(1).min(0).max(200000).default(3000),
    timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(60000),
    outputLanguage: z.string().default('auto'),
    // ---- live fields (see LIVE_CONFIG_KEYS) -------------------------------
    outputStyle: z.union(['sections', 'plain', 'role-task-goal']).default('plain').volatile(),
    metaPromptLanguage: z.union(['auto', '中文', '英文']).default('auto'),
    autoOptimize: z.boolean().default(true).volatile(),
    autoOptimizePrefix: z.string().default('/optimize '),
    extraInstructions: z.string(),
    examples: z.array(z.object({
        input: z.string().required(),
        output: z.string().required(),
    })),
    minSectionChars: z.number().step(1).min(0).max(10000).default(10),
    maxTokenRetryFactor: z.number().min(1).max(3).default(1.5),
    maxTokensCap: z.number().step(1).min(1).max(128000).default(8000),
    maxTotalTokens: z.number().step(1).min(0).default(20000),
    retryTemperatureStep: z.number().min(0).max(2).default(0.3),
    skipIfAlreadyOptimized: z.boolean().default(true),
    selfRefine: z.boolean().default(false),
    autoOptimizeAll: z.boolean().default(false),
    hookIncludeOriginal: z.boolean().default(false),
    cacheEnabled: z.boolean().default(true).volatile(),
    cacheMaxEntries: z.number().step(1).min(0).max(10000).default(200),
    cacheTtlMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(600000),
    cacheFuzzyMatch: z.boolean().default(true),
    cacheFuzzyThreshold: z.number().min(0).max(1).default(0.6),
    senseNeeds: z.boolean().default(false),
    contextAware: z.boolean().default(true).volatile(),
    contextMaxMessages: z.number().step(1).min(0).max(100).default(10),
    contextMaxTokens: z.number().step(1).min(0).max(200000).default(800),
    outputLengthMaxTokens: z.number().step(1).min(0).max(200000).default(800),
    situationProfileLevel: z.union(['off', 'minimal', 'full']).default('full').volatile(),
    goalAlignmentRetry: z.boolean().default(true),
    optimizationProfile: z.union(['balanced', 'fast']).default('balanced').volatile(),
    earlyStop: z.boolean().default(false),
    builtinExamples: z.boolean().default(true),
    sceneRefEnabled: z.boolean().default(true),
    classifier: z.union(['heuristic', 'llm']).default('heuristic'),
    localTemplate: z.union(['on', 'off', 'hybrid']).default('off').volatile(),
    hybridAlignThreshold: z.number().min(0).max(1).default(0.4),
    templateId: z.string().default('default'),
    metaPromptTemplate: z.object({
        optimizeZh: z.string(),
        optimizeEn: z.string(),
        iterateZh: z.string(),
        iterateEn: z.string(),
    }),
    provider: z.string(),
    model: z.string(),
    earlyStopTailChunks: z.number().step(1).min(1).max(100).default(16),
    earlyStopTailGrowth: z.number().step(1).min(1).max(200).default(24),
    autoAdapt: z.boolean().default(true).volatile(),
    minAdaptEpisodes: z.number().step(1).min(5).max(100).default(10),
    persistState: z.boolean().default(true),
    stateFile: z.string().required(false),
    evalThreshold: z.number().min(0).max(1).default(0.6),
    evalRegressionTolerance: z.number().min(0).max(1).default(0.02),
    evalMaxCases: z.number().step(1).min(0).max(200).default(8),
    evalJudge: z.boolean().default(true),
    evalJudgeProvider: z.string(),
    evalJudgeModel: z.string(),
    evalMineSessions: z.boolean().default(false),
    evalMineLimit: z.number().step(1).min(0).max(50).default(5),
    evalSet: z.array(z.object({
        id: z.string(),
        instruction: z.string().required(),
        dimensions: z.array(z.string()),
        mustInclude: z.array(z.string()),
        mustNotInclude: z.array(z.string()),
        injection: z.boolean(),
    })),
    evalRubric: z.array(z.object({
        id: z.string().required(),
        weight: z.number().min(0).max(1),
        enabled: z.boolean(),
    })),
    selectCandidates: z.number().step(1).min(1).max(5).default(1),
    selectMinGain: z.number().min(0).max(1).default(0.05),
    selectJudge: z.boolean().default(true),
    feedbackAdapt: z.boolean().default(true),
    feedbackScanLimit: z.number().step(1).min(1).max(32).default(8),
});
