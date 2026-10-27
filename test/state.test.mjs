import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { LIMIT, PIN_STATE, addPin, pinnedSources, pinsOnBranch, snapshot } from '../src/state.ts';

const usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const save = (sm, ids) => sm.appendCustomEntry(PIN_STATE, snapshot(ids));
const pins = sm => pinsOnBranch(sm.getBranch());
const resolved = sm => pinnedSources(sm.getBranch()).map(source => source.text);
const reopen = sm => SessionManager.open(sm.getSessionFile(), sm.getSessionDir());
const dirs = [];
const scratch = prefix => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
after(() => { for (const dir of dirs) rmSync(dir, {recursive: true, force: true}); });

function session(answers) {
  const dir = scratch('pins-state-');
  const sm = SessionManager.create(dir, dir);
  const ids = [];
  for (let i = 1; i <= answers; i++) {
    sm.appendMessage({role:'user',content:`Question ${i}`,timestamp:Date.now()});
    ids.push(sm.appendMessage({role:'assistant',content:[{type:'text',text:`# Answer ${i}\n\nFull answer ${i}.`}],api:'fixture',provider:'fixture',model:'fixture',stopReason:'stop',usage,timestamp:Date.now()}));
  }
  return {sm, ids};
}

// Keep the Pi 1.3 fixture byte-for-byte to test compatibility independently of the current writer.
function legacy() {
  const dir = scratch('pins-legacy-');
  const file = join(dir, 'legacy-pins.jsonl');
  copyFileSync(new URL('./fixtures/legacy-pins.jsonl', import.meta.url), file);
  const sm = SessionManager.open(file, dir);
  return {sm, snapshots: sm.getEntries().filter(entry => entry.type === 'custom' && entry.customType === PIN_STATE)};
}
// Extension messages, tool results, compactions and branch summaries are no longer pinnable.
const legacyPins = [
  ['# Migration plan\n\nKeep reads stable.', 'What fails first?'],
  ['First block.\n\nSecond block.', 'git status --short\nM state.ts'],
  [],
  [],
  ['# Migration plan\n\nKeep reads stable.', '# Other path\n\nUse a snapshot.'],
];

test('legacy session resolves each recorded snapshot on its own branch', () => {
  const {sm, snapshots} = legacy();
  assert.equal(snapshots.length, legacyPins.length);
  assert.deepEqual(resolved(sm), legacyPins.at(-1));
  for (const [index, entry] of snapshots.entries()) {
    sm.branch(entry.id);
    assert.deepEqual(resolved(sm), legacyPins[index]);
  }
  sm.branch(snapshots[2].parentId);
  assert.deepEqual(resolved(sm), legacyPins[1], 'rewinding past a snapshot restores the earlier pins');
  sm.branch(snapshots[0].parentId);
  assert.deepEqual(resolved(sm), []);
});

test('a fork copies membership at the fork point and then changes independently', () => {
  const {sm, snapshots} = legacy();
  const child = reopen(sm);
  assert.notEqual(child.createBranchedSession(snapshots[1].id), sm.getSessionFile());
  assert.deepEqual(resolved(child), legacyPins[1]);
  save(child, []);
  assert.deepEqual(resolved(reopen(child)), []);
  const parent = reopen(sm);
  assert.deepEqual(resolved(parent), legacyPins.at(-1));
  parent.branch(snapshots[1].id);
  assert.deepEqual(resolved(parent), legacyPins[1]);
  const early = reopen(sm);
  early.createBranchedSession(snapshots[0].parentId);
  assert.deepEqual(resolved(early), []);
});

test('pins resolve in branch order without unavailable IDs, and a full set needs a replacement to add', () => {
  const {sm, ids} = session(LIMIT + 1);
  const stored = ids.slice(0, LIMIT), incoming = ids.at(-1);
  save(sm, ['not-on-this-branch', ...stored].reverse());
  assert.deepEqual(pins(reopen(sm)), stored);
  assert.deepEqual(addPin(stored, stored[0]), stored);
  assert.throws(() => addPin(stored, incoming), /Choose/);
  assert.deepEqual(addPin(stored, incoming, stored[1]), [stored[0], incoming, ...stored.slice(2)]);
});

test('clearing persists, repinning after a rewind is a sibling event, and earlier snapshots stay unchanged', () => {
  const {sm, ids} = session(2);
  const original = save(sm, [ids[0]]);
  const stored = JSON.stringify(sm.getEntry(original));
  pins(sm).push(ids[1]);
  save(sm, []);
  assert.deepEqual(pins(reopen(sm)), []);
  sm.branch(ids[0]);
  const repin = save(sm, addPin(pins(sm), ids[0]));
  assert.equal(sm.getEntry(repin).parentId, ids[0]);
  sm.branch(original);
  assert.deepEqual(pins(sm), [ids[0]]);
  assert.equal(JSON.stringify(sm.getEntry(original)), stored);
});

test('pins whose sources are compacted out of context remain pinned, and pin data stays out of context', () => {
  const {sm, ids} = session(4);
  save(sm, ids.slice(0, 3));
  sm.appendCompaction('Synthetic summary', ids[3], 10000);
  assert.deepEqual(pins(reopen(sm)), ids.slice(0, 3));
  assert(!JSON.stringify(sm.buildSessionContext().messages).includes(PIN_STATE));
});

test('an invalid or unknown latest snapshot is rejected without falling back to an earlier one', () => {
  const {sm, ids} = session(1);
  const valid = save(sm, [ids[0]]);
  for (const data of [undefined, {}, {version: 2, ids: [ids[0]]}, {version: '1', ids: [ids[0]]}, {version: 1, ids: ids[0]},
    {version: 1, ids: [1]}, {version: 1, ids: [ids[0], ids[0]]}]) {
    const invalid = sm.appendCustomEntry(PIN_STATE, data);
    assert.throws(() => pins(sm), new RegExp(`Invalid pin snapshot ${invalid}`), JSON.stringify(data));
    sm.branch(valid);
    assert.deepEqual(pins(sm), [ids[0]], 'an invalid sibling does not affect the active branch');
  }
  sm.appendCustomEntry(PIN_STATE, {version: 2});
  save(sm, []);
  assert.deepEqual(pins(sm), [], 'a later valid snapshot supersedes an invalid one');
});
