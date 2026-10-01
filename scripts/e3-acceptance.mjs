#!/usr/bin/env node
/**
 * E3 acceptance — install / start / uninstall the plugin in a **disposable**
 * profile, and prove each step from the outside.
 *
 * Why this exists: DSH STORE relisting asks for evidence that a fixed artifact
 * really installs, boots and uninstalls on a given DSH release, produced
 * *without* touching a real `~/.dsh`. The store runs its own L4/L5 checks; this
 * script is the locally reproducible counterpart, so the compatibility record we
 * declare in `dsh.compatibility.dshReleases` rests on something we ran
 * ourselves rather than on optimism.
 *
 * Everything happens under a throwaway `DSH_HOME` in the OS temp dir. The real
 * profile is never read or written, and the temp home is removed at the end
 * unless `--keep` is passed.
 *
 * Checked steps:
 *   E3.1  disposable DSH_HOME created from scratch
 *   E3.2  the profile composes from the shipped `web` template (no plugin yet)
 *   E3.3  the artifact is staged to a space-free path
 *   E3.4  `dsh plugin --profile e3 add <staged>` exits 0
 *   E3.5  the installed copy reports the version we asked for
 *   E3.6  `dsh --profile e3 --dump-config` carries the plugin's own entry id
 *   E3.7  `dsh web` boots, answers HTTP 200, and serves the plugin's own client
 *         module (proves the client half mounts, not just the host)
 *   E3.8  `dsh plugin --profile e3 remove` exits 0 and the directory is gone
 *   E3.9  nothing of *ours* survives the run — the installed package and the
 *         control profiles the run created are gone, confirmed by both per-path
 *         probes and a walk over the leftovers; an undeletable scratch dir is
 *         reported as a note, not a failure
 *
 * Reverse controls (a check that cannot fail proves nothing):
 *   RC1  a real web profile without the plugin must NOT show the entry id, so
 *        E3.6 is capable of failing
 *   RC2  a bogus token must NOT yield HTTP 200 + cookie, so E3.7's auth fence
 *        is real
 *   RC3  a version that does not exist must fail the same install path as E3.4
 *
 * Two environment facts this script encodes, both learned the hard way:
 *
 *   1. `dsh plugin add <path>` re-splits its argument on whitespace, so a path
 *      containing a space reaches pnpm as `owner/repo` and is resolved as a
 *      GitHub shorthand ("Failed to resolve git dependency
 *      prompt-optimizer/oss-….tgz"). Hence E3.3: stage into a space-free dir.
 *   2. A brand-new profile is bare — it has no web app to boot. Initialize from
 *      the shipped template (`--from-default-profile web`) before installing,
 *      which is also what a real user does.
 *
 * E3.9 attempts one Node delete and then judges the outcome by what is actually
 * left, never by whether the delete reported success. The temp home is ~600
 * files, and a delete can legitimately fail for reasons that say nothing about
 * the plugin, so a surviving scratch directory is reported as a note. Pass
 * `--keep` to skip removal entirely.
 *
 * A host-level bulk-delete guard was once believed to be behind those failures:
 * a `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]` refusal with no `code`,
 * `errno` or `path`. Controlled runs disproved it — with the guard's shim loaded
 * and its threshold at 50, a 1062-entry tree under the temp dir *and* the same
 * tree outside it both deleted cleanly, because the shim bypasses `os.tmpdir()`
 * and this home lives there. The guard is therefore not modelled here; the
 * delete is simply attempted and its real error, if any, is recorded.
 *
 * Usage:
 *   node scripts/e3-acceptance.mjs                          # packs the local build
 *   node scripts/e3-acceptance.mjs --source ./out.tgz
 *   node scripts/e3-acceptance.mjs --source github:seven282/oss-prompt-optimizer#<sha>
 *   node scripts/e3-acceptance.mjs --dsh-bin <path/to/dsh/lib/bin.js> --json e3.json
 *
 * `--dsh-bin` picks which DSH release acts as the host. Evidence is taken for
 * the **latest** release only: `dsh.compatibility.dshReleases` declares the
 * newest version, and older releases are served by older plugin versions, so
 * re-running them here would produce claims nobody reads.
 *
 * Windows note: run this **outside** the assistant sandbox. `dsh web` reaches
 * for `reg.exe` while probing the environment, the sandbox blocks it, and the
 * host then hangs producing no output at all.
 *
 * Exit: 0 = every step and every control behaved; 1 = a step failed; 2 = usage
 *       or environment error (no dsh found, no plugin manifest, packing failed).
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2)
function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}
const OPT = {
  source: String(flag('source', '') || ''),
  dshBin: String(flag('dsh-bin', '') || ''),
  json: String(flag('json', '') || ''),
  keep: flag('keep', false) === true,
  installTimeoutMs: Number(flag('install-timeout', '600000')),
  bootTimeoutMs: Number(flag('boot-timeout', '120000')),
}

const lines = []
const log = (s = '') => {
  lines.push(s)
  if (!OPT.json) console.log(s)
}

// -------------------------------------------------------- host + manifest bits
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pluginName = manifest.name
const pluginVersion = manifest.version

/**
 * The entry id the bundle patch inserts, read from `cordis.patch.yml` rather
 * than hardcoded — if the patch and this script ever disagree, the check must
 * notice instead of papering over it.
 */
