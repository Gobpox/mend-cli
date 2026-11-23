// SPDX-License-Identifier: MIT
// mend — one patch tool for every AI edit format.
//
// mend reads a patch in any of the four formats models write their edits in
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON tool calls), finds the lines
// each edit names at the first of three matching tiers (exact, trailing
// whitespace drifted, indentation drifted), and writes every change or none.
// The full contract is SPEC.md; this file implements it section by section.
//
// Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` with the
// working directory as the root of the tree. In a trial the grader runs
// `node /bot/main.ts` with MAKEFUN_ENV_URL set and this file hands over to
// runner.ts (kept from the kit, see the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------- errors ---

/** Exit-2 failure: the single line stdout must carry. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed with a SPEC code against one path. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const parseErr = (n: number): Exit2 => new Exit2(`error: parse ${n}`);

// ------------------------------------------------------------------ tree ---

/**
 * The tree as the edits leave it. `now` holds every path an edit has touched
 * (its new text, or null when deleted); anything else is read from disk on
 * first use and remembered in `orig`, which the output stage compares
 * against. `moves` records each successful move edit so the output stage can
 * print the single `R old -> new` line SPEC section 2 asks for.
 */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<readonly [string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  /** Snapshot/restore around one edit, so a failed edit changes nothing. */
  snapshot(): { now: Map<string, string | null>; moves: number } {
    return { now: new Map(this.now), moves: this.moves.length };
  }
  restore(s: { now: Map<string, string | null>; moves: number }): void {
    this.now.clear();
    for (const [k, v] of s.now) this.now.set(k, v);
    this.moves.length = s.moves;
  }
}

type Edit = (tree: Tree) => void;

// ------------------------------------------------------------ text basics ---

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no final empty piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: a path is safe when no segment is empty, `.` or `..`. */
function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** A file split into its line break, its lines and whether it ends with one. */
interface FileLines {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], finalBr: false };
  const lines = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) lines.pop();
  return { br, lines, finalBr };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBr ? f.br : '');
}

/** A created file's text: LF breaks, a final one exactly when `endBr`. */
function createdText(lines: string[], endBr: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (endBr ? '\n' : '');
}

// ------------------------------------------------------- matching (sec. 5) ---

const rstripWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWs(a) === rstripWs(b);
  return stripWs(a) === stripWs(b);
}

