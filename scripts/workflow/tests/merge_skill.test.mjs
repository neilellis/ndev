// The merge skill is what an agent follows after the merge, so its text is the behaviour.
// Run: node --test scripts/workflow/tests/merge_skill.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const skill = readFileSync(join(ROOT, 'skills', 'merge', 'SKILL.md'), 'utf8')
const step6 = skill.slice(skill.indexOf('\n6. '), skill.indexOf('\n7. '))

test('the merge skill has a path for a listed migration older than one on the remote', () => {
  assert.match(step6, /inserted before the last migration/, 'step 6 does not name the refusal of supabase db push')
  assert.match(step6, /supabase db push --include-all --dry-run/, 'step 6 does not check what --include-all would apply')
  assert.match(step6, /supabase db push --include-all`/, 'step 6 does not run supabase db push --include-all')
})

test('the merge skill uses --include-all only after the plain push refuses, and only for listed files', () => {
  const plain = step6.indexOf('`supabase db push`')
  const refusal = step6.indexOf('inserted before the last migration')
  assert.ok(plain !== -1, 'step 6 no longer runs a plain supabase db push')
  assert.ok(plain < refusal && refusal < step6.indexOf('--include-all'), 'step 6 must try the plain push and read its refusal before --include-all')
  assert.match(step6, /--dry-run`[^.]*\.[^.]*does not list[^.]*stop and ask/i, 'step 6 must stop when --include-all would apply a file that this PR does not list')
})
