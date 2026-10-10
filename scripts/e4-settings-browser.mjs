#!/usr/bin/env node
/**
 * E4 acceptance — the settings surface in a real browser, end to end (gate P11).
 *
 * E4.1 disposable DSH_HOME/profile → E4.2 install → E4.3 `dsh web` prints a
 * tokenized URL → E4.4 Chromium lands on the app (token→cookie) → E4.5 client
 * bundle fetched (no 404 white screen) → E4.6 our section renders every declared
 * field → E4.7 an edit writes to the profile patch and reads back → teardown;
 * RC1 a bogus token must NOT land, RC2 the value must not already be on disk.
 * Crosses four boundaries no fake host shares: auth handshake, served plugin
 * manifest, real `configForms`, React mounting our `settings.section` slot.
 *
 * Usage: pnpm e4 [--recon] [--keep --home <dir>] [--json <path>] [--channel msedge]
 * Outside the sandbox; drives installed Chrome/Edge via `playwright-core`.
 * @see docs/compatibility.md §6, §7
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const origin = process.cwd()
const argv = process.argv.slice(2)
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}
const DSH_BIN = String(flag('dsh-bin', 'D:/npm-global/node_modules/@deepseek-ai/dsh/lib/bin.js'))
const KEEP = flag('keep', false) === true
const RECON = flag('recon', false) === true
const REUSE_HOME = flag('home', '')
const BROWSER_CHANNEL = String(flag('channel', 'chrome'))
const HEADFUL = flag('headful', false) === true
const PW_ROOT = flag('pw-root', process.env.PO_PLAYWRIGHT_CORE ?? '')
const SHOTS = resolve(String(flag('shots', join(root, '.workbuddy', 'e2e', 'shots'))))
const JSON_OUT = flag('json', '')
/** Where this machine keeps its throwaway `playwright-core`; override with `--pw-root`. */
const DEFAULT_PW_ROOT = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace'

const results = []
const gaps = []
let failures = 0
const check = (id, label, ok, detail = '') => {
  results.push({ id, label, ok, detail })
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(6)} ${label}${detail ? `  — ${detail}` : ''}`)
}
const ctrl = (id, label, ok, detail = '') => check(id, label, ok, detail)
const gap = (id, label) => {
  gaps.push({ id, label })
  console.log(`  GAP   ${id.padEnd(6)} ${label}`)
}

function run(cmd, args, { env = {}, timeoutMs = 300000, cwd = root } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch {}
    }, timeoutMs)
    const collect = (chunk) => { out += chunk.toString() }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolvePromise({ code: -1, out: `${out}\n[spawn error] ${e.message}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, out, timedOut })
    })
  })
}
const runNpm = (args, opts = {}) => process.platform === 'win32'
  ? run('cmd.exe', ['/c', 'npm', ...args], opts)
  : run('npm', args, opts)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tail = (s, n = 2) => s.trim().split(/\r?\n/).filter(Boolean).slice(-n).join(' | ').slice(0, 240)

/** Every directory worth trying when Node cannot see `playwright-core` here. */
function playwrightRoots() {
  const roots = []
  const push = (dir) => { if (typeof dir === 'string' && dir.length > 0) roots.push(dir) }
  push(PW_ROOT && String(PW_ROOT))
  push(process.env.PO_PLAYWRIGHT_CORE)
  push(join(root, 'node_modules'))
  push(process.env.WORKBUDDY_NODE_WORKSPACE)
  push(process.env.WORKBUDDY_PW_WORKSPACE)
  for (const part of String(process.env.NODE_PATH ?? '').split(delimiter)) push(part)
  // `<global prefix>/node_modules`, derived from where `dsh` itself lives.
  push(resolve(dirname(DSH_BIN), '..', '..'))
  push(DEFAULT_PW_ROOT)
  return [...new Set(roots)]
}

