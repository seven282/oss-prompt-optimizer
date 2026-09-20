import type { OptimizeErrorCode as OptimizeErrorCodeType } from './errors.js';
import type { MetaLanguage } from './meta.js';
/**
 * Build corrective feedback for the next retry from the last failed output:
 * which sections were missing / too thin (sections style) or that the body
 * was too short (plain style). Returns `undefined` when there is no
 * actionable structure diagnosis — the retry then keeps the plain
 * temperature bump instead. The text follows the role-document language.
 * Pure function; no harness dependency (unit-testable without `llm`).
 */
export declare function buildDiagnosis(opts: {
    outputStyle: 'sections' | 'plain';
    minSectionChars: number;
    language: MetaLanguage;
    prompt: string;
    failureCode: OptimizeErrorCodeType;
}): string | undefined;
/**
 * The terse-only instruction for a `selfRefine` round (private, not a
 * public template). Follows the role-document language. Pure function.
 */
export declare function refineInstruction(language: MetaLanguage): string;
