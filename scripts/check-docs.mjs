#!/usr/bin/env node
/**
 * Documentation consistency check — gate P12 (`pnpm check:docs`).
 *
 * Docs drifted because nothing checked them: the two READMEs grew different
 * section orders, the settings screen acquired four names, and renamed constants
 * kept appearing in prose. Each rule below is a machine check for one drift.
 *
 * Checks: heading parity and two-way cross-links for every language pair; local
 * links resolve; every `pnpm <script>` in a tracked doc exists in package.json;
 * retired names; line budgets; no inline version markers in feature prose.
 *
 * Advisory by design: preflight reports WARN, not FAIL — docs cannot keep
 * `dsh web` from booting, so they are not on the blocking path.
 * Usage: node scripts/check-docs.mjs [--json <path>] @module check-docs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const jsonFlag = argv.indexOf('--json')
const jsonPath = jsonFlag === -1 ? null : (argv[jsonFlag + 1] ?? null)

/** Docs a reader is expected to follow links from. */
const DOCS = [
  'README.md',
  'README.en.md',
  'AGENTS.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/configuration.md',
  'docs/configuration.en.md',
  'docs/compatibility.md',
  'docs/compatibility.en.md',
  'docs/subcategory-examples.md',
]

/**
 * Documents that must stay one document in two languages: same headings, in the
 * same order, at the same depth, and cross-linked both ways. Section *titles*
 * differ by construction, so only the level sequence is compared.
 */
const PAIRS = [
  ['README.md', 'README.en.md'],
  ['docs/configuration.md', 'docs/configuration.en.md'],
  ['docs/compatibility.md', 'docs/compatibility.en.md'],
]

/**
 * Docs whose prose must use current names. The CHANGELOG is deliberately
 * excluded: it is append-only and has to be able to say "X was renamed to Y"
 * in the very words this list bans.
 */
const LIVING_DOCS = DOCS.filter((rel) => rel !== 'CHANGELOG.md')

/**
 * Line budget per language; CJK renders at roughly twice the Latin width.
 * `docs/configuration.md` is deliberately absent: it still carries three prose
 * lines above 120 chars, and a budget that cannot be met is noise, not a gate.
 * Adding it is a two-line follow-up once those lines are wrapped.
 */
const WIDTH = {
  'README.md': 120,
  'README.en.md': 100,
  'CONTRIBUTING.md': 120,
  'SECURITY.md': 120,
  'docs/configuration.en.md': 100,
  'docs/compatibility.md': 120,
  'docs/compatibility.en.md': 100,
}

/** Retired names and phrasings that must not come back. */
const BANNED = [
  ['设置 → 插件', '设置面路径统一为「左下角「设置」→ 左侧栏「提示词优化」」'],
  ['设置 → Prompt', '设置面路径统一为「左下角「设置」→ 左侧栏「提示词优化」」'],
  ['Settings → plugin settings', 'the settings path is Settings (bottom left) → Prompt Optimizer'],
  ['Prompt 优化器', '页面名是「提示词优化」（en: Prompt Optimizer）'],
  ['.po-save', 'the class is .po-status-toggle (it toggles the status panel, it does not save)'],
  ['RTG_LABELS_ZH', 'the bare name is the default language: RTG_LABELS / RTG_LABELS_EN'],
  ['STATUS_EVENT_MAX', 'renamed to STATUS_MAX_EVENTS'],
  ['PERSIST_EVENT_MAX', 'renamed to PERSIST_MAX_EVENTS'],
  ['PERSIST_EPISODE_MAX', 'renamed to PERSIST_MAX_EPISODES'],
  ['PERSIST_EVAL_RUN_MAX', 'renamed to PERSIST_MAX_EVAL_RUNS'],
  ['FEEDBACK_SESSION_MAX', 'renamed to FEEDBACK_MAX_SESSIONS'],
]

const issues = []
const note = (file, message) => issues.push({ file, message })
const read = (rel) => readFileSync(join(root, rel), 'utf8')