async function loadPlaywright() {
  const tries = playwrightRoots()
  for (const dir of tries) {
    try {
      const req = createRequire(join(dir, 'package.json'))
      const entry = req.resolve('playwright-core')
      // playwright-core is CJS; its named exports are attached in a way Node's
      // cjs-module-lexer does not always surface, so read them off `default` too.
      const mod = await import(pathToFileURL(entry).href)
      const chromium = mod.chromium ?? mod.default?.chromium
      if (!chromium) throw new Error(`no chromium export (keys: ${Object.keys(mod).join(',')})`)
      return { chromium, from: dir }
    } catch {
      // try the next root
    }
  }
  throw new Error(
    'playwright-core not found. It is deliberately NOT a dependency of this package:\n'
    + `    npm install playwright-core --prefix ${DEFAULT_PW_ROOT}\n`
    + '  ...or point this script at an existing install:\n'
    + '    node scripts/e4-settings-browser.mjs --pw-root <dir>     (or)  PO_PLAYWRIGHT_CORE=<dir>\n'
    + `  tried: ${tries.join('\n         ') || '(nothing)'}\n`
    + "  This script drives the Chromium you already have (--channel chrome|msedge); it never downloads one.",
  )
}

/** Everything a human could click, so recon output tells us how to navigate. */
const DUMP_CLICKABLES = `(() => {
  const pick = (el) => {
    const t = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60)
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 60) : '',
      aria: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      role: el.getAttribute('role') || '',
      text: t,
    }
  }
  const nodes = [...document.querySelectorAll('button,[role=button],a[href],[role=tab],[role=menuitem]')]
  return nodes.slice(0, 80).map(pick)
})()`