/** Every start position >= `from` where O matches `lines` at `tier`. */
function occurrencesAt(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = Math.max(0, from); i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (!lineMatches(lines[i + k]!, O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier (0 only under --strict) at which O occurs at or after
 * `from`, with every occurrence at that tier; null when it occurs nowhere.
 */
function firstTier(
  lines: string[],
  O: string[],
  strict: boolean,
  from = 0,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(lines, O, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/**
 * One replacement line as it is written. A context line is the file's own
 * matched line; any other line is re-indented at tier 2 (the indent P of O's
 * first line becomes the indent F of the file's first matched line) and is
 * written as it stands at tiers 0 and 1.
 */
interface NewLine {
  text: string;
  /** Index into O when this line is a context line, else -1. */
  ctx: number;
}

function buildNew(
  N: NewLine[],
  O: string[],
  fileLines: string[],
  pos: number,
  tier: number,
): string[] {
  const pIndent = O.length > 0 ? leadWs(O[0]!) : '';
  const fIndent = O.length > 0 ? leadWs(fileLines[pos] ?? '') : '';
  return N.map((n) => {
    if (n.ctx >= 0) return fileLines[pos + n.ctx]!;
    if (tier === 2 && n.text.trim() !== '' && n.text.startsWith(pIndent)) {
      return fIndent + n.text.slice(pIndent.length);
    }
    return n.text;
  });
}

// -------------------------------------------------------- unified (sec. 6) ---

interface HunkBodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line followed this body line. */
  noNl: boolean;
}

interface Hunk {
  a: number;
  body: HunkBodyLine[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null | undefined; // undefined: no --- line seen
  headNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

/** The path a ---/+++ line names: up to the first tab, a//b/ prefix removed. */
function headerPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/;
const GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  const newSection = (): Section => {
    const s: Section = {
      diffOld: null,
      diffNew: null,
      headOld: undefined,
      headNew: undefined,
      renameFrom: null,
      renameTo: null,
      isNew: false,
      isDeleted: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? '';

    if (line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw parseErr(i + 1);
      sec = newSection();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      i += 1;
      continue;
    }

    if (line.startsWith('--- ') && next.startsWith('+++ ')) {
      // A pair starts a section, unless it is the header pair of the section
      // we are already heading (no pair yet and no hunks yet).
      const inHeader =
        sec !== null && sec.hunks.length === 0 && sec.headOld === undefined;
      if (!inHeader) sec = newSection();
      sec!.headOld = headerPath(line.slice(4));
      sec!.headNew = headerPath(next.slice(4));
      i += 2;
      continue;
    }

    if (sec !== null && sec.hunks.length === 0 && line.startsWith('--- ')) {
      // A --- line inside a section header with no +++ after it.
      throw parseErr(i + 2);
    }

    if (line.startsWith('@@')) {
      if (sec === null) throw parseErr(i + 1);
      const m = HUNK_RE.exec(line);
      if (m === null) throw parseErr(i + 1);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i += 1;
      // The body: lines starting with ' ', '-', '+', '\', or empty lines.
      while (i < lines.length) {
        const b = lines[i]!;
        const bNext = lines[i + 1] ?? '';
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && bNext.startsWith('+++ ')) break;
        if (b === '') {
          hunk.body.push({ kind: 'ctx', text: '', noNl: false });
        } else if (b[0] === ' ') {
          hunk.body.push({ kind: 'ctx', text: b.slice(1), noNl: false });
        } else if (b[0] === '-') {
          hunk.body.push({ kind: 'old', text: b.slice(1), noNl: false });
        } else if (b[0] === '+') {
          hunk.body.push({ kind: 'new', text: b.slice(1), noNl: false });
        } else if (b[0] === '\\') {
          const prev = hunk.body[hunk.body.length - 1];
          if (prev !== undefined) prev.noNl = true;
        } else {
          break;
        }
        i += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (
        hunk.body.length > 0 &&
        hunk.body[hunk.body.length - 1]!.kind === 'ctx' &&
        hunk.body[hunk.body.length - 1]!.text === '' &&
        !hunk.body[hunk.body.length - 1]!.noNl
      ) {
        hunk.body.pop();
      }
      sec.hunks.push(hunk);
      continue;
    }

    // Section header lines, before the first hunk; anything else is ignored.
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.isNew = true;
      else if (line.startsWith('deleted file mode')) sec.isDeleted = true;
      else if (line.startsWith('+++ ')) sec.headNew = headerPath(line.slice(4));
    }
    i += 1;
  }
  return sections;
}

/** The `\` flag on a hunk's last context or + line, when there is one. */
function lastWriteNoNl(h: Hunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k -= 1) {
    const b = h.body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') return b.noNl;
  }
  return false;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.headOld !== undefined ? sec.headOld : (sec.renameFrom ?? sec.diffOld);
  const newPath = sec.headNew !== undefined ? sec.headNew : (sec.renameTo ?? sec.diffNew);
  const creation = oldPath === null || sec.isNew;
  const deletion = newPath === null || sec.isDeleted;

  return (tree) => {
    // Every path the edit names is checked for safety before anything else
    // (a /dev/null side names no path and is null here).
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);

    if (creation) {
      const p = newPath!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noNl = false;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === 'new') {
            plus.push(b.text);
            noNl = b.noNl;
          }
        }
      }
      tree.now.set(p, createdText(plus, !noNl));
      return;
    }
    if (deletion) {
      const p = oldPath!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }

    const from = oldPath!;
    const to = newPath ?? from;
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    const isMove = to !== from;
    if (isMove && tree.get(to) !== null) throw new Fail('exists', to);

    const f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const O: string[] = [];
      const N: NewLine[] = [];
      for (const b of h.body) {
        if (b.kind === 'ctx') {
          N.push({ text: b.text, ctx: O.length });
          O.push(b.text);
        } else if (b.kind === 'old') {
          O.push(b.text);
        } else {
          N.push({ text: b.text, ctx: -1 });
        }
      }
      if (O.length === 0) {
        const at = Math.min(h.a + d, f.lines.length);
        const written = buildNew(N, O, f.lines, at, 0);
        const atEnd = at === f.lines.length;
        f.lines.splice(at, 0, ...written);
        if (atEnd) f.finalBr = !lastWriteNoNl(h);
      } else {
        const found = firstTier(f.lines, O, strict);
        if (found === null) throw new Fail('no-match', from);
        const target = h.a - 1 + d;
        let pos = found.positions[0]!;
        for (const cand of found.positions) {
          if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
        }
        const runsToEnd = pos + O.length === f.lines.length;
        const written = buildNew(N, O, f.lines, pos, found.tier);
        f.lines.splice(pos, O.length, ...written);
        if (runsToEnd) f.finalBr = !lastWriteNoNl(h);
      }
      d += N.length - O.length;
    }
    tree.now.set(to, joinFile(f));
    if (isMove) {
      tree.now.set(from, null);
      tree.moves.push([from, to] as const);
    }
  };
}

