'use strict';
// Run: node --test   (from the extension folder)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionStore, extractBlocks, findBlockForRow, squash, preview } = require('../lib');

const block = (text, time = 1) => ({ text, squashed: squash(text), time, order: 0, reply: `r${time}`, cwd: '/w', file: 'f' });

/** One line of a session file, as Claude Code writes it. */
const reply = (text, { time = '2026-01-02T03:04:05.000Z', uuid = 'u1', cwd = '/w/project', sidechain = false } = {}) =>
  JSON.stringify({ type: 'assistant', isSidechain: sidechain, uuid, timestamp: time, cwd, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-blocks-'));
  fs.mkdirSync(path.join(root, '-w-project'));
  return { root, file: path.join(root, '-w-project', 'session.jsonl') };
}
const store = (root) => new SessionStore({ root, readEveryMs: 0, listEveryMs: 0 });

test('extractBlocks: a plain block keeps its text exactly', () => {
  const md = 'Say this:\n\n```\nThe tea is ready. Please come to the table before it gets cold.\n```\n\nDone.';
  assert.deepEqual(extractBlocks(md), [{ lang: '', text: 'The tea is ready. Please come to the table before it gets cold.' }]);
});

test('extractBlocks: language, several blocks, blank lines inside', () => {
  const md = '```bash\nnpm test\n```\ntext\n```js\nconst a = 1;\n\nconst b = 2;\n```';
  assert.deepEqual(extractBlocks(md), [{ lang: 'bash', text: 'npm test' }, { lang: 'js', text: 'const a = 1;\n\nconst b = 2;' }]);
});

test('extractBlocks: a block inside a list item loses the item indent, not its own', () => {
  const md = '1. Run this:\n\n   ```\n   if (x) {\n     go();\n   }\n   ```\n\n2. Next';
  assert.deepEqual(extractBlocks(md), [{ lang: '', text: 'if (x) {\n  go();\n}' }]);
});

test('extractBlocks: tilde fences, a longer fence holding a shorter one, inline code is not a block', () => {
  assert.deepEqual(extractBlocks('~~~\na\n~~~'), [{ lang: '', text: 'a' }]);
  assert.deepEqual(extractBlocks('````md\n```\ninner\n```\n````'), [{ lang: 'md', text: '```\ninner\n```' }]);
  assert.deepEqual(extractBlocks('Use ```npm test``` here.\nNo block.'), []);
});

test('extractBlocks: a block that was never closed runs to the end; an empty block is dropped', () => {
  assert.deepEqual(extractBlocks('```\nhalf written'), [{ lang: '', text: 'half written' }]);
  assert.deepEqual(extractBlocks('```\n\n```'), []);
});

test('findBlockForRow: each wrapped and indented screen row finds its block', () => {
  const b = block('The tea is ready. Please come to the table before it gets cold, and bring the two cups from the shelf.');
  // what the terminal shows: two-space indent, the line broken between words
  assert.equal(findBlockForRow('  The tea is ready. Please come to the table before it gets', [b]), b);
  assert.equal(findBlockForRow('  cold, and bring the two cups from the shelf.   ', [b]), b);
});

test('findBlockForRow: a row from a block of several lines, and a short row such as "}"', () => {
  const b = block('function go() {\n\treturn 1;\n}');
  assert.equal(findBlockForRow('    return 1;', [b]), b);
  assert.equal(findBlockForRow('  }', [b]), b);
});

test('findBlockForRow: prose that is not in a block, a part of a word, and an empty row give nothing', () => {
  const b = block('The tea is ready. Please come to the table.');
  assert.equal(findBlockForRow('  I saved this as a memory note.', [b]), null);
  assert.equal(findBlockForRow('  tea is rea', [b]), null); // ends inside the word "ready"
  assert.equal(findBlockForRow('     ', [b]), null);
});

test('findBlockForRow: a very long word cut by the terminal still matches', () => {
  const url = 'https://example.com/' + 'a'.repeat(120);
  const b = block(`Open ${url} now`);
  assert.equal(findBlockForRow('  ' + url.slice(0, 80), [b]), b); // ends inside the address
  assert.equal(findBlockForRow('  ' + url.slice(80) + ' now', [b]), b); // starts inside the address
});

test('findBlockForRow: when two blocks hold the row, the newest (first in the list) wins', () => {
  const newer = block('npm test', 2);
  const older = block('npm test', 1);
  assert.equal(findBlockForRow('  npm test', [newer, older]), newer);
});

test('preview: first line with text, cut short', () => {
  assert.equal(preview(block('\n  first line here\nsecond')), 'first line here');
  assert.equal(preview(block('x'.repeat(100)), 10), 'x'.repeat(9) + '…');
});

test('SessionStore: reads blocks from a session file, newest reply first, with the folder it was started in', async () => {
  const { root, file } = tempRoot();
  fs.writeFileSync(file,
    JSON.stringify({ type: 'user', message: { content: 'hello ``` not a reply' } }) + '\n' +
    reply('Old one:\n```\nold block\n```', { time: '2026-01-01T00:00:00.000Z', uuid: 'a' }) +
    reply('Two here:\n```\nfirst\n```\nand\n```\nsecond\n```', { time: '2026-01-02T00:00:00.000Z', uuid: 'b' }));
  const s = store(root);
  await s.refresh();
  assert.deepEqual(s.blocks().map((b) => b.text), ['first', 'second', 'old block']);
  assert.equal(s.blocks()[0].cwd, '/w/project');
  assert.equal(s.blocks()[0].reply, 'b');
});

test('SessionStore: skips helper-agent text, broken lines and replies without a block', async () => {
  const { root, file } = tempRoot();
  fs.writeFileSync(file,
    reply('```\nfrom a helper agent\n```', { sidechain: true }) +
    '{ this line is not JSON ``` "assistant"\n' +
    reply('No block in this reply.') +
    reply('```\nkept\n```'));
  const s = store(root);
  await s.refresh();
  assert.deepEqual(s.blocks().map((b) => b.text), ['kept']);
});

test('SessionStore: picks up lines added later, and waits for a line that is still being written', async () => {
  const { root, file } = tempRoot();
  fs.writeFileSync(file, reply('```\none\n```', { time: '2026-01-01T00:00:00.000Z', uuid: 'a' }));
  const s = store(root);
  await s.refresh();
  assert.deepEqual(s.blocks().map((b) => b.text), ['one']);

  const next = reply('```\ntwo, with an accent: café\n```', { time: '2026-01-02T00:00:00.000Z', uuid: 'b' });
  const bytes = Buffer.from(next);
  const cut = bytes.indexOf(Buffer.from('é')) + 1; // stop in the middle of the two-byte letter é
  fs.appendFileSync(file, bytes.subarray(0, cut));
  await s.refresh();
  assert.deepEqual(s.blocks().map((b) => b.text), ['one'], 'half a line is not used');

  fs.appendFileSync(file, bytes.subarray(cut));
  await s.refresh();
  assert.deepEqual(s.blocks().map((b) => b.text), ['two, with an accent: café', 'one']);
});

test('SessionStore: starts again when a session file is written afresh', async () => {
  const { root, file } = tempRoot();
  fs.writeFileSync(file, reply('```\na long first version of the file\n```') + reply('```\nmore\n```', { uuid: 'x2' }));
  const s = store(root);
  await s.refresh();
  fs.writeFileSync(file, reply('```\nnew\n```'));
  await s.refresh();
  assert.deepEqual(s.blocks().map((b) => b.text), ['new']);
});

test('SessionStore: "under" keeps only sessions started inside those folders; old files are ignored', async () => {
  const { root, file } = tempRoot();
  fs.writeFileSync(file, reply('```\nin project\n```', { cwd: '/w/project/sub' }));
  fs.mkdirSync(path.join(root, '-w-other'));
  fs.writeFileSync(path.join(root, '-w-other', 's.jsonl'), reply('```\nin other\n```', { cwd: '/w/other', time: '2026-01-03T00:00:00.000Z' }));
  fs.mkdirSync(path.join(root, '-w-projectile'));
  fs.writeFileSync(path.join(root, '-w-projectile', 's.jsonl'), reply('```\nname only starts the same\n```', { cwd: '/w/projectile' }));
  const old = path.join(root, '-w-other', 'old.jsonl');
  fs.writeFileSync(old, reply('```\nten days old\n```', { cwd: '/w/other' }));
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  fs.utimesSync(old, tenDaysAgo, tenDaysAgo);

  const s = store(root);
  await s.refresh();
  assert.deepEqual(s.blocks().map((b) => b.text).sort(), ['in other', 'in project', 'name only starts the same']);
  assert.deepEqual(s.blocks({ under: ['/w/project'] }).map((b) => b.text), ['in project']);
  assert.deepEqual(s.blocks({ under: ['/nowhere'] }), []);
});

test('SessionStore: a missing projects folder gives no blocks and no error', async () => {
  const s = store(path.join(os.tmpdir(), 'copy-blocks-does-not-exist'));
  await s.refresh();
  assert.deepEqual(s.blocks(), []);
});
