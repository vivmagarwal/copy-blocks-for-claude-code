# Working on Copy Blocks for Claude Code

For anyone who wants to change the extension or see how it is built. The page for users is [README.md](README.md).

## The files

- `extension.js`: the VS Code side: the link on terminal rows, the status bar button, the list, the two commands.

- `lib.js`: finds Claude Code's session files, reads the code blocks in them, and matches a terminal row to a block. It uses no VS Code code, so plain Node can test it.

- `test/`: 25 tests. `lib.test.js` tests reading and matching. `extension.test.js` runs `extension.js` against a stand-in for VS Code, from a terminal row to the clipboard.

- `package.json`: what VS Code needs to load the extension. No packages to install and no build step.

- `images/make_images.py`: draws `icon.png` and `images/demo.png` (needs Python with Pillow, and the macOS fonts Menlo and Helvetica).

## Run it from source

You need VS Code 1.80 or newer with its `code` command, and Node.js 20 or newer for the tests.

From this folder:

```
code --extensionDevelopmentPath="$PWD"
```

A second VS Code window opens. Its title starts with **[Extension Development Host]**, and the extension is loaded in it. Your other windows are not touched. Running the command again reloads that window with your changes.

To test by hand in that window:

1. Click **Copy block** at the bottom right. A line at the bottom left says "Copied ... characters".

2. Open a terminal, run `claude`, and ask: `Reply with one sentence of about 40 words in a code block.`

3. Hold Cmd (Ctrl on Windows and Linux), point at the block, and click. Paste somewhere: the sentence is on one line.

To see whether the extension loaded: command palette, **Developer: Show Running Extensions**.

## Run the tests

```
node --test
```

## Make the installable file

```
npx --yes @vscode/vsce package
```

This writes `copy-blocks-for-claude-code-<version>.vsix`. Install it with `code --install-extension <that file>`.

## How it works, for a developer

- **Where the text comes from.** Claude Code writes each session to `~/.claude/projects/<project>/<session>.jsonl`, one JSON object per line. A line with `"type":"assistant"` holds a part of a reply; its `message.content` is a list, and items with `type: "text"` hold Markdown. The extension takes the fenced code blocks from that Markdown. Lines with `isSidechain: true` come from helper agents and are skipped.

- **Reading.** `SessionStore` lists the session files (at most every 5 seconds), keeps the 8 newest from the last 7 days, and reads each in pieces of 4 MB. It remembers how far it read, so later it reads only what was added. A line is parsed only if it holds a code fence and `"type":"assistant"`.

- **Matching.** VS Code's `registerTerminalLinkProvider` gives the extension the text of one terminal row and nothing else: no row number. So `findBlockForRow` turns every run of spaces and line breaks into one space, in the row and in each block, and looks for the whole row inside a block. The match must start and end at a word break, because the terminal breaks lines between words. A row of 40 characters or more may start or end inside a word, because a very long word is cut where the terminal is full. The newest block that has the row wins.

- **The button** uses blocks from sessions that were started inside this window's folders (the `cwd` saved with each reply). If there are none, it uses blocks from any folder.

- **Why no icon on the block.** The VS Code extension interface has no way to draw on terminal content. A link and a status bar item are what it allows.

## What has been tested

- By hand, on macOS with VS Code 1.144 and Claude Code 2.1: Cmd+click on a block that the terminal showed on three rows pasted as one line.

- By program: the 25 tests.

- Not tested: Windows, Linux, remote windows, Claude Code's fullscreen mode.
