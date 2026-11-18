'use strict';
// Copy Blocks for Claude Code: the VS Code side. Two ways to copy a code block from Claude Code's
// replies as it was written, without the line breaks and spaces the terminal adds:
//   1. In the terminal, hold Cmd (Ctrl on Windows and Linux) and click anywhere on a code block.
//   2. Click "Copy block" in the status bar at the bottom of the window.
const vscode = require('vscode');
const { SessionStore, findBlockForRow, preview } = require('./lib');

const KEY = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';

function activate(context) {
  const store = new SessionStore();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  const REST = '$(copy) Copy block';
  status.text = REST;
  status.tooltip = `Copy the newest code block from Claude Code's replies. In the terminal you can also hold ${KEY} and click a code block.`;
  status.command = 'copyBlocksForClaudeCode.copyNewest';
  status.show();

  let restTimer = null;
  async function copy(block) {
    await vscode.env.clipboard.writeText(block.text);
    status.text = '$(check) Copied';
    clearTimeout(restTimer);
    restTimer = setTimeout(() => { status.text = REST; }, 2000);
    vscode.window.setStatusBarMessage(`Copied ${block.text.length} characters: ${preview(block)}`, 4000);
  }

  /** Blocks from Claude Code sessions started in this window's folders; if there are none, from any folder. */
  async function blocksHere() {
    await store.refresh();
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const here = store.blocks({ under: folders });
    return here.length ? here : store.blocks();
  }

  async function pick(blocks) {
    const when = (b) => new Date(b.time).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const items = [];
    blocks.slice(0, 30).forEach((block, i) => {
      if (i > 0 && block.reply !== blocks[i - 1].reply) items.push({ label: when(block), kind: vscode.QuickPickItemKind.Separator });
      const lines = block.text.split('\n').length;
      items.push({ label: preview(block, 80), description: `${block.text.length} characters${lines > 1 ? `, ${lines} lines` : ''}`, block });
    });
    const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'Copy which code block? Newest reply first.', matchOnDescription: true });
    if (chosen && chosen.block) await copy(chosen.block);
  }

  const NONE = 'No code block found in the Claude Code sessions used in the last 7 days.';

  context.subscriptions.push(
    status,
    { dispose: () => clearTimeout(restTimer) },

    // 1. Every terminal row that is part of a code block becomes a link.
    vscode.window.registerTerminalLinkProvider({
      async provideTerminalLinks(ctx) {
        const text = ctx.line.trim();
        if (!text) return [];
        await store.refresh();
        const block = findBlockForRow(ctx.line, store.blocks());
        if (!block) return [];
        const start = ctx.line.length - ctx.line.trimStart().length;
        const link = new vscode.TerminalLink(start, text.length, `Copy code block: ${preview(block, 40)}`);
        link.block = block;
        return [link];
      },
      handleTerminalLink(link) { return copy(link.block); },
    }),

    // 2. The status bar button: one block in the newest reply is copied at once; several open a list.
    vscode.commands.registerCommand('copyBlocksForClaudeCode.copyNewest', async () => {
      const blocks = await blocksHere();
      if (!blocks.length) return vscode.window.showInformationMessage(NONE);
      const newestReply = blocks.filter((b) => b.reply === blocks[0].reply);
      return newestReply.length === 1 ? copy(newestReply[0]) : pick(blocks);
    }),

    vscode.commands.registerCommand('copyBlocksForClaudeCode.pick', async () => {
      const blocks = await blocksHere();
      return blocks.length ? pick(blocks) : vscode.window.showInformationMessage(NONE);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