function readEntryId() {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const m = /-\s*insert:\s*\n\s*-\s*id:\s*(\S+)/.exec(patch)
  return m ? m[1] : ''
}
const entryId = readEntryId()

/**
 * Locate a DSH CLI entry point. `dsh` is normally a global npm bin:
 * `<prefix>/dsh.cmd` sits next to `<prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js`.
 * We spawn that JS file with the current node rather than the shim, because Node
 * refuses to spawn `.cmd` files without `shell: true` and building command
 * strings from untrusted input is exactly what we must not do.
 */
function resolveDshBin() {
  if (OPT.dshBin) return resolve(OPT.dshBin)
  const rel = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const cand of [join(dir, rel), join(dir, '..', rel)]) {
      if (existsSync(cand)) return resolve(cand)
    }
  }
  return ''
}

// ------------------------------------------------------------------- processes
/** Run a child to completion; a non-zero exit is a result, not an exception. */
function run(cmd, args, { env = {}, timeoutMs = 300000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
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

/**
 * Run a package-manager command. npm ships as a shell shim on Windows, which
 * Node will not spawn directly, so go through `cmd.exe /c` with a fixed
 * argument array — no interpolated user input ever reaches a command string.
 */
async function runNpm(args, opts = {}) {
  if (process.platform === 'win32') return run('cmd.exe', ['/c', 'npm', ...args], { cwd: root, ...opts })
  return run('npm', args, { cwd: root, ...opts })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tail = (s, n = 3) => s.trim().split(/\r?\n/).filter(Boolean).slice(-n).join(' | ')

// -------------------------------------------------------------- cleanup probes

/**
 * Plain name list of a directory's children. Never throws and never recurses —
 * after a partial delete the tree can contain entries a walker would trip over,
 * and only emptiness matters here.
 */
function childNames(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Delete the disposable home, then report what survived.
 *
 * Removing the temp home means unlinking ~600 files, and a delete can fail for
 * reasons that have nothing to do with the plugin — a transient lock, an
 * antivirus scanner holding a handle, a file open in another window. So the
 * caller judges the outcome by what is *left*, not by whether the call threw.
 *
 * A host-level *safe-delete* guard was once blamed for these failures. Controlled
 * runs ruled it out: with its shim loaded and threshold at 50, a 1062-entry tree
 * under the temp dir and the same tree outside it both deleted cleanly, because
 * the shim bypasses `os.tmpdir()` and this home lives there. Modelling a guard
 * that does not fire bought nothing but a false cause to point at, so it is gone.
 *
 * `force: true` is still right — it is what makes an already-absent path a
 * no-op rather than an error.
 */
function removeTree(dir) {
  let error = null
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
  } catch (e) {
    error = e
  }
  return {
    gone: !existsSync(dir),
    error: error ? firstLine(error.message || String(error)) : null,
  }
}

/** First line of a message, capped — error blobs can carry a whole JSON payload. */
function firstLine(text, max = 180) {
  const line = String(text).split(/\r?\n/)[0].trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** Number of entries a directory tree holds, up to `limit`; -1 when unreadable. */
function countEntries(dir, limit = 5000) {
  if (!existsSync(dir)) return 0
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      total += 1
      if (total > limit) return total
      if (e.isDirectory() && !e.isSymbolicLink()) stack.push(join(current, e.name))
    }
  }
  return total
}

/**
 * Every file or directory name in the tree, capped. Used to prove that a
 * leftover temp home genuinely holds nothing of ours: asserting "our package
 * directory is absent" only means anything if the walk could have found it, so
 * the caller pairs the two.
 */
function listTree(dir, limit = 4000) {
  if (!existsSync(dir)) return []
  const found = []
  const stack = [dir]
  while (stack.length && found.length < limit) {
    const current = stack.pop()
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      found.push(e.name)
      if (found.length >= limit) break
      if (e.isDirectory() && !e.isSymbolicLink()) stack.push(join(current, e.name))
    }
  }
  return found
}


/** Create a directory to prove the filesystem will accept writes there. */
function canCreateUnder(dir) {
  const probe = join(dir, `.e3-writable-${Date.now()}`)
  try {
    mkdirSync(probe, { recursive: true })
    rmSync(probe, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

// ------------------------------------------------------------------- findings
const steps = []
const controls = []
const note = (id, title, ok, detail) => steps.push({ id, title, ok, detail })
const ctrl = (id, title, ok, detail) => controls.push({ id, title, ok, detail })

async function main() {
  const dshBin = resolveDshBin()
  if (!dshBin) {
    console.error('E3: cannot find a DSH CLI. Pass --dsh-bin <path/to/dsh/lib/bin.js>.')
    return 2
  }
  if (!entryId) {
    console.error('E3: could not read the entry id from cordis.patch.yml — the contract changed.')
    return 2
  }

  const hostVersion = (await run(process.execPath, [dshBin, '--version'])).out.trim().split(/\r?\n/)[0]
  log('=== E3 acceptance on a disposable profile ===')
  log(`plugin   : ${pluginName}@${pluginVersion}`)
  log(`entry id : ${entryId}`)
  log(`dsh host : ${hostVersion}   (${dshBin})`)

  // ------------------------------------------------------------- E3.1 temp home
  const home = mkdtempSync(join(tmpdir(), 'dsh-e3-'))
  const env = { DSH_HOME: home }
  log(`\n[E3.1] disposable DSH_HOME = ${home}`)
  note('E3.1', 'disposable DSH_HOME created', existsSync(home), home)

  // --------------------------------------------------- E3.2 profile from template
  log('\n[E3.2] initialize the profile from the shipped web template')
  const init = await run(process.execPath, [dshBin, '--profile', 'e3', '--from-default-profile', 'web', '--dump-config'], {
    env,
    timeoutMs: 180000,
  })
  const initClean = init.code === 0 && !init.out.includes(entryId)
  log(`    exit = ${init.code}   lines = ${init.out.split(/\r?\n/).length}   plugin entry present = ${init.out.includes(entryId)} (want false)`)
  note('E3.2', 'profile composes from the shipped web template without the plugin', initClean, `exit ${init.code}`)

  // ------------------------------------------------------ E3.3 stage the artifact
  let source = OPT.source
  let packedFile = ''
  let staged = ''
  if (!source) {
    const pack = await runNpm(['pack', '--silent'], { timeoutMs: 300000 })
    packedFile = tail(pack.out, 1)
    if (pack.code !== 0 || !packedFile || !existsSync(join(root, packedFile))) {
      log(`    npm pack failed (exit ${pack.code}) — pass --source <spec> to test a given artifact`)
      return 2
    }
    source = join(root, packedFile)
    log(`\n[E3.3] packed the local build -> ${packedFile}`)
  } else {
    log(`\n[E3.3] source = ${source}`)
  }

  let installSpec = source
  const needsStaging = source.includes(' ') || existsSync(source)
  if (needsStaging) {
    if (!existsSync(source)) {
      log(`    source does not exist: ${source}`)
      return 2
    }
    staged = join(home, `artifact${source.endsWith('.tgz') ? '.tgz' : ''}`)
    copyFileSync(source, staged)
    installSpec = staged
  }
  log(`    install spec = ${installSpec}`)
  note(
    'E3.3',
    'artifact placed on a space-free path (dsh re-splits its argument on whitespace)',
    !installSpec.includes(' '),
    installSpec,
  )

  // -------------------------------------------------------------- E3.4 install
  log(`\n[E3.4] dsh plugin --profile e3 add ${installSpec}`)
  const install = await run(process.execPath, [dshBin, 'plugin', '--profile', 'e3', 'add', installSpec], {
    env,
    timeoutMs: OPT.installTimeoutMs,
  })
  log(`    exit = ${install.code}${install.timedOut ? ' (timed out)' : ''}   ${tail(install.out, 2)}`)
  note('E3.4', 'install into the disposable profile exits 0', install.code === 0, `exit ${install.code}`)

  const installedDir = join(home, 'profiles', 'e3', 'node_modules', pluginName)
  let installedVersion = ''
  if (existsSync(join(installedDir, 'package.json'))) {
    installedVersion = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')).version
  }
  log(`\n[E3.5] installed copy reports ${installedVersion || '(missing)'}, wanted ${pluginVersion}`)
  note('E3.5', 'installed copy matches the requested version', installedVersion === pluginVersion, installedVersion || '(missing)')

  // --------------------------------------------------------------- E3.6 config
  log(`\n[E3.6] dsh --profile e3 --dump-config carries entry id "${entryId}"`)
  const dump = await run(process.execPath, [dshBin, '--profile', 'e3', '--dump-config'], { env, timeoutMs: 180000 })
  const hasEntry = dump.out.includes(entryId)
  log(`    exit = ${dump.code}   entry present = ${hasEntry}   lines = ${dump.out.split(/\r?\n/).length}`)
  note('E3.6', `composed config contains the plugin entry id (${entryId})`, hasEntry && dump.code === 0, `exit ${dump.code}`)

  // -------------------------------------------------- RC1: that check can fail
  log('\n[RC1] reverse control: a real web profile without the plugin must not show the entry id')
  const rc1 = await run(process.execPath, [dshBin, '--profile', 'rc1', '--from-default-profile', 'web', '--dump-config'], {
    env,
    timeoutMs: 180000,
  })
  const rc1Ok = rc1.code === 0 && !rc1.out.includes(entryId)
  log(`    exit = ${rc1.code}   lines = ${rc1.out.split(/\r?\n/).length}   plugin entry present = ${rc1.out.includes(entryId)} (want false)`)
  ctrl('RC1', 'control profile composes without the plugin entry id', rc1Ok, `exit ${rc1.code}`)

  // ------------------------------------------------------ RC3: bad install fails
  log('\n[RC3] reverse control: a version that does not exist must fail the same install path')
  const rc3 = await run(process.execPath, [dshBin, 'plugin', '--profile', 'rc3', 'add', `${pluginName}@0.0.0-does-not-exist`], {
    env,
    timeoutMs: OPT.installTimeoutMs,
  })
  log(`    exit = ${rc3.code} (want non-zero)`)
  ctrl('RC3', 'bogus version fails to install', rc3.code !== 0, `exit ${rc3.code}`)

  // -------------------------------------------------------- E3.7 boot + serve
  log('\n[E3.7] boot dsh web on a free port and verify it really serves')
  const boot = spawn(process.execPath, [dshBin, '--profile', 'e3', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
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
    const m = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=(\S+)/.exec(text)
    if (m && !base) {
      base = m[1]
      token = m[2]
    }
  }
  boot.stdout.on('data', onBoot)
  boot.stderr.on('data', onBoot)

  const deadline = Date.now() + OPT.bootTimeoutMs
  while (!base && Date.now() < deadline) await sleep(400)

  if (base) {
    let cookie = ''
    try {
      const r = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
      const setCookie = r.headers.get('set-cookie') || ''
      if (setCookie) cookie = setCookie.split(';')[0]
    } catch {}
    let served = false
    let manifestHasPlugin = false
    let clientAssetOk = false
    if (cookie) {
      try {
        const r = await fetch(`${base}/`, { headers: { cookie } })
        const html = (await r.text()).replace(/&amp;/g, '&')
        served = r.status === 200 && html.length > 0
        const m = new RegExp(`"id":"${pluginName}"[^}]*?"url":"([^"]+)"`).exec(html)
        manifestHasPlugin = Boolean(m)
        if (m) {
          // The manifest URL is relative on 0.2.x (`plugins/??<name>/client.js&rev=...`)
          // and was site-absolute earlier, so it must be resolved against the
          // base rather than concatenated — `${base}${url}` silently produced
          // `http://host:portplugins/...`, a URL that fails to parse.
          const asset = await fetch(new URL(m[1], `${base}/`).href, { headers: { cookie } })
          clientAssetOk = asset.status === 200 && (await asset.arrayBuffer()).byteLength > 0
        }
      } catch {}
    }
    log(`    shell 200 = ${served}   client manifest lists ${pluginName} = ${manifestHasPlugin}   client asset 200 = ${clientAssetOk}`)
    note('E3.7', 'web boot answers 200 and serves the plugin client module', served && manifestHasPlugin && clientAssetOk, base)

    log('\n[RC2] reverse control: a bogus token must not yield 200 + cookie')
    let rc2Ok = false
    try {
      const r = await fetch(`${base}/?token=bogus-token-e3`, { redirect: 'manual' })
      rc2Ok = !(r.status === 200 && r.headers.get('set-cookie'))
    } catch {
      rc2Ok = true
    }
    log(`    rejected = ${rc2Ok}`)
    ctrl('RC2', 'bogus token rejected by the auth fence', rc2Ok, '')
  } else {
    log('    no startup line within the timeout; boot log tail:')
    log(tail(bootLog, 12))
    note('E3.7', 'web boot answers 200 and serves the plugin client module', false, 'no startup line')
  }

  try { boot.kill() } catch {}
  await sleep(600)
  try { boot.kill('SIGKILL') } catch {}

  // ------------------------------------------------------------ E3.8 uninstall
  log(`\n[E3.8] dsh plugin --profile e3 remove ${pluginName}`)
  const remove = await run(process.execPath, [dshBin, 'plugin', '--profile', 'e3', 'remove', pluginName], {
    env,
    timeoutMs: OPT.installTimeoutMs,
  })
  const gone = !existsSync(installedDir)
  log(`    exit = ${remove.code}   directory gone = ${gone}`)
  note('E3.8', 'uninstall exits 0 and removes the plugin directory', remove.code === 0 && gone, `exit ${remove.code}`)

  // -------------------------------------------------------------- E3.9 cleanup
  await sleep(400)

  // E3.9 answers the question the disposable home exists for: *is this run
  // leaving anything of ours behind?*
  //
  // It deliberately does **not** answer it by asserting that Node removed the
  // temp root. A delete of ~600 scratch files can fail for reasons that say
  // nothing about the plugin, and a check that cannot pass is worse than no
  // check: it buries the real signal and trains the reader to ignore a red E3.
  //
  // So the removal is attempted, and the verdict rests on what actually remains
  // inside the home. An inability to delete temp files is reported as a note,
  // never as a failure of the plugin.
  const profileNodeModules = join(home, 'profiles', 'node_modules')
  const treeEntries = countEntries(home)

  const cleaned = OPT.keep
    ? { gone: false, error: '--keep' }
    : removeTree(home)

  const ourDirLeft = existsSync(installedDir)
  const rc1DirLeft = existsSync(join(home, 'profiles', 'rc1'))
  const rc3DirLeft = existsSync(join(home, 'profiles', 'rc3'))
  const storeChildren = cleaned.gone ? [] : childNames(profileNodeModules)
  const storeWritable = cleaned.gone ? true : canCreateUnder(profileNodeModules)
  const leftovers = cleaned.gone ? 0 : countEntries(home)

  // A leftover tree is only "not ours" if a full walk agrees. Pairing the walk
  // with the per-path probes keeps "our directory is absent" from being a
  // statement about a directory the walk could never have reached.
  const tree = cleaned.gone ? [] : listTree(home)
  const treeHoldsOurs = tree.includes(pluginName)

  // Anything of ours, and any control profile the run itself created, is a hard
  // failure. A surviving shared store is not — it holds none of our files.
  const residue = []
  if (ourDirLeft || treeHoldsOurs) residue.push('our own package directory')
  if (rc1DirLeft) residue.push('the rc1 control profile')
  if (rc3DirLeft) residue.push('the rc3 control profile')
  if (!storeWritable) residue.push('shared store is not writable, so the home is not reusable')

  log(
    `\n[E3.9] temp root removed = ${cleaned.gone}${OPT.keep ? ' (--keep)' : ''}` +
      `\n        home held ${treeEntries} file(s) under profiles/ + storages/` +
      `\n        our package dir left = ${ourDirLeft}   rc1 left = ${rc1DirLeft}   rc3 left = ${rc3DirLeft}`,
  )
  if (!cleaned.gone && !OPT.keep) {
    log(
      `        node removal = ${cleaned.error ? `error: ${cleaned.error}` : 'no error reported'}` +
        `\n        ${leftovers} file(s) remain   store entries left = ${storeChildren.length}   store writable = ${storeWritable}` +
        `\n        a walk over the leftovers names ${pluginName} = ${treeHoldsOurs} (want false)`,
    )
  }
  if (residue.length > 0) log(`        residue: ${residue.join('; ')}`)

  note(
    'E3.9',
    'nothing of ours survives the run (profiles left behind must be ours: none)',
    OPT.keep || residue.length === 0,
    OPT.keep
      ? `${home} (--keep)`
      : residue.length > 0
        ? residue.join('; ')
        : cleaned.gone
          ? `temp root removed cleanly (${treeEntries} file(s)): ${home}`
          : `temp root left ${leftovers} scratch file(s) that contain nothing of ours — ` +
            (cleaned.error ?? 'removal incomplete') +
            `; delete it by hand if you want the space back: ${home}`,
  )

  if (packedFile) {
    try { rmSync(join(root, packedFile), { force: true }) } catch {}
  }

  return { code: steps.every((s) => s.ok) && controls.every((c) => c.ok) ? 0 : 1, hostVersion }
}

let verdict = { code: 2, hostVersion: '' }
try {
  verdict = await main()
} catch (e) {
  log(`E3: unexpected failure — ${e && e.stack ? e.stack : e}`)
}

console.log(`\n=== verdict: ${verdict.code === 0 ? 'PASS' : 'FAIL'} ===`)
for (const s of steps) console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${s.id}  ${s.title}`)
console.log('  --- reverse controls ---')
for (const c of controls) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

if (OPT.json) {
  const evidence = {
    plugin: `${pluginName}@${pluginVersion}`,
    dshHost: verdict.hostVersion,
    entryId,
    steps,
    controls,
    verdict: verdict.code === 0 ? 'PASS' : 'FAIL',
    at: new Date().toISOString(),
  }
  const target = resolve(OPT.json)
  writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`\nevidence written to ${target}`)
}

process.exitCode = verdict.code
