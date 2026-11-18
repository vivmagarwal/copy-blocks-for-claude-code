'use strict';
// lib.js: finds the replies Claude Code has saved on this Mac and the code blocks inside them.
// Nothing here uses VS Code, so plain Node can test it.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const LONG_ROW = 40;                      // a row this long is accepted even if it starts or ends inside a word
const FIRST_READ_BYTES = 32 * 1024 * 1024; // of a very large session file, only the newest part is read
const CHUNK_BYTES = 4 * 1024 * 1024;       // a file is read in pieces of this size, so memory use stays small

/** Where Claude Code keeps its session files: one folder per project, one .jsonl file per session. */
function defaultRoot() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

/**
 * Text with every run of spaces, tabs and line breaks turned into one space.
 * The terminal indents a code block and breaks its long lines, so only this form of a screen row
 * can be compared with the block as it was written.
 */
function squash(text) {
  return String(text).normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** The fenced code blocks of a Markdown text, in reading order: [{ lang, text }]. */
function extractBlocks(markdown) {
  const blocks = [];
  let open = null;
  const close = () => {
    const text = open.lines.join('\n');
    if (text.trim()) blocks.push({ lang: open.lang, text });
    open = null;
  };
  for (const line of String(markdown).split('\n')) {
    if (!open) {
      const m = line.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
      // "```code```" on one line is inline code, not the start of a block
      if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
        open = { indent: m[1].length, char: m[2][0], len: m[2].length, lang: m[3].trim().split(/\s+/)[0] || '', lines: [] };
      }
      continue;
    }
    const end = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
    if (end && end[1][0] === open.char && end[1].length >= open.len) { close(); continue; }
    // A block inside a list item is indented with the item. Take that indent off again.
    let i = 0;
    while (i < open.indent && (line[i] === ' ' || line[i] === '\t')) i++;
    open.lines.push(line.slice(i));
  }
  if (open) close(); // a block that was never closed runs to the end, as a Markdown viewer shows it
  return blocks;
}

/**
 * The code block that a terminal row belongs to, or null.
 * blocks: newest first. A row belongs to a block when the whole row is found in it, starting and
 * ending at a word break (the terminal breaks lines between words). A very long word is cut inside
 * the word; such rows are long, so a long row may start or end anywhere.
 */
function findBlockForRow(row, blocks) {
  const needle = squash(row);
  if (!needle) return null;
  for (const block of blocks) {
    const hay = block.squashed;
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      const wordStart = at === 0 || hay[at - 1] === ' ';
      const wordEnd = end === hay.length || hay[end] === ' ';
      if ((wordStart && wordEnd) || needle.length >= LONG_ROW) return block;
    }
  }
  return null;
}

