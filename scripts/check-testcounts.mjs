/**
 * Test-count drift check for docs/vault:
 *  - reads the authoritative per-file counts from 50-Testing/测试覆盖清单.md
 *    (the table rows `| \`xxx.test.ts\` | N | ...` and the total "N 用例")
 *  - scans every vault note for `xxx.test.ts（N 例）` style references and
 *    `N 用例` total references (excluding the checklist itself)
 *  - verifies each reference matches the authoritative count, and that the
 *    listed file counts actually sum to the stated total
 * Usage: node scripts/check-testcounts.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const VAULT = path.resolve('docs/vault')
const CHECKLIST = path.join(VAULT, '50-Testing', '测试覆盖清单.md')

const errors = []
const warnings = []

// 1) Parse the authoritative checklist: per-file counts + total.
const checklist = fs.readFileSync(CHECKLIST, 'utf8')
const fileCounts = new Map()
for (const m of checklist.matchAll(/^\|\s*`([\w.-]+\.test\.ts)`\s*\|\s*(\d+)\s*\|/gm)) {
  fileCounts.set(m[1], Number(m[2]))
}
if (fileCounts.size === 0) {
  console.error(`check-testcounts FAILED: no counts parsed from ${CHECKLIST}`)
  process.exit(1)
}
const totalMatch = checklist.match(/(\d+)\s*个测试文件、(\d+)\s*用例/)
if (!totalMatch) {
  console.error(`check-testcounts FAILED: total line not found in ${CHECKLIST}`)
  process.exit(1)
}
const statedFiles = Number(totalMatch[1])
const statedTotal = Number(totalMatch[2])

// 2) Self-consistency: the listed files must sum to the stated total.
const summed = [...fileCounts.values()].reduce((a, b) => a + b, 0)
if (fileCounts.size !== statedFiles) {
  errors.push(`checklist: lists ${fileCounts.size} test files but states "${statedFiles} 个测试文件"`)
}
if (summed !== statedTotal) {
  errors.push(`checklist: per-file counts sum to ${summed}, but the total states ${statedTotal}`)
}

// 3) Scan every vault note for references.
const fileRe = /`([\w.-]+\.test\.ts)`[（(]\s*(\d+)\s*例[）)]/g
const totalRe = /(\d+)\s*用例/g
const notes = []
for (const dir of ['00-Index', '10-Architecture', '20-Modules', '30-Config', '40-Templates', '50-Testing', '60-Decisions', '70-Release', '80-Security', '90-Roadmap', '99-Glossary']) {
  const full = path.join(VAULT, dir)
  if (!fs.existsSync(full)) continue
  for (const file of fs.readdirSync(full)) {
    if (file.endsWith('.md')) notes.push(path.join(full, file))
  }
}

for (const note of notes) {
  if (path.resolve(note) === path.resolve(CHECKLIST)) continue // skip the source of truth
  const text = fs.readFileSync(note, 'utf8')
  const rel = path.relative(VAULT, note).replace(/\\/g, '/')

  // 3a) per-file references: `xxx.test.ts（N 例）`
  for (const m of text.matchAll(fileRe)) {
    const file = m[1]
    const n = Number(m[2])
    const expected = fileCounts.get(file)
    if (expected === undefined) {
      warnings.push(`${rel}: references unknown test file "${file}"（${n} 例）——checklist 无此行`)
    } else if (n !== expected) {
      errors.push(`${rel}: ${file}（${n} 例）≠ checklist ${expected} 例`)
    }
  }

  // 3b) total references: "N 用例"（"测试用例" 无数字，天然不匹配）
  for (const m of text.matchAll(totalRe)) {
    const n = Number(m[1])
    if (n !== statedTotal) {
      errors.push(`${rel}: states ${n} 用例 ≠ checklist ${statedTotal} 用例`)
    }
  }
}

if (warnings.length > 0) {
  console.warn(`check-testcounts warnings (${warnings.length}):`)
  for (const w of warnings) console.warn('  ' + w)
}
if (errors.length > 0) {
  console.error(`check-testcounts FAILED: ${errors.length} issue(s)`)
  for (const e of errors) console.error('  ' + e)
  process.exit(1)
}
console.log(`check-testcounts OK: ${fileCounts.size} test files / ${statedTotal} 用例, all vault references in sync`)