// ------------------------------------------------- SEARCH/REPLACE (sec. 7) ---

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1; // index of the previous block's REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    // The path: the nearest line before SEARCH, after the previous block,
    // that is not blank and does not open a code fence.
    let path: string | null = null;
    for (let k = searchAt - 1; k > prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw parseErr(searchAt + 1);
    // ======= and then >>>>>>> REPLACE must follow.
    let eq = -1;
    for (let k = searchAt + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw parseErr(searchAt + 1);
    blocks.push({
      path,
      oldLines: lines.slice(searchAt + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks;
}

function srEdit(block: SrBlock, strict: boolean): Edit {
  const p = block.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (block.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, createdText(block.newLines, true));
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const found = firstTier(f.lines, block.oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = found.positions[0]!;
    const N: NewLine[] = block.newLines.map((t) => ({ text: t, ctx: -1 }));
    const written = buildNew(N, block.oldLines, f.lines, pos, found.tier);
    f.lines.splice(pos, block.oldLines.length, ...written);
    tree.now.set(p, joinFile(f));
  };
}

// ------------------------------------------------------------ V4A (sec. 8) ---

interface V4aChunk {
  anchor: string | null;
  body: HunkBodyLine[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  atLine: number;
  addLines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw parseErr(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw parseErr(first + 1);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw parseErr(lines.length + 1);

  const sections: V4aSection[] = [];
  let sec: V4aSection | null = null;
  let chunk: V4aChunk | null = null;
  const closeChunk = (): void => {
    if (sec !== null && chunk !== null) sec.chunks.push(chunk);
    chunk = null;
  };

  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    let kind: V4aSection['kind'] | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = line.slice(17).trim();
    }
    if (kind !== null) {
      closeChunk();
      sec = { kind, path, atLine: i + 1, addLines: [], moveTo: null, chunks: [] };
      sections.push(sec);
      continue;
    }
    if (sec === null) {
      if (blank(line)) continue;
      throw parseErr(i + 1);
    }
    if (sec.kind === 'add') {
      if (line.startsWith('+')) sec.addLines.push(line.slice(1));
      else if (line === '') sec.addLines.push('');
      else throw parseErr(i + 1);
      continue;
    }
    if (sec.kind === 'del') {
      if (blank(line)) continue;
      throw parseErr(i + 1);
    }
    // Update File section.
    if (line.startsWith('*** Move to: ') && sec.chunks.length === 0 && chunk === null && sec.moveTo === null) {
      sec.moveTo = line.slice(13).trim();
      continue;
    }
    if (line.trimEnd() === '*** End of File') {
      if (chunk === null) chunk = { anchor: null, body: [], eof: true };
      else chunk.eof = true;
      closeChunk();
      continue;
    }
    if (line.startsWith('@@')) {
      closeChunk();
      const anchor = line.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (chunk === null) chunk = { anchor: null, body: [], eof: false };
      if (line === '') chunk.body.push({ kind: 'ctx', text: '', noNl: false });
      else if (line[0] === ' ') chunk.body.push({ kind: 'ctx', text: line.slice(1), noNl: false });
      else if (line[0] === '-') chunk.body.push({ kind: 'old', text: line.slice(1), noNl: false });
      else chunk.body.push({ kind: 'new', text: line.slice(1), noNl: false });
      continue;
    }
    throw parseErr(i + 1);
  }
  closeChunk();

  for (const s of sections) {
    if (s.kind === 'add') {
      // Blank lines at the end of a section are not part of it.
      while (s.addLines.length > 0 && s.addLines[s.addLines.length - 1] === '') s.addLines.pop();
    }
    if (s.kind === 'upd') {
      const lastChunk = s.chunks[s.chunks.length - 1];
      if (lastChunk !== undefined) {
        while (
          lastChunk.body.length > 0 &&
          lastChunk.body[lastChunk.body.length - 1]!.kind === 'ctx' &&
          lastChunk.body[lastChunk.body.length - 1]!.text === ''
        ) {
          lastChunk.body.pop();
        }
      }
      if (s.chunks.length === 0 && s.moveTo === null) throw parseErr(s.atLine);
    }
  }
  return sections;
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  const p = sec.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, createdText(sec.addLines, true));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    // Update File.
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) {
      throw new Fail('exists', sec.moveTo);
    }
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let anchorPos = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (lineMatches(f.lines[k]!, ch.anchor, tier)) {
              anchorPos = k;
              break;
            }
          }
          if (anchorPos >= 0) break;
        }
        if (anchorPos < 0) throw new Fail('no-match', p);
        cursor = anchorPos + 1;
      }
      const O: string[] = [];
      const N: NewLine[] = [];
      for (const b of ch.body) {
        if (b.kind === 'ctx') {
          N.push({ text: b.text, ctx: O.length });
          O.push(b.text);
        } else if (b.kind === 'old') {
          O.push(b.text);
        } else {
          N.push({ text: b.text, ctx: -1 });
        }
      }
      if (O.length === 0) {
        const at = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        const written = buildNew(N, O, f.lines, at, 0);
        f.lines.splice(at, 0, ...written);
        cursor = at + written.length;
        continue;
      }
      // An end-of-file chunk takes only an occurrence that ends at the
      // file's last line, so its tiers are tried with that filter applied.
      let found: { tier: number; positions: number[] } | null = null;
      if (ch.eof) {
        for (const tier of strict ? [0] : [0, 1, 2]) {
          const positions = occurrencesAt(f.lines, O, tier, cursor).filter(
            (cand) => cand + O.length === f.lines.length,
          );
          if (positions.length > 0) {
            found = { tier, positions };
            break;
          }
        }
      } else {
        found = firstTier(f.lines, O, strict, cursor);
      }
      if (found === null) throw new Fail('no-match', p);
      const pos = found.positions[0]!;
      const written = buildNew(N, O, f.lines, pos, found.tier);
      f.lines.splice(pos, O.length, ...written);
      cursor = pos + written.length;
    }
    const dest = sec.moveTo ?? p;
    tree.now.set(dest, joinFile(f));
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.moves.push([p, sec.moveTo] as const);
    }
  };
}