/** The first line of a block, cut short, for tips and lists. */
function preview(block, max = 60) {
  const first = squash(block.text.split('\n').find((l) => l.trim()) || '');
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** Reads the newest session files and keeps the code blocks of Claude's replies. */
class SessionStore {
  constructor({ root, maxFiles = 8, maxAgeMs = 7 * 24 * 3600 * 1000, maxBlocksPerFile = 400, readEveryMs = 300, listEveryMs = 5000 } = {}) {
    this.root = root || defaultRoot();
    Object.assign(this, { maxFiles, maxAgeMs, maxBlocksPerFile, readEveryMs, listEveryMs });
    this.files = new Map(); // file -> { offset, pending, skipFirst, blocks }
    this.recent = [];       // the newest session files, newest first
    this.listedAt = -Infinity;
    this.readAt = -Infinity;
    this.running = null;
    this.sorted = null;
  }

  /** Brings the store up to date. Safe to call often: it does real work at most every readEveryMs. */
  refresh() {
    if (!this.running) this.running = this._refresh().finally(() => { this.running = null; });
    return this.running;
  }

  async _refresh() {
    if (Date.now() - this.readAt < this.readEveryMs) return;
    if (Date.now() - this.listedAt >= this.listEveryMs) {
      this.recent = await this._newestFiles();
      this.listedAt = Date.now();
      for (const file of this.files.keys()) if (!this.recent.includes(file)) this.files.delete(file);
    }
    for (const file of this.recent) await this._readNew(file);
    this.readAt = Date.now();
    this.sorted = null;
  }

  async _newestFiles() {
    const cutoff = Date.now() - this.maxAgeMs;
    const found = [];
    let dirs;
    try { dirs = await fsp.readdir(this.root, { withFileTypes: true }); } catch { return []; }
    await Promise.all(dirs.filter((d) => d.isDirectory()).map(async (d) => {
      const dir = path.join(this.root, d.name);
      let names;
      try { names = await fsp.readdir(dir); } catch { return; }
      await Promise.all(names.filter((n) => n.endsWith('.jsonl')).map(async (n) => {
        try {
          const st = await fsp.stat(path.join(dir, n));
          if (st.isFile() && st.mtimeMs >= cutoff) found.push({ file: path.join(dir, n), mtimeMs: st.mtimeMs });
        } catch { /* the file went away */ }
      }));
    }));
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, this.maxFiles).map((f) => f.file);
  }

  /** Reads only what was added to a session file since the last time. Claude Code only ever adds lines. */
  async _readNew(file) {
    let st;
    try { st = await fsp.stat(file); } catch { this.files.delete(file); return; }
    let s = this.files.get(file);
    if (!s || st.size < s.offset) { // new to us, or the file was written afresh
      const start = Math.max(0, st.size - FIRST_READ_BYTES);
      s = { offset: start, skipFirst: start > 0, pending: Buffer.alloc(0), blocks: [] };
      this.files.set(file, s);
    }
    if (st.size === s.offset) return;
    const handle = await fsp.open(file, 'r');
    try {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, st.size - s.offset));
      while (s.offset < st.size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, st.size - s.offset), s.offset);
        if (!bytesRead) break;
        s.offset += bytesRead;
        const data = s.pending.length ? Buffer.concat([s.pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const lastBreak = data.lastIndexOf(10); // a line that is still being written waits for its line break
        s.pending = Buffer.from(data.subarray(lastBreak + 1)); // a copy, because "chunk" is used again
        if (lastBreak < 0) continue;
        const lines = data.subarray(0, lastBreak + 1).toString('utf8').split('\n');
        if (s.skipFirst) { lines.shift(); s.skipFirst = false; } // we started in the middle of a line
        for (const line of lines) this._take(file, s, line);
      }
    } finally {
      await handle.close();
    }
  }

  _take(file, s, line) {
    if (!line.includes('```') && !line.includes('~~~')) return; // most lines hold no code block: skip them cheaply
    if (!line.includes('"type":"assistant"')) return;
    let entry;
    try { entry = JSON.parse(line); } catch { return; }
    if (entry.type !== 'assistant' || entry.isSidechain) return; // sidechain: a helper agent's text, never shown as a reply
    const parts = Array.isArray(entry.message && entry.message.content) ? entry.message.content : [];
    const time = Date.parse(entry.timestamp) || 0;
    let order = 0;
    for (const part of parts) {
      if (!part || part.type !== 'text' || typeof part.text !== 'string') continue;
      for (const b of extractBlocks(part.text)) {
        s.blocks.push({
          text: b.text, lang: b.lang, squashed: squash(b.text),
          time, order: order++, reply: entry.uuid || `${file}:${time}`, cwd: entry.cwd || '', file,
        });
      }
    }
    if (s.blocks.length > this.maxBlocksPerFile) s.blocks.splice(0, s.blocks.length - this.maxBlocksPerFile);
  }

  /**
   * The known code blocks, newest reply first; blocks of one reply stay in reading order.
   * under: if given, only blocks from sessions that were started inside one of these folders.
   */
  blocks({ under = [] } = {}) {
    if (!this.sorted) {
      const seen = new Set();
      this.sorted = [...this.files.values()].flatMap((s) => s.blocks)
        .sort((a, b) => b.time - a.time || a.order - b.order)
        .filter((b) => { // a resumed session can hold the same reply in two files
          const key = `${b.time}\n${b.order}\n${b.text}`;
          return seen.has(key) ? false : seen.add(key);
        });
    }
    if (!under.length) return this.sorted;
    return this.sorted.filter((b) => under.some((dir) => b.cwd === dir || b.cwd.startsWith(dir + path.sep)));
  }
}

module.exports = { SessionStore, extractBlocks, findBlockForRow, squash, preview, defaultRoot };
