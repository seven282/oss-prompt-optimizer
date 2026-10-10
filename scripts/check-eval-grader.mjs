/**
 * P10 — evaluation-grader calibration (1.11.0).
 *
 * The grader decides whether a change improved the output: a scorer that accepts
 * anything calls every edit an improvement, one that rejects anything calls every
 * edit a regression, and neither shows up in a happy-path unit test. Both checks
 * read the BUILT `lib/`, which P4 (running `src/`) cannot cover.
 * 1. Golden-set integrity: unique ids, claimed task types covered, an injection
 *    probe carrying a canary, a core subset smaller than the set.
 * 2. Grader discrimination: reference pairs graded in the right ORDER, plus
 *    reverse controls proving the judge parser cannot manufacture a score.
 *
 * Usage: node scripts/check-eval-grader.mjs → 0 PASS, 1 FAIL.
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
const selectPath = join(root, 'lib', 'select.js')
const feedbackPath = join(root, 'lib', 'feedback.js')
for (const path of [evalPath, judgePath, selectPath, feedbackPath]) {
  if (!existsSync(path)) fail(`${path.replace(root, '.')} is missing — run \`pnpm run build\``)
}

let evalModule
let judgeModule
let selectModule
let feedbackModule
try {
  evalModule = await import(pathToFileURL(evalPath).href)
  judgeModule = await import(pathToFileURL(judgePath).href)
  selectModule = await import(pathToFileURL(selectPath).href)
  feedbackModule = await import(pathToFileURL(feedbackPath).href)
} catch (error) {
  fail(`cannot import the built evaluation modules: ${error?.message ?? error}`)
}

// Exports the published bundle must carry, otherwise a deployed plugin cannot
// run its own evaluation at all (the harness would exist only in src/).
const requiredExports = {
  'lib/eval.js': ['GOLDEN_SET', 'checkDeterministic', 'calibratesAsExpected', 'deterministicPasses', 'compareToBaseline', 'selectCases', 'buildRun', 'cleanMinedSnippet', 'mineSessionInstructions'],
  'lib/judge.js': ['DEFAULT_RUBRIC', 'resolveRubric', 'applicableDimensions', 'buildJudgeSystem', 'buildJudgeUser', 'parseJudgeReport', 'aggregateJudge'],
  // 1.12.0: the ranking rules and the feedback counters must ship too — the
  // artifact a deployment installs is `lib/`, so a missing export would leave
  // selection (and the feedback readback) dead on arrival.
  'lib/select.js': ['selectCandidatePure', 'scoreCandidates', 'candidateTemperature', 'structuralScore', 'formatSelection', 'selectionToken'],
  'lib/feedback.js': ['normalizeItem', 'feedbackItems', 'mergeItems', 'feedbackBias', 'formatFeedback', 'feedbackToken'],
}
const modulesByFile = {
  'lib/eval.js': evalModule,
  'lib/judge.js': judgeModule,
  'lib/select.js': selectModule,
  'lib/feedback.js': feedbackModule,
}
for (const [file, names] of Object.entries(requiredExports)) {
  const module = modulesByFile[file]
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
// 1.12.0: `rejected` names the dropped ids and `rejectedCount` counts them —
// the old single number conflated "invented dimension" with "discarded block".
check('a score written before its reason is dropped',
  scoreFirst.scores.length === 0 && scoreFirst.rejectedCount >= 1 && scoreFirst.rejected.includes(applicableIds[0]),
  `rejected=${JSON.stringify(scoreFirst.rejected)} count=${scoreFirst.rejectedCount}`)

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

// --- 7. best-of-N ranking reverse controls (1.12.0) --------------------------
//
// The selector decides which prompt the user actually receives, so its rules
// get the same treatment as the grader's: every control below asserts the
// NEGATIVE case, and the first one is the rule the feature exists to enforce.

const { selectCandidatePure, candidateTemperature } = selectModule
const { normalizeItem, mergeItems, feedbackBias, formatFeedback } = feedbackModule

const PASS_GATE = { passed: true, valid: true, missingRequired: [], leaked: [] }
const FAIL_GATE = { passed: false, valid: false, missingRequired: ['周报'], leaked: [] }
const candidate = (prompt) => ({ source: 'llm', prompt })
const scored = (index, score, gate = PASS_GATE) => ({ index, source: 'llm', chars: 120, gate, score })
const threeCandidates = [candidate('a'), candidate('b'), candidate('c')]

const leaked = selectCandidatePure(threeCandidates, [scored(0, 0.5), scored(1, 0.99, FAIL_GATE), scored(2, 0.6)])
check('a gate-failed candidate cannot win, however it scores', leaked.chosenIndex === 2,
  `chose ${leaked.chosenIndex} (a candidate that failed the gate)`)

const tie = selectCandidatePure(threeCandidates, [scored(0, 0.8), scored(1, 0.8), scored(2, 0.8)])
check('a tie keeps the first candidate (selection cannot make things worse)', tie.chosenIndex === 0 && tie.reason === 'baseline')

const margin = selectCandidatePure(threeCandidates, [scored(0, 0.9), scored(1, 0.91)])
check('a marginal win does not replace the baseline', margin.chosenIndex === 0)

const gain = selectCandidatePure(threeCandidates, [scored(0, 0.5), scored(1, 0.9)])
check('a clear win does replace the baseline', gain.chosenIndex === 1 && gain.reason === 'gain')

const unscored = selectCandidatePure([candidate('a')], [{ index: 0, source: 'llm', chars: 1, gate: PASS_GATE, error: 'judge-incomplete' }])
check('an unscored candidate is reported as unscored, never guessed at 0',
  unscored.score === undefined && unscored.chosenIndex === 0)

check('the candidate ladder keeps the baseline temperature and spreads the rest',
  candidateTemperature(0.2, 0) === 0.2 && candidateTemperature(0.2, 1) > 0.2 && candidateTemperature(1.9, 3) <= 2)

// --- 8. feedback privacy reverse controls (1.12.0) ---------------------------
//
// A feedback note is free text a human typed about an answer. If it ever
// reaches a ledger, a state file or a rendered line, the plugin is storing user
// prose it never intended to keep — so this asserts the ABSENCE of the text
// rather than trusting the code that is supposed to drop it.

const SECRET_NOTE = 'SECRET-NOTE-TEXT-MUST-NEVER-SURVIVE'
const normalized = normalizeItem({ rating: 'negative', category: 'correctness', note: SECRET_NOTE })
check('a feedback item reduces to a rating, a category and a note FLAG',
  normalized?.rating === 'negative' && normalized?.category === 'correctness' && normalized?.withNote === true)
check('the note text never reaches the normalized item', JSON.stringify(normalized).includes(SECRET_NOTE) === false)

const ledger = mergeItems('session-abcdefgh', [{ rating: 'negative', category: 'correctness', note: SECRET_NOTE }])
check('the note text never reaches the ledger', JSON.stringify(ledger).includes(SECRET_NOTE) === false)
check('the note text never reaches the rendered readback', formatFeedback([ledger], 'zh').includes(SECRET_NOTE) === false)
check('the ledger counts the judgment and its category',
  ledger.negative === 1 && ledger.withNote === 1 && ledger.categories.correctness === 1)

const rescanned = mergeItems('session-abcdefgh', [{ rating: 'positive' }])
check('re-reading a session REPLACES its counts instead of accumulating them',
  rescanned.positive === 1 && rescanned.negative === 0)

check('too small a sample produces no temperature bias (a single click is not a trend)',
  feedbackBias({ sessionId: 's', positive: 0, negative: 2, withNote: 0, categories: {}, fetchedAt: 0 }).delta === 0)
check('a negative-heavy session biases upward and says why',
  feedbackBias({ sessionId: 's', positive: 1, negative: 4, withNote: 0, categories: {}, fetchedAt: 0 }).delta > 0)
check('a positive-heavy session biases downward',
  feedbackBias({ sessionId: 's', positive: 4, negative: 1, withNote: 0, categories: {}, fetchedAt: 0 }).delta < 0)

console.log(`P10 eval grader: PASS — ${checks.length} check(s) held, golden set ${GOLDEN_SET.length} case(s) / ${core.length} core, ${withReferences.length} reference pair(s) calibrated`)