function headings(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => /^#{1,3} /.test(line))
    .map((line) => line.match(/^#+/)[0].length)
}

/** 1. Each language pair must be the same document, twice. */
function checkHeadingParity() {
  for (const [zh, en] of PAIRS) {
    if (!existsSync(join(root, zh)) || !existsSync(join(root, en))) {
      note(zh, `missing counterpart ${en}`)
      continue
    }
    const a = headings(read(zh))
    const b = headings(read(en))
    if (a.length !== b.length) {
      note(zh, `heading count differs from ${en}: ${a.length} vs ${b.length}`)
      continue
    }
    const firstDiff = a.findIndex((level, i) => level !== b[i])
    if (firstDiff !== -1) {
      note(zh, `heading level at position ${firstDiff + 1} differs from ${en} (h${a[firstDiff]} vs h${b[firstDiff]}) — keep the sections in the same order and depth`)
    }
  }
}

/**
 * 1b. Each pair must point at its counterpart, or an English reader has no route
 * from the translated document back to the source of truth (and vice versa).
 */
function checkPairLinks() {
  for (const [zh, en] of PAIRS) {
    const zhBase = zh.split('/').pop()
    const enBase = en.split('/').pop()
    if (existsSync(join(root, zh)) && !read(zh).includes(enBase)) {
      note(zh, `does not link to its counterpart ${enBase}`)
    }
    if (existsSync(join(root, en)) && !read(en).includes(zhBase)) {
      note(en, `does not link to its counterpart ${zhBase}`)
    }
  }
}

/** 2. Every local link must resolve; anchors and remote URLs are ignored. */
function checkLinks() {
  for (const rel of DOCS) {
    if (!existsSync(join(root, rel))) continue
    const base = dirname(join(root, rel))
    for (const [, target] of read(rel).matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue
      const file = target.split('#')[0]
      if (!file) continue
      const abs = resolve(base, file)
      if (!existsSync(abs)) note(rel, `dead link → ${target}`)
    }
  }
}

/** 3. A documented `pnpm <script>` must exist, or the doc is fiction. */
function checkScriptNames() {
  const scripts = new Set(Object.keys(JSON.parse(read('package.json')).scripts ?? {}))
  const builtin = new Set(['install', 'exec', 'dlx', 'publish', 'add', 'remove', 'why', 'audit', 'store', 'config', 'import', 'update', 'run'])
  for (const rel of DOCS) {
    if (!existsSync(join(root, rel))) continue
    for (const [, name] of read(rel).matchAll(/pnpm (?:run )?([a-z][a-z0-9:-]*)/g)) {
      if (builtin.has(name)) continue
      if (!scripts.has(name)) note(rel, `pnpm ${name} is not a script in package.json`)
    }
  }
}

/** 4. Retired names, retired phrasings — living docs only (see LIVING_DOCS). */
function checkBanned() {
  for (const rel of LIVING_DOCS) {
    if (!existsSync(join(root, rel))) continue
    const text = read(rel)
    for (const [needle, why] of BANNED) {
      if (text.includes(needle)) note(rel, `"${needle}" — ${why}`)
    }
  }
}

/** 5. Line-width budget (prose only; tables, badges, images, code and headings are exempt). */
function checkWidth() {
  for (const [rel, budget] of Object.entries(WIDTH)) {
    if (!existsSync(join(root, rel))) continue
    let fenced = false
    read(rel)
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (/^```/.test(line.trim())) {
          fenced = !fenced
          return
        }
        const t = line.trim()
        if (fenced || t === '' || /^\|/.test(t) || /^\[!\[/.test(t) || /^!\[/.test(t) || /^#{1,6} /.test(line)) return
        if (line.length > budget) note(rel, `line ${i + 1} is ${line.length} chars (budget ${budget})`)
      })
  }
}

/** 6. Version history belongs to CHANGELOG.md, not to feature prose. */
function checkInlineVersions() {
  for (const rel of ['README.md', 'README.en.md']) {
    if (!existsSync(join(root, rel))) continue
    read(rel)
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (/（1\.\d+\.\d+/.test(line) || /\(1\.\d+\.\d+/.test(line)) {
          note(rel, `line ${i + 1} carries an inline version marker — version history lives in CHANGELOG.md`)
        }
      })
  }
}

checkHeadingParity()
checkPairLinks()
checkLinks()
checkScriptNames()
checkBanned()
checkWidth()
checkInlineVersions()

const detail = issues.length === 0
  ? `${DOCS.length} doc(s) checked — headings aligned, links resolve, names current`
  : issues.map((i) => `${i.file}: ${i.message}`).join('\n    ')

console.log(`P12 docs consistency: ${issues.length === 0 ? 'PASS' : `WARN (${issues.length})`} — ${detail}`)
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify({ pass: issues.length === 0, issues }, null, 2)}\n`)
process.exitCode = 0