async function main() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const pluginName = manifest.name
  const pluginVersion = manifest.version
  const patchYml = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const entryId = /-\s*insert:\s*\n\s*-\s*id:\s*(\S+)/.exec(patchYml)?.[1] ?? ''

  const configSrc = readFileSync(join(root, 'src/config.ts'), 'utf8')
  const liveKeys = [...(/LIVE_CONFIG_KEYS\s*=\s*\[([\s\S]*?)\]/m.exec(configSrc)?.[1] ?? '')
    .matchAll(/'([^']+)'/g)].map((m) => m[1])

  console.log('=== settings end-to-end in a real browser ===')
  console.log(`plugin   : ${pluginName}@${pluginVersion}`)
  console.log(`entry id : ${entryId}`)
  console.log(`live keys: ${liveKeys.join(', ')}`)
  const hostVersion = (await run(process.execPath, [DSH_BIN, '--version'])).out.trim().split(/\r?\n/)[0]
  console.log(`dsh host : ${hostVersion}\n`)

  if (!entryId || liveKeys.length === 0) {
    console.error('e4: could not read the entry id / LIVE_CONFIG_KEYS from source')
    return 2
  }

  // ----------------------------------------------------------------- E4.1 home
  const home = REUSE_HOME ? resolve(REUSE_HOME) : mkdtempSync(join(tmpdir(), 'dsh-brw-'))
  const env = { DSH_HOME: home }
  const patchPath = join(home, 'profiles', 'e2e', 'cordis.patch.yml')
  const installedDir = join(home, 'profiles', 'e2e', 'node_modules', pluginName)
  const reused = Boolean(REUSE_HOME) && existsSync(join(installedDir, 'package.json'))

  if (reused) {
    console.log(`[E4.1] reusing DSH_HOME = ${home} (plugin already installed)`)
    check('E4.1', 'disposable profile exists', true, 'reused')
    check('E4.2', 'plugin is installed in the profile', true, 'reused')
  } else {
    console.log(`[E4.1] disposable DSH_HOME = ${home}`)
    const init = await run(process.execPath, [DSH_BIN, '--profile', 'e2e', '--from-default-profile', 'web', '--dump-config'], {
      env,
      timeoutMs: 180000,
    })
    check('E4.1', 'disposable profile composes from the web template', init.code === 0 && !init.out.includes(entryId), `exit ${init.code}`)

    // `--pack-destination` keeps the tarball out of the repo root, so a run
    // leaves nothing behind (the artifact also must not sit at a path with a
    // space: `dsh plugin add <path>` re-splits its arguments on whitespace).
    const pack = await runNpm(['pack', '--silent', '--pack-destination', home], { timeoutMs: 300000 })
    const packed = tail(pack.out, 1)
    const staged = join(home, packed)
    if (pack.code !== 0 || !packed || !existsSync(staged)) {
      console.error(`e4: npm pack failed (exit ${pack.code}) ${tail(pack.out)}`)
      return 2
    }
    const install = await run(process.execPath, [DSH_BIN, 'plugin', '--profile', 'e2e', 'add', staged], { env, timeoutMs: 600000 })
    const installedVersion = existsSync(join(installedDir, 'package.json'))
      ? JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')).version
      : ''
    console.log(`\n[E4.2] dsh plugin add → exit ${install.code}, installed ${installedVersion || '(missing)'}`)
    check('E4.2', 'plugin installs into the disposable profile', install.code === 0 && installedVersion === pluginVersion, tail(install.out))
  }

  // -------------------------------------------------------------- E4.3 dsh web
  console.log(`\n[E4.3] boot \`dsh web\` on a free port`)
  const boot = spawn(process.execPath, [DSH_BIN, '--profile', 'e2e', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let bootLog = ''
  let base = ''
  let token = ''
  const onBoot = (chunk) => {
    const text = chunk.toString()
    bootLog += text
    if (!RECON) process.stdout.write(`    | ${text.replace(/\s+$/, '').split('\n').join('\n    | ')}\n`)
    const m = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=(\S+)/.exec(text)
    if (m && !base) { base = m[1]; token = m[2] }
  }
  boot.stdout.on('data', onBoot)
  boot.stderr.on('data', onBoot)

  const deadline = Date.now() + 120000
  while (!base && Date.now() < deadline && boot.exitCode === null) await sleep(400)
  check('E4.3', '`dsh web` boots and prints its tokenized URL', Boolean(base), base || tail(bootLog, 6))
  if (!base) { try { boot.kill() } catch {}; return finish(home, 1, { hostVersion, pluginName, pluginVersion, entryId, liveKeys }) }

  // -------------------------------------------------------------- E4.4 browser
  const { chromium, from } = await loadPlaywright()
  console.log(`\n[E4.4] launch Chromium (channel=${BROWSER_CHANNEL}, playwright-core from ${from}) and complete the token→cookie handshake`)
  const browser = await chromium.launch({ channel: BROWSER_CHANNEL, headless: !HEADFUL })
  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleErrors = []
  const failedRequests = []
  const jsResponses = []
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)) })
  page.on('requestfailed', (req) => failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? ''}`.slice(0, 240)))
  // Registered before the first navigation so the initial document load is seen.
  // The plugin URL is `/plugins/??<pkg>/client.js&rev=<hash>` — a bare `&`, not
  // a `?` — so the suffix test must not demand `?`/EOL after `.js`.
  page.on('response', (r) => {
    if (/\.js(\?|&|$)/.test(r.url())) jsResponses.push({ url: r.url(), status: r.status() })
  })

  // RC1 first: a bogus token must not land us on the app.
  const rc1Page = await context.newPage()
  let rc1Ok = false
  let rc1Detail = ''
  try {
    const r = await rc1Page.goto(`${base}/?token=bogus-browser-token`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    const hasApp = await rc1Page.locator('body').innerText().then((t) => t.length > 40).catch(() => false)
    rc1Ok = !(r && r.status() === 200 && hasApp)
    rc1Detail = `status ${r?.status() ?? '?'}, app-ish body=${hasApp}`
  } catch (e) {
    rc1Ok = true
    rc1Detail = String(e.message).split('\n')[0].slice(0, 120)
  }
  await rc1Page.close()
  ctrl('RC1', 'bogus token does not land on the app', rc1Ok, rc1Detail)

  const resp = await page.goto(`${base}/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  const cookies = await context.cookies()
  const title = await page.title()
  const bodyHead = (await page.locator('body').innerText().catch(() => '')).slice(0, 300)
  console.log(`    final url: ${page.url()}`)
  console.log(`    status   : ${resp?.status() ?? '?'}   title: ${title}`)
  console.log(`    cookies  : ${cookies.map((c) => `${c.name}@${c.domain}`).join(', ') || '(none)'}`)
  console.log(`    body head: ${JSON.stringify(bodyHead.slice(0, 160))}`)
  check('E4.4', 'the browser lands on the app after the token→cookie handshake', cookies.length > 0 && page.url().includes('127.0.0.1'), `${cookies.length} cookie(s)`)

  // --------------------------------------------------- E4.5 client plugin bundle
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  await sleep(1200)

  const ourBundle = jsResponses.filter((h) => h.url.includes(pluginName))
  const anyBad = jsResponses.filter((h) => h.status >= 400)
  console.log(`\n[E4.5] JS responses seen: ${jsResponses.length}; ours: ${ourBundle.length}`)
  for (const h of ourBundle.slice(0, 4)) console.log(`    ${h.status}  ${h.url.slice(0, 150)}`)
  for (const h of anyBad.slice(0, 6)) console.log(`    BAD ${h.status}  ${h.url.slice(0, 150)}`)
  check('E4.5', `the browser fetches ${pluginName}/client.js without an error status`, ourBundle.length > 0 && ourBundle.every((h) => h.status === 200), `${ourBundle.length} hit(s)`)

  // ------------------------------------------------------------------ E4.6 DOM
  // Our settings copy is a `settings.section` registration, so it only exists
  // once the settings surface is open. The ✨ button proves `apply()` ran, but
  // not that the section mounted — that needs a real click.
  console.log(`\n[E4.6] open the settings surface`)
  try { mkdirSync(SHOTS, { recursive: true }) } catch {}
  const shot = async (name) => {
    try { await page.screenshot({ path: join(SHOTS, `${name}.png`) }) } catch (e) { console.log(`    shot ${name} failed: ${String(e.message).split('\n')[0].slice(0, 80)}`) }
  }
  /** Any overlay-ish node the host might be using for the settings surface. */
  const DUMP_OVERLAYS = `(() => [...document.querySelectorAll('[role=dialog],[role=menu],[class*=overlay],[class*=Overlay],[class*=drawer],[class*=Drawer],[class*=settings],[class*=Settings],[class*=modal],[class*=Modal],[class*=popover],[class*=Popover]')]
    .map((e) => ({ tag: e.tagName.toLowerCase(), cls: String(e.className).slice(0, 70), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) }))
    .slice(0, 40))()`

  const NAV = ['提示词优化', 'Prompt Optimizer']
  const fieldCount = () => page.locator('.po-field-input[data-po-key]').count()
  /** Click the first candidate that is actually visible; fall back to force. */
  const tryClick = async (label, sel) => {
    const loc = page.locator(sel)
    const n = await loc.count()
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i)
      if (!(await el.isVisible().catch(() => false))) continue
      try {
        await el.click({ timeout: 6000 })
        return true
      } catch (e) {
        console.log(`    ${label}[${i}] click failed: ${String(e.message).split('\n').slice(0, 3).join(' / ').slice(0, 220)}`)
        try {
          await el.click({ force: true, timeout: 4000 })
          console.log(`    ${label}[${i}] force-clicked`)
          return true
        } catch (e2) {
          console.log(`    ${label}[${i}] force click failed: ${String(e2.message).split('\n')[0].slice(0, 180)}`)
          // React listens on the root, so a programmatic click still dispatches.
          const jsOk = await el.evaluate((node) => { node.click(); return true }).catch(() => false)
          if (jsOk) { console.log(`    ${label}[${i}] JS-clicked`); return true }
        }
      }
    }
    console.log(`    ${label}: no clickable candidate among ${n}`)
    return false
  }

  let fields = await fieldCount()
  if (fields === 0) {
    await shot('e4-00-app')
    // A fresh profile boots into a CHAIN of blocking onboarding modals (preview
    // notice → "add an API key"). While any is up, every other click times out
    // against it — the reason the settings button looked unclickable. Dismiss
    // them in a loop; "保存并继续" is deliberately absent because it would try to
    // persist an empty key.
    const DISMISS = ['继续', 'Continue', '稍后配置', '稍后', 'Skip for now', 'Skip', 'Later', '知道了', 'Got it', '关闭', 'Close']
    const dialogCount = () => page.locator('[class*="dialog"], [role="dialog"]').count()
    for (let round = 0; round < 5; round++) {
      let acted = false
      for (const label of DISMISS) {
        const btn = page.getByRole('button', { name: label, exact: true }).first()
        if (!(await btn.count())) continue
        if (!(await btn.isVisible().catch(() => false))) continue
        const ok = await btn.click({ timeout: 4000 }).then(() => true, () => false)
        if (!ok) continue
        console.log(`    onboarding step ${round + 1}: clicked "${label}"`)
        await sleep(1000)
        acted = true
        break
      }
      if (!acted) break
      if ((await dialogCount()) === 0) break
    }
    console.log(`    dialogs remaining after onboarding: ${await dialogCount()}`)
    if (await dialogCount()) {
      await page.keyboard.press('Escape').catch(() => {})
      await sleep(600)
      console.log(`    dialogs remaining after Escape: ${await dialogCount()}`)
    }
    await shot('e4-00b-dismissed')
    // `.VOzbGW_trigger` reads like a popover trigger, so try hover before click.
    const setBtn = page.locator('.VOzbGW_trigger, [aria-label="设置"], [aria-label="Settings"]').first()
    if (await setBtn.count()) {
      await setBtn.hover({ timeout: 5000 }).catch((e) => console.log(`    hover failed: ${String(e.message).split('\n')[0].slice(0, 100)}`))
      await sleep(1000)
      await shot('e4-01-hover')
      const ov = await page.evaluate(DUMP_OVERLAYS)
      console.log(`    overlays after hover: ${ov.length}`)
      for (const o of ov) console.log(`      <${o.tag}> cls="${o.cls}" ${o.w}x${o.h}`)
    }
    await tryClick('settings', '[aria-label="设置"], [aria-label="Settings"], .VOzbGW_trigger')
    await sleep(1800)
    await shot('e4-02-click')
    fields = await fieldCount()
    console.log(`    after opening settings: .po-field-input = ${fields}, .po-section = ${await page.locator('.po-section').count()}`)
    const ov2 = await page.evaluate(DUMP_OVERLAYS)
    console.log(`    overlays after click: ${ov2.length}`)
    for (const o of ov2) console.log(`      <${o.tag}> cls="${o.cls}" ${o.w}x${o.h}`)
  }
  if (fields === 0) {
    for (const name of NAV) {
      if (!(await page.locator(`text=${name}`).count())) continue
      await tryClick(`nav "${name}"`, `text=${name}`)
      await sleep(1500)
      fields = await fieldCount()
      console.log(`    after clicking nav "${name}": .po-field-input = ${fields}`)
      if (fields > 0) break
    }
  }

  if (RECON) {
    const clickables = await page.evaluate(DUMP_CLICKABLES)
    console.log(`    clickable nodes now: ${clickables.length}`)
    for (const c of clickables) {
      console.log(`      <${c.tag}> cls="${c.cls}" aria="${c.aria}" title="${c.title}" role="${c.role}" text="${c.text}"`)
    }
    const visibleText = await page.evaluate(`(() => {
      const out = []
      for (const el of document.querySelectorAll('*')) {
        if (el.children.length) continue
        const t = (el.textContent || '').trim()
        if (!t || t.length > 24) continue
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        out.push(t)
      }
      return [...new Set(out)].slice(0, 120)
    })()`)
    console.log(`    visible short text: ${visibleText.join(' | ')}`)
    console.log(`    .po-section count = ${await page.locator('.po-section').count()}`)
    console.log('\n[recon] dumping everything that mentions the plugin')
    const html = await page.content()
    writeFileSync(join(SHOTS, 'recon-page.html'), html, 'utf8')
    console.log(`    saved page html (${html.length} chars) → ${join(SHOTS, 'recon-page.html')}`)
    const hit = html.indexOf('po-section')
    console.log(`    html.indexOf('po-section') = ${hit}`)
    if (hit >= 0) console.log(`    context: ${html.slice(Math.max(0, hit - 400), hit + 600)}`)
    for (const e of consoleErrors.slice(0, 10)) console.log(`    console error: ${e}`)
    await browser.close()
    try { boot.kill() } catch {}
    await sleep(600)
    return finish(home, failures === 0 ? 0 : 1, { hostVersion, pluginName, pluginVersion, entryId, liveKeys })
  }

  const presentKeys = await page.locator('.po-field-input[data-po-key]').evaluateAll((els) => els.map((e) => e.getAttribute('data-po-key')))
  const labels = await page.locator('.po-field').evaluateAll((els) => els.map((e) => (e.innerText || '').split('\n')[0].slice(0, 40)))
  console.log(`\n[E4.6] fields in the DOM: ${presentKeys.length} → ${presentKeys.join(', ')}`)
  console.log(`    labels: ${labels.join(' | ')}`)
  check('E4.6', `the settings section renders all ${liveKeys.length} declared fields`, JSON.stringify([...presentKeys].sort()) === JSON.stringify([...liveKeys].sort()), `${presentKeys.length}/${liveKeys.length}`)
  await shot('e4-03-fields')

  // ------------------------------------------------------------------ E4.7 write
  // There is no Save button on this surface: 0.2.0's `configForms` persists on
  // change (`onChange → form.set(key, value)`), and the UI flashes a hint. So
  // the honest equivalent of "click Save" is "select a new value and watch the
  // profile patch on disk change".
  const targetKey = 'outputStyle'
  const field = page.locator(`.po-field-input[data-po-key="${targetKey}"]`)
  const disabled = await field.isDisabled().catch(() => true)
  const current = await field.inputValue().catch(() => '')
  const options = await field.locator('option').evaluateAll((els) => els.map((e) => e.value)).catch(() => [])
  const target = options.find((o) => o && o !== current) ?? ''
  const before = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  console.log(`\n[E4.7] edit ${targetKey}: ${current} → ${target} (options: ${options.join('|')})`)
  console.log(`    field disabled = ${disabled}   patch before: ${before.includes(`${targetKey}: ${target}`) ? 'already holds the target (!)' : 'does not hold the target'}`)
  check('E4.7a', 'the field is editable — i.e. `configForms` really served this namespace', !disabled && target !== '', `disabled=${disabled}`)
  ctrl('RC2', 'the value we are about to write is not already on disk', !before.includes(`${targetKey}: ${target}`))

  await field.selectOption(target).catch((e) => console.log(`    selectOption failed: ${String(e.message).split('\n')[0].slice(0, 100)}`))
  await sleep(700)
  const hints = await page.locator('.po-hint').evaluateAll((els) => els.map((e) => e.innerText.trim()).filter(Boolean)).catch(() => [])
  console.log(`    hints after the change: ${JSON.stringify(hints.slice(0, 6))}`)
  await sleep(2000)

  const after = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  console.log(`    patch file: ${patchPath}`)
  console.log(`    changed on disk = ${before !== after}`)
  if (before !== after) {
    const b = before.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const a = after.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    for (const l of a) if (!b.includes(l)) console.log(`      + ${l}`)
    for (const l of b) if (!a.includes(l)) console.log(`      - ${l}`)
  } else {
    console.log('      (no diff — the browser edit did not reach disk)')
  }
  check('E4.7b', 'the client shows a save confirmation for the edited field', hints.some((h) => h.includes(targetKey)), hints.join(' | ').slice(0, 160))
  check('E4.7', 'the browser edit writes through to the profile patch on disk', before !== after && after.includes(`${targetKey}: ${target}`), after === before ? 'file unchanged' : '')

  const readBack = await field.inputValue().catch(() => '')
  const metaAfter = await page.locator('.po-field').first().innerText().catch(() => '')
  console.log(`    read-back value = ${readBack}   field meta: ${metaAfter.replace(/\s+/g, ' ').slice(0, 80)}`)
  check('E4.7c', 'the field reads back the value the browser selected', readBack === target, `${readBack}`)
  await page.screenshot({ path: join(SHOTS, 'e4-07-saved.png') }).catch(() => {})

  if (consoleErrors.length) {
    console.log(`\n    console errors (${consoleErrors.length}):`)
    for (const e of consoleErrors.slice(0, 8)) console.log(`      ${e}`)
  }
  if (failedRequests.length) {
    console.log(`\n    failed requests (${failedRequests.length}):`)
    for (const f of failedRequests.slice(0, 8)) console.log(`      ${f}`)
  }

  await browser.close()
  try { boot.kill() } catch {}
  await sleep(600)
  return finish(home, failures === 0 ? 0 : 1, { hostVersion, pluginName, pluginVersion, entryId, liveKeys })
}

