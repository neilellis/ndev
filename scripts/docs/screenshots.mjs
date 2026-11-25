import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const hash = value => createHash('sha256').update(value).digest('hex')
const [mode, filename, ...extra] = process.argv.slice(2)
let lock

try {
  if (!['check', 'refresh'].includes(mode) || !filename || extra.length) throw new Error('Usage: node screenshots.mjs <check|refresh> <manifest.json>')
  const manifestPath = realpathSync(filename)
  const root = dirname(manifestPath)
  const repair = `node ${JSON.stringify(process.argv[1])} refresh ${JSON.stringify(filename)}`
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const list = value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim())
  if (manifest.version !== 1 || !Array.isArray(manifest.captures) || !manifest.captures.length) throw new Error(`${filename}: expected version 1 and nonempty captures`)
  const inside = path => path === root || (!relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== '..' && !isAbsolute(relative(root, path)))
  const pathFor = name => {
    if (isAbsolute(name) || !inside(resolve(root, name))) throw new Error(`${name}: paths must stay inside ${root}`)
    const path = resolve(root, name)
    let ancestor = path
    while (!existsSync(ancestor)) ancestor = dirname(ancestor)
    if (!inside(realpathSync(ancestor))) throw new Error(`${name}: symlink escapes ${root}`)
    return path
  }
  const ids = new Set()
  const outputs = new Set()
  for (const capture of manifest.captures) {
    if (!capture || typeof capture.id !== 'string' || !capture.id.trim() || ids.has(capture.id) || !list(capture.inputs) || !list(capture.command) || !list(capture.outputs)) throw new Error(`${filename}: each capture needs a unique id and nonempty inputs, command and outputs arrays`)
    ids.add(capture.id)
    for (const output of capture.outputs) {
      const path = pathFor(output)
      if (!output.endsWith('.png') || outputs.has(path) || path === manifestPath) throw new Error(`${capture.id}: output ${output} must be a unique PNG path`)
      outputs.add(path)
    }
    capture.inputs.forEach(pathFor)
  }
  const receiptPath = `${manifestPath}.receipt.json`
  const lockPath = `${receiptPath}.lock`
  try { mkdirSync(lockPath) } catch (error) {
    throw new Error(`${filename}: cannot lock screenshots at ${lockPath} (${error.code}); wait for the other capture, or remove the lock after confirming no capture is running`)
  }
  lock = lockPath
  const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : { version: 1, captures: {} }
  if (receipt.version !== 1 || !receipt.captures || typeof receipt.captures !== 'object' || Array.isArray(receipt.captures)) throw new Error(`${receiptPath}: invalid receipt; remove it and run ${repair}`)
  const save = () => {
    const temporary = `${receiptPath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`)
    renameSync(temporary, receiptPath)
  }
  const fingerprint = capture => {
    const files = []
    const visit = path => {
      if (!existsSync(path)) throw new Error(`${capture.id}: input ${relative(root, path)} is missing; restore it or update ${filename}`)
      if (lstatSync(path).isSymbolicLink()) throw new Error(`${capture.id}: input ${relative(root, path)} is a symlink; list its real source instead`)
      if (outputs.has(path) || path === receiptPath || path === manifestPath) throw new Error(`${capture.id}: generated output or manifest ${relative(root, path)} cannot be an input`)
      if (lstatSync(path).isDirectory()) {
        files.push([relative(root, path), 'directory'])
        for (const name of readdirSync(path).sort()) visit(resolve(path, name))
      } else if (lstatSync(path).isFile()) files.push([relative(root, path), hash(readFileSync(path))])
      else throw new Error(`${capture.id}: input ${relative(root, path)} is not a regular file`)
    }
    for (const input of [...capture.inputs].sort()) visit(pathFor(input))
    return hash(JSON.stringify({ version: 1, manifest: hash(readFileSync(manifestPath)), capture, files }))
  }
  const artifacts = capture => Object.fromEntries(capture.outputs.map(name => {
    const path = pathFor(name)
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`${capture.id}: screenshot ${name} is missing or not a regular file`)
    const bytes = readFileSync(path)
    if (bytes.length < 45 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13 || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)) throw new Error(`${capture.id}: screenshot ${name} has an invalid PNG header`)
    let offset = 8
    let image = false
    let ended = false
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset)
      const type = bytes.toString('ascii', offset + 4, offset + 8)
      offset += size + 12
      if (offset > bytes.length) break
      if (type === 'IDAT' && size > 0) image = true
      if (type === 'IEND' && size === 0) { ended = true; break }
    }
    if (!image || !ended || offset !== bytes.length) throw new Error(`${capture.id}: screenshot ${name} has incomplete PNG chunks`)
    return [name, hash(bytes)]
  }))
  let stale = false
  for (const capture of manifest.captures) {
    const input = fingerprint(capture)
    let reason
    const previous = Object.hasOwn(receipt.captures, capture.id) ? receipt.captures[capture.id] : undefined
    try {
      const output = artifacts(capture)
      if (!previous) reason = 'capture receipt missing'
      else if (previous.input !== input) reason = 'source inputs or capture settings changed'
      else if (JSON.stringify(previous.outputs) !== JSON.stringify(output)) reason = 'screenshot bytes changed'
    } catch (error) { reason = error.message }
    if (!reason) { console.log(`${capture.id}: current`); continue }
    if (mode === 'check') {
      console.error(`${capture.id}: ${reason}; run ${repair}`)
      stale = true
      continue
    }
    delete receipt.captures[capture.id]
    save()
    for (const name of capture.outputs) rmSync(pathFor(name), { force: true })
    const result = spawnSync(capture.command[0], capture.command.slice(1), { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.error || result.status !== 0) throw new Error(`${capture.id}: command ${JSON.stringify(capture.command)} failed (exit ${result.status}, signal ${result.signal ?? 'none'}): ${result.error?.message ?? 'see command output above'}; repair the capture command and run ${repair}`)
    const output = artifacts(capture)
    if (fingerprint(capture) !== input) throw new Error(`${capture.id}: inputs changed during capture; run ${repair}`)
    Object.defineProperty(receipt.captures, capture.id, { value: { input, outputs: output }, enumerable: true, configurable: true, writable: true })
    save()
    console.log(`${capture.id}: refreshed`)
  }
  if (stale) process.exitCode = 1
} catch (error) {
  console.error(error.message)
  if (mode === 'refresh' && filename) console.error(`After repairing the failure, run node ${JSON.stringify(process.argv[1])} refresh ${JSON.stringify(filename)}`)
  process.exitCode = 1
} finally {
  if (lock) rmSync(lock, { recursive: true })
}