// ----------------------------------------------------------- JSON (sec. 9) ---

/** One JSON edit object, or null when it is not a valid one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const mustExist = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = mustExist(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = mustExist(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw parseErr(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw parseErr(first + 1);
    }
    if (!Array.isArray(v)) throw parseErr(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw parseErr(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw parseErr(idx + 1);
    edits.push(e);
  });
  return edits;
}

// ------------------------------------------------------- detection (sec. 4) ---

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, idx) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ------------------------------------------------------------- run (sec. 1-2, 10) ---

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };

  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((b) => srEdit(b, strict));
    else edits = parseV4a(lines).map((s) => v4aEdit(s, strict));
    if (edits.length === 0) throw parseErr(1);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }

  // Changed paths, in byte order; a qualifying move prints one R line,
  // replacing its D and A lines and sorting by the new path.
  interface Row {
    key: string;
    text: string;
    path: string;
  }
  const rows: Row[] = [];
  const movedAway = new Set<string>();
  const movedInto = new Set<string>();
  for (const [from, to] of tree.moves) {
    const wasFrom = tree.original(from);
    const nowFrom = tree.now.has(from) ? tree.now.get(from)! : wasFrom;
    const wasTo = tree.original(to);
    const nowTo = tree.now.has(to) ? tree.now.get(to)! : wasTo;
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null) {
      rows.push({ key: to, text: `R ${from} -> ${to}`, path: to });
      movedAway.add(from);
      movedInto.add(to);
    }
  }
  for (const p of tree.now.keys()) {
    if (movedAway.has(p) || movedInto.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));

  if (!check) {
    // Write every path the edits touched whose bytes differ from before.
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (now === tree.original(p)) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