let forced = false
async function finish(home, code, meta = {}) {
  if (forced) return code
  forced = true
  console.log(`\n[E4.8] tear-down`)
  if (!KEEP && !REUSE_HOME) {
    try { process.chdir(origin) } catch {}
    let error = null
    await sleep(800)
    for (let i = 0; i < 3; i++) {
      error = null
      try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }) } catch (e) { error = e }
      if (!existsSync(home)) break
      await sleep(1000)
    }
    const gone = !existsSync(home)
    const leftovers = gone ? [] : (() => { try { return readdirSync(home) } catch { return ['<unreadable>'] } })()
    check('E4.8', 'the disposable home is gone (nothing of ours survives)', gone, error ? String(error.message).slice(0, 120) : `left: ${leftovers.slice(0, 5).join(', ')}`)
  } else {
    console.log(`    home preserved at ${home}`)
  }

  const passed = results.filter((r) => r.ok).length
  const verdict = failures === 0 ? 'PASS' : 'FAIL'
  if (JSON_OUT) {
    const evidence = {
      plugin: `${meta.pluginName}@${meta.pluginVersion}`,
      dshHost: meta.hostVersion ?? '',
      entryId: meta.entryId ?? '',
      liveKeys: meta.liveKeys ?? [],
      checks: results,
      controls: results.filter((r) => r.id.startsWith('RC')),
      gaps,
      verdict,
      at: new Date().toISOString(),
    }
    const target = resolve(String(JSON_OUT))
    writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(`\nevidence written to ${target}`)
  }
  console.log(`\n=== verdict: ${verdict} (${passed}/${results.length}${gaps.length ? ` + ${gaps.length} gap` : ''}) ===`)
  for (const g of gaps) console.log(`  gap ${g.id}: ${g.label}`)
  process.exitCode = failures === 0 ? 0 : 1
  const timer = setTimeout(() => process.exit(failures === 0 ? 0 : 1), 6000)
  timer.unref?.()
  return code
}

process.on('unhandledRejection', (e) => {
  console.error('e4: unhandled rejection —', e?.message ?? e)
  process.exitCode = 1
})

await main().then((code) => {
  if (typeof code === 'number' && code !== 0) process.exitCode = code
})
