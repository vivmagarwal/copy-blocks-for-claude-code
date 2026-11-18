'use strict';
// Runs extension.js against a stand-in for VS Code, so the whole path is tested without opening VS Code:
// a terminal row -> a link -> a click -> the clipboard, and the status bar button.
// What this cannot test: that VS Code really calls the link code for rows drawn by Claude Code. A person
// checks that by hand (see README, "Try it without installing").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const reply = (text, { time, uuid, cwd = '/w/project' }) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, uuid, timestamp: time, cwd, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';

/** A new stand-in VS Code and a freshly loaded extension that reads session files from a temp folder. */
function setup({ sessionText, workspaceFolders = ['/w/project'] }) {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-blocks-ext-'));
  fs.mkdirSync(path.join(config, 'projects', '-w-project'), { recursive: true });
  if (sessionText) fs.writeFileSync(path.join(config, 'projects', '-w-project', 's.jsonl'), sessionText);
  process.env.CLAUDE_CONFIG_DIR = config;

  const seen = { clipboard: null, commands: {}, provider: null, messages: [], infos: [], pickItems: null, choose: () => undefined };
  const statusItem = { text: '', tooltip: '', command: '', shown: false, show() { this.shown = true; }, dispose() {} };
  const disposable = { dispose() {} };
  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    TerminalLink: class { constructor(startIndex, length, tooltip) { Object.assign(this, { startIndex, length, tooltip }); } },
    window: {
      createStatusBarItem: () => statusItem,
      registerTerminalLinkProvider: (p) => { seen.provider = p; return disposable; },
      setStatusBarMessage: (m) => { seen.messages.push(m); return disposable; },
      showInformationMessage: async (m) => { seen.infos.push(m); },
      showQuickPick: async (items) => { seen.pickItems = items; return seen.choose(items); },
    },
    commands: { registerCommand: (id, fn) => { seen.commands[id] = fn; return disposable; } },
    env: { clipboard: { writeText: async (t) => { seen.clipboard = t; } } },
    workspace: { workspaceFolders: workspaceFolders.map((p) => ({ uri: { fsPath: p } })) },
  };

  const realLoad = Module._load;
  Module._load = (request, ...rest) => (request === 'vscode' ? vscode : realLoad(request, ...rest));
  for (const f of ['../extension.js', '../lib.js']) delete require.cache[require.resolve(f)];
  let ext;
  try { ext = require('../extension.js'); } finally { Module._load = realLoad; }

  const context = { subscriptions: [] };
  ext.activate(context);
  return { seen, statusItem, context, stop: () => context.subscriptions.forEach((d) => d.dispose()) };
}

const LONG = 'The tea is ready. Please come to the table before it gets cold, and bring the two cups from the shelf.';

test('activate: shows the status bar button and registers the link code and both commands', () => {
  const { seen, statusItem, context, stop } = setup({ sessionText: '' });
  assert.equal(statusItem.shown, true);
  assert.match(statusItem.text, /Copy block/);
  assert.equal(statusItem.command, 'copyBlocksForClaudeCode.copyNewest');
  assert.equal(typeof seen.provider.provideTerminalLinks, 'function');
  assert.deepEqual(Object.keys(seen.commands).sort(), ['copyBlocksForClaudeCode.copyNewest', 'copyBlocksForClaudeCode.pick']);
  assert.ok(context.subscriptions.length >= 4);
  stop();
});

test('a wrapped terminal row becomes a link, and a click puts the whole block on the clipboard as written', async () => {
  const { seen, stop } = setup({ sessionText: reply(`Say this:\n\n\`\`\`\n${LONG}\n\`\`\``, { time: '2026-01-02T00:00:00.000Z', uuid: 'a' }) });
  const row = '  cold, and bring the two cups from the shelf.';
  const links = await seen.provider.provideTerminalLinks({ line: row, terminal: {} });
  assert.equal(links.length, 1);
  assert.equal(links[0].startIndex, 2, 'the link starts after the indent');
  assert.equal(links[0].length, row.trim().length);
  assert.match(links[0].tooltip, /^Copy code block: The tea is ready/);

  await seen.provider.handleTerminalLink(links[0]);
  assert.equal(seen.clipboard, LONG);
  assert.equal(seen.clipboard.includes('\n'), false, 'no line break was added');
  assert.match(seen.messages[0], /^Copied 102 characters: The tea is ready/);
  stop();
});

test('rows that are not part of a code block get no link', async () => {
  const { seen, stop } = setup({ sessionText: reply(`\`\`\`\n${LONG}\n\`\`\``, { time: '2026-01-02T00:00:00.000Z', uuid: 'a' }) });
  assert.deepEqual(await seen.provider.provideTerminalLinks({ line: '  I saved this as a memory note.', terminal: {} }), []);
  assert.deepEqual(await seen.provider.provideTerminalLinks({ line: '', terminal: {} }), []);
  stop();
});

test('status bar button: one block in the newest reply is copied at once', async () => {
  const { seen, statusItem, stop } = setup({ sessionText:
    reply('```\nolder block\n```', { time: '2026-01-01T00:00:00.000Z', uuid: 'a' }) +
    reply('```\nnewest block\n```', { time: '2026-01-02T00:00:00.000Z', uuid: 'b' }) });
  await seen.commands['copyBlocksForClaudeCode.copyNewest']();
  assert.equal(seen.clipboard, 'newest block');
  assert.equal(seen.pickItems, null, 'no list was shown');
  assert.match(statusItem.text, /Copied/);
  stop();
});

test('status bar button: several blocks in the newest reply open a list, newest reply first', async () => {
  const { seen, stop } = setup({ sessionText:
    reply('```\nolder block\n```', { time: '2026-01-01T00:00:00.000Z', uuid: 'a' }) +
    reply('Pick one:\n```\nversion one\n```\nor\n```\nversion two\n```', { time: '2026-01-02T00:00:00.000Z', uuid: 'b' }) });
  seen.choose = (items) => items.find((i) => i.label === 'version two');
  await seen.commands['copyBlocksForClaudeCode.copyNewest']();
  const labels = seen.pickItems.filter((i) => i.block).map((i) => i.label);
  assert.deepEqual(labels, ['version one', 'version two', 'older block']);
  assert.equal(seen.pickItems.filter((i) => !i.block).length, 1, 'one divider, between the two replies');
  assert.equal(seen.clipboard, 'version two');
  stop();
});

test('the list command: closing the list copies nothing', async () => {
  const { seen, stop } = setup({ sessionText: reply('```\nonly block\n```', { time: '2026-01-02T00:00:00.000Z', uuid: 'a' }) });
  await seen.commands['copyBlocksForClaudeCode.pick']();
  assert.equal(seen.pickItems.length, 1);
  assert.equal(seen.clipboard, null);
  stop();
});

test('no session files: the button says so and copies nothing', async () => {
  const { seen, stop } = setup({ sessionText: '' });
  await seen.commands['copyBlocksForClaudeCode.copyNewest']();
  assert.equal(seen.clipboard, null);
  assert.match(seen.infos[0], /No code block found/);
  stop();
});

test('a window whose folder has no Claude Code session uses blocks from any folder', async () => {
  const { seen, stop } = setup({ workspaceFolders: ['/somewhere/else'],
    sessionText: reply('```\nfrom another folder\n```', { time: '2026-01-02T00:00:00.000Z', uuid: 'a' }) });
  await seen.commands['copyBlocksForClaudeCode.copyNewest']();
  assert.equal(seen.clipboard, 'from another folder');
  stop();
});
