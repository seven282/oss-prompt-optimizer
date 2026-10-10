import { Config } from '../config.js';
import { DEFAULT_TEMPLATES, validateTemplateSet } from '../templates.js';
/** Defensive copy of one evaluation run, including its nested results. */
export function cloneEvalRun(run) {
    return {
        ...run,
        perDimension: { ...run.perDimension },
        results: run.results.map((result) => ({
            ...result,
            deterministic: {
                ...result.deterministic,
                missingRequired: [...result.deterministic.missingRequired],
                leaked: [...result.deterministic.leaked],
            },
            ...(result.judge !== undefined
                ? {
                    judge: {
                        ...result.judge,
                        scores: result.judge.scores.map((score) => ({ ...score })),
                        missing: [...result.judge.missing],
                        fabricated: [...result.judge.fabricated],
                    },
                }
                : {}),
        })),
    };
}
/** Defensive copy of a result before it enters or leaves the cache, so a
 *  caller's mutation can never corrupt stored entries (nested sections too). */
export function cloneOptimizeResult(result) {
    return {
        ...result,
        ...(result.sections !== undefined ? { sections: result.sections.map((s) => ({ ...s })) } : {}),
    };
}
/**
 * 造梦模式 (阶段 2A) system block: appended to the meta-prompt when
 * `senseNeeds` is on. It relaxes the strict "output only the prompt" rule for
 * this call and asks for a clearly marked inference appendix AFTER the
 * prompt — deep goal, implicit constraints, quality criteria, likely
 * follow-ups — each labeled as inference, never mixed into the prompt body.
 */
export function senseNeedsBlock(metaLanguage) {
    return metaLanguage === 'en'
        ? `\n\nNeeds sensing (dream mode): after completing the optimized prompt, append a clearly marked appendix at the end:\n\n--- Extended insights (AI-inferred, optional, NOT facts) ---\n· Deep goal: infer the result the user really wants to achieve\n· Implicit constraints: infer unstated limits and prerequisites\n· Quality criteria: infer the expected quality of the result\n· Likely follow-ups: infer what the user may ask next\n\nRules: separate the appendix with \`---\` and place it after the prompt; label every inference as inference and never mix it into the prompt body above; if the instruction is already clear enough and there is nothing new to infer, omit the appendix.`
        : `\n\n需求感应（造梦模式）：完成优化提示词后，在末尾追加一段明确标注的附录：\n\n--- 延伸洞察（AI 推断，供你选用，非事实）---\n· 深层目标：推断用户真正想达成的结果\n· 隐含约束：推断未明说的限制与前提\n· 质量标准：推断期望的完成质量\n· 可能的后续：推断下一步可能的需求\n\n规则：附录用 \`---\` 分隔、位于提示词之后；每条推断必须标注为推断，不得混入上方提示词正文；若指令已足够明确、无新的洞察，可省略附录。`;
}
/**
 * Complete set of accepted config keys; anything else fails the load loudly.
 * D-1 修复（1.5.3）：直接从 Config schema 推导（`Config.dict` 暴露全部字段）——
 * 消除白名单与 schema 的双份维护（1.4.6 曾因漏注册导致 114 个测试失败）。
 */
const CONFIG_KEYS = new Set(Object.keys(Config.dict ?? {}));
/** Reject unknown config keys (a typo is a loud load failure, harness convention). */
export function assertConfigKeys(config) {
    for (const key of Object.keys(config)) {
        if (!CONFIG_KEYS.has(key))
            throw new Error(`prompt-optimizer: unknown config key "${key}"`);
    }
}
/**
 * Resolve the role-document template set from the config: only `'default'`
 * is built-in, and a custom `metaPromptTemplate` (partial sets fall back to
 * the built-ins per language) must pass `validateTemplateSet` — a violation
 * fails the plugin load loudly.
 */
export function resolveTemplates(config) {
    if (config.templateId !== 'default') {
        throw new Error(`prompt-optimizer: unknown templateId "${config.templateId}" (only "default" is built-in)`);
    }
    const custom = config.metaPromptTemplate;
    if (custom === undefined)
        return DEFAULT_TEMPLATES;
    const merged = {
        optimizeZh: custom.optimizeZh ?? DEFAULT_TEMPLATES.optimizeZh,
        optimizeEn: custom.optimizeEn ?? DEFAULT_TEMPLATES.optimizeEn,
        iterateZh: custom.iterateZh ?? DEFAULT_TEMPLATES.iterateZh,
        iterateEn: custom.iterateEn ?? DEFAULT_TEMPLATES.iterateEn,
    };
    validateTemplateSet(merged);
    return merged;
}
