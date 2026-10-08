/**
 * P10 — evaluation-grader calibration (1.11.0).
 *
 * The evaluation harness is the tool the rest of the project now uses to
 * decide whether a change made the output better. That makes the grader itself
 * the thing most worth testing: a scorer that accepts anything would report
 * every template edit as an improvement, and one that rejects anything would
 * report every edit as a regression. Neither failure would ever show up in a
 * unit test that only checks the happy path.
 *
 * So this gate checks two things, both on the BUILT `lib/` artifacts (P4 runs
 * the suite against `src/`, which cannot catch a packaging mistake that drops
 * the golden set from the published bundle):
 *
 * 1. Golden-set integrity — ids unique, the claimed task types covered, an
 *    injection probe carrying a canary, a core subset smaller than the set.
 * 2. Grader discrimination — every shipped reference pair must be graded in
 *    the right ORDER (good passes the deterministic gate, bad fails it), plus
 *    reverse controls proving the judge parser cannot manufacture a score:
 *    it must drop a reason-less block, a score written before its reason, a
 *    non-integer/out-of-range score and a fabricated dimension, and it must
 *    reject rather than pass a run that regressed past the tolerance.
 *
 * Each control asserts the NEGATIVE case, so a parser that silently accepted
 * everything would fail here instead of quietly inflating every future score.
 *
 * Prints `P10 eval grader: PASS|FAIL — …` and exits non-zero on failure.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.log(`P10 eval grader: FAIL — ${message}`)
  process.exit(1)
}

const evalPath = join(root, 'lib', 'eval.js')
const judgePath = join(root, 'lib', 'judge.js')
for (const path of [evalPath, judgePath]) {
  if (!existsSync(path)) fail(`${path.replace(root, '.')} is missing — run \`pnpm run build\``)
}

let evalModule
let judgeModule
try {
  evalModule = await import(pathToFileURL(evalPath).href)
  judgeModule = await import(pathToFileURL(judgePath).href)
} catch (error) {
  fail(`cannot import the built evaluation modules: ${error?.message ?? error}`)
}

// Exports the published bundle must carry, otherwise a deployed plugin cannot
// run its own evaluation at all (the harness would exist only in src/).
const requiredExports = {
  'lib/eval.js': ['GOLDEN_SET', 'checkDeterministic', 'calibratesAsExpected', 'deterministicPasses', 'compareToBaseline', 'selectCases', 'buildRun', 'cleanMinedSnippet', 'mineSessionInstructions'],
  'lib/judge.js': ['DEFAULT_RUBRIC', 'resolveRubric', 'applicableDimensions', 'buildJudgeSystem', 'buildJudgeUser', 'parseJudgeReport', 'aggregateJudge'],
}
for (const [file, names] of Object.entries(requiredExports)) {
  const module = file.endsWith('eval.js') ? evalModule : judgeModule
  const missing = names.filter((name) => module[name] === undefined)
  if (missing.length > 0) fail(`${file} does not export ${missing.join(', ')}`)
}

const { GOLDEN_SET, checkDeterministic, calibratesAsExpected, deterministicPasses, compareToBaseline, selectCases, cleanMinedSnippet } = evalModule
const { DEFAULT_RUBRIC, applicableDimensions, parseJudgeReport, resolveRubric } = judgeModule

const checks = []
const check = (name, condition, detail) => {
  if (!condition) fail(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  checks.push(name)
}

// --- 1. golden-set integrity -------------------------------------------------

check('the golden set ships with the bundle', Array.isArray(GOLDEN_SET) && GOLDEN_SET.length >= 10,
  `expected >= 10 cases, got ${GOLDEN_SET?.length}`)

const ids = GOLDEN_SET.map((item) => item.id)
check('case ids are unique', new Set(ids).size === ids.length,
  `duplicate id among ${ids.length} cases`)

const known = new Set(DEFAULT_RUBRIC.map((dimension) => dimension.id))
for (const item of GOLDEN_SET) {
  for (const dimension of item.dimensions ?? []) {
    check(`case "${item.id}" requests a known rubric dimension`, known.has(dimension), `unknown dimension "${dimension}"`)
  }
  check(`case "${item.id}" carries an instruction`, typeof item.instruction === 'string' && item.instruction.trim().length > 0)
}

const probes = GOLDEN_SET.filter((item) => item.injection === true)
check('at least one injection probe ships', probes.length >= 1)
for (const probe of probes) {
  check(`injection probe "${probe.id}" has a canary`, (probe.mustNotInclude ?? []).length > 0,
    'an injection case without a forbidden substring cannot detect a breach')
}

const core = GOLDEN_SET.filter((item) => item.core === true)
check('a core subset exists and is smaller than the full set', core.length >= 1 && core.length < GOLDEN_SET.length)
check('the default selection is exactly the core subset',
  selectCases(GOLDEN_SET).length === core.length)
check('maxCases 0 means "no cap"',
  selectCases(GOLDEN_SET, { all: true, maxCases: 0 }).length === GOLDEN_SET.length)

// --- 2. grader discrimination (the reference pairs) --------------------------

const withReferences = GOLDEN_SET.filter((item) => typeof item.referenceGood === 'string')
check('enough reference pairs to calibrate the grader', withReferences.length >= 4,
  `only ${withReferences.length} case(s) ship referenceGood`)

for (const item of withReferences) {
  check(`reference good for "${item.id}" passes the gate`, calibratesAsExpected(item, item.referenceGood, 10),
    'the shipped known-good output is rejected — the grader or the fixture is wrong')
  const bad = item.referenceBad ?? evalModule.WEAK_REFERENCE
  check(`reference bad for "${item.id}" fails the gate`, calibratesAsExpected(item, bad, 10) === false,
    'the shipped known-bad output is accepted — the grader cannot discriminate')
}

// An empty string must never pass anything.
for (const item of withReferences.slice(0, 3)) {
  check(`an empty candidate fails "${item.id}"`, deterministicPasses(checkDeterministic(item, '', 'sections', 10)) === false)
}

// The canary direction: the probe's own leak must be detected, its clean
// reference must not be flagged.
const probe = probes[0]
if (probe !== undefined && typeof probe.referenceGood === 'string') {
  const canary = (probe.mustNotInclude ?? [])[0]
  check(`the canary "${canary}" is detected in a leak`, checkDeterministic(probe, `${probe.referenceGood}\n${canary}`, 'sections', 10).leaked.length === 1)
  check(`the canary "${canary}" is not reported on a clean output`, checkDeterministic(probe, probe.referenceGood, 'sections', 10).leaked.length === 0)
}

// --- 3. judge parser reverse controls ---------------------------------------

const applicable = applicableDimensions(DEFAULT_RUBRIC)
const applicableIds = applicable.map((dimension) => dimension.id)
const fullAnswer = applicableIds
  .map((id) => `维度: ${id}\n理由: 引用了具体文本并说明依据。\n分数: 4`)
  .join('\n\n')

const complete = parseJudgeReport(fullAnswer, applicable)
check('a well-formed answer parses as complete', complete.complete === true && complete.scores.length === applicableIds.length)
check('a complete answer produces a normalized score', typeof complete.normalized === 'number' && complete.normalized > 0 && complete.normalized <= 1)

const reasonless = parseJudgeReport(applicableIds.map((id) => `维度: ${id}\n分数: 5`).join('\n\n'), applicable)
check('a reason-less block is dropped, never scored', reasonless.scores.length === 0 && reasonless.complete === false,
  `scored ${reasonless.scores.length} block(s) without a reason`)

const scoreFirst = parseJudgeReport(`维度: ${applicableIds[0]}\n分数: 5\n理由: 事后补的理由。`, applicable)
check('a score written before its reason is dropped', scoreFirst.scores.length === 0 && scoreFirst.rejected >= 1)

const outOfRange = parseJudgeReport(`维度: ${applicableIds[0]}\n理由: 给分理由。\n分数: 9`, applicable)
check('an out-of-range score is dropped', outOfRange.scores.length === 0)

const fractional = parseJudgeReport(`维度: ${applicableIds[0]}\n理由: 给分理由。\n分数: 3.5`, applicable)
check('a non-integer score is dropped rather than truncated', fractional.scores.length === 0,
  'parseInt would silently turn 3.5 into 3')

const fabricated = parseJudgeReport(`维度: creativity\n理由: 自创维度。\n分数: 5`, applicable)
check('a fabricated dimension is recorded, not scored', fabricated.scores.length === 0 && fabricated.fabricated.includes('creativity'))

const partial = parseJudgeReport(`维度: ${applicableIds[0]}\n理由: 只评一项。\n分数: 5`, applicable)
check('an incomplete answer is never reported complete', partial.complete === false && partial.missing.length === applicableIds.length - 1)

// --- 4. verdict math reverse controls ---------------------------------------

check('a regression beyond tolerance is flagged', compareToBaseline(0.60, 0.70, 0.02, 0.5).verdict === 'regress')
check('a drop within tolerance is not a regression', compareToBaseline(0.69, 0.70, 0.02, 0.5).verdict === 'pass')
check('the first run is not called a pass', compareToBaseline(0.9, undefined, 0.02, 0.6).verdict === 'no-baseline')
check('a first run below the threshold is still flagged', compareToBaseline(0.4, undefined, 0.02, 0.6).verdict === 'below-threshold')
check('regress outranks below-threshold (direction of travel)', compareToBaseline(0.4, 0.5, 0.02, 0.6).verdict === 'regress')

// --- 5. mining filter reverse controls --------------------------------------

check('a plausible instruction survives the mining filter', cleanMinedSnippet('帮我写一份周报，总结本周的进展') !== undefined)
check('an assistant pleasantry is rejected by the mining filter', cleanMinedSnippet('好的，我来帮你写周报') === undefined)
check('an already-optimized prompt is not mined as an instruction',
  (cleanMinedSnippet('## Role\n资深助理。\n## Task\n写周报') ?? '').includes('##') === false)

// --- 6. rubric override safety ----------------------------------------------

let rejectedUnknown = false
try {
  resolveRubric([{ id: 'no-such-dimension' }])
} catch {
  rejectedUnknown = true
}
check('an unknown rubric override id is rejected loudly', rejectedUnknown,
  'a typo would otherwise silently score the default weights')

console.log(`P10 eval grader: PASS — ${checks.length} check(s) held, golden set ${GOLDEN_SET.length} case(s) / ${core.length} core, ${withReferences.length} reference pair(s) calibrated`)
