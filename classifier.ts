// Pure classification module — no Obsidian, no DOM, no CodeMirror.
//
// Single source of truth for "what placement role does each top-level block of
// a Cornell note have." Both renderers — the Reading view post-processor and
// the Live Preview view plugin — derive their layout from the Slot list this
// produces, so placement is decided in exactly one place.
//
// A Slot carries BOTH a block-level `sourceRange` (what Reading view's
// per-wrapper layout needs) and per-line `lineRanges` (what Live Preview's
// per-line CodeMirror decorations need), so neither renderer has to reinvent
// the placement decision.

export interface Range {
  from: number;
  to: number;
}

export type SlotRole = "cue" | "summary" | "body" | "full" | "gap";

export interface Slot {
  role: SlotRole;
  /** Char range of the whole block. */
  sourceRange: Range;
  /** Per-source-line char ranges making up the block, in order. */
  lineRanges: Range[];
  /** Cue / summary only: the callout's title + body text. */
  content?: string;
  /** Cue only: char range of the body block this cue anchors to (falls back to
   *  the cue's own range when there is no external body block). */
  anchorBlockRange?: Range | null;
  /** Cue only: set when this cue is part of an adjacent-cue pair (another cue
   *  sits directly above/below with only blank lines between — no body block).
   *  Both cues in the pair receive the flag. */
  invalid?: "adjacent-cue";
  /** Body only: true when this body block is the last in its cue's notes
   *  region (the next block is a cue / heading / rule / summary, or there is
   *  none). Reading view uses it to break the continuous divider line before
   *  the next cue — within a region the line spans every block unbroken. */
  notesEnd?: boolean;
  /** `full` only: true when the block is a horizontal rule `---`. */
  isHorizontalRule?: boolean;
}

const CORNELL_CLASS = "cornell-note";

export function hasCornellCssClass(frontmatter: unknown): boolean {
  if (!frontmatter || typeof frontmatter !== "object") return false;
  const fm = frontmatter as { cssclasses?: unknown; cssclass?: unknown };
  return matches(fm.cssclasses) || matches(fm.cssclass);
}

function matches(value: unknown): boolean {
  if (Array.isArray(value)) return value.includes(CORNELL_CLASS);
  if (typeof value === "string") return value.split(/\s+/).includes(CORNELL_CLASS);
  return false;
}

/** Classify a note's source into an ordered list of placement slots.
 *  Returns [] when the note is not a Cornell note. */
export function classifyBlocks(markdown: string, frontmatter: unknown): Slot[] {
  if (!hasCornellCssClass(frontmatter)) return [];

  const lns = splitLines(markdown);
  const kinds = classifyLines(lns);
  const slots: Slot[] = [];

  const lineRangesOf = (from: number, toExclusive: number): Range[] => {
    const out: Range[] = [];
    for (let k = from; k < toExclusive; k++) {
      out.push({ from: lns[k].start, to: lns[k].end });
    }
    return out;
  };
  const blockRange = (from: number, toExclusive: number): Range => ({
    from: lns[from].start,
    to: lns[toExclusive - 1].end,
  });

  let i = 0;
  let lastCueSlotIdx = -1;
  let lastCueEndLineIdx = -1;

  while (i < lns.length) {
    const kind = kinds[i];

    // --- Cue / summary callout ---------------------------------------------
    if (
      kind.kind === "callout-start" &&
      (kind.calloutType === "cue" || kind.calloutType === "summary")
    ) {
      let j = i + 1;
      while (j < lns.length && kinds[j].kind === "callout-cont") j++;

      const role: SlotRole = kind.calloutType;
      const slot: Slot = {
        role,
        sourceRange: blockRange(i, j),
        lineRanges: lineRangesOf(i, j),
        content: extractContent(kinds, i, j),
      };

      if (role === "cue") {
        slot.anchorBlockRange =
          findAnchorBlock(lns, kinds, j) ?? slot.sourceRange;
        if (
          lastCueSlotIdx >= 0 &&
          allBlankBetween(kinds, lastCueEndLineIdx + 1, i)
        ) {
          slot.invalid = "adjacent-cue";
          slots[lastCueSlotIdx].invalid = "adjacent-cue";
        }
      }

      slots.push(slot);

      if (role === "cue") {
        const cueIdx = slots.length - 1;
        // Blank lines immediately after the cue become a `gap` slot: Live
        // Preview collapses them so the cue lands on its anchor's row.
        let g = j;
        while (g < lns.length && kinds[g].kind === "blank") g++;
        if (g > j) {
          slots.push({
            role: "gap",
            sourceRange: blockRange(j, g),
            lineRanges: lineRangesOf(j, g),
          });
        }
        lastCueSlotIdx = cueIdx;
        lastCueEndLineIdx = j - 1;
        i = g;
      } else {
        i = j;
      }
      continue;
    }

    // --- Other callout (note/warning/etc.) → full-width block --------------
    if (kind.kind === "callout-start") {
      let m = i + 1;
      while (m < lns.length && kinds[m].kind === "callout-cont") m++;
      slots.push({
        role: "full",
        sourceRange: blockRange(i, m),
        lineRanges: lineRangesOf(i, m),
      });
      i = m;
      continue;
    }

    // --- Frontmatter block → full-width ------------------------------------
    if (kind.kind === "frontmatter" || kind.kind === "frontmatter-fence") {
      let m = i + 1;
      while (
        m < lns.length &&
        (kinds[m].kind === "frontmatter" || kinds[m].kind === "frontmatter-fence")
      ) {
        m++;
      }
      slots.push({
        role: "full",
        sourceRange: blockRange(i, m),
        lineRanges: lineRangesOf(i, m),
      });
      i = m;
      continue;
    }

    // --- Heading → full-width (its own block) ------------------------------
    if (kind.kind === "heading") {
      slots.push({
        role: "full",
        sourceRange: blockRange(i, i + 1),
        lineRanges: lineRangesOf(i, i + 1),
      });
      i++;
      continue;
    }

    // --- Horizontal rule → full-width (flagged for legacy first-rule) ------
    if (kind.kind === "horizontal-rule") {
      slots.push({
        role: "full",
        sourceRange: blockRange(i, i + 1),
        lineRanges: lineRangesOf(i, i + 1),
        isHorizontalRule: true,
      });
      i++;
      continue;
    }

    // --- Blank not following a cue → no slot -------------------------------
    if (kind.kind === "blank") {
      i++;
      continue;
    }

    // --- Body run: paragraphs, lists, blockquotes, code blocks -------------
    let m = i + 1;
    while (m < lns.length) {
      const km = kinds[m].kind;
      if (km !== "body" && km !== "code-fence" && km !== "code-inside") break;
      m++;
    }
    slots.push({
      role: "body",
      sourceRange: blockRange(i, m),
      lineRanges: lineRangesOf(i, m),
    });
    i = m;
  }

  // A body block ends its cue's notes region when the next block isn't another
  // body (a cue, heading, rule, or summary follows — or it's the last block).
  // Reading view breaks the divider line there; consecutive body blocks within
  // the same region stay connected for one continuous line.
  for (let s = 0; s < slots.length; s++) {
    if (slots[s].role !== "body") continue;
    const next = slots[s + 1];
    if (!next || next.role !== "body") slots[s].notesEnd = true;
  }

  return slots;
}

/** Reading-view bridge: given a source line range (as Obsidian's
 *  `ctx.getSectionInfo` reports — 0-based, inclusive `lineStart`/`lineEnd`),
 *  return the Slot whose block overlaps that range, or null when none does
 *  (the caller then leaves the wrapper at its full-width default).
 *
 *  Matching is by source position, not by DOM/parse index, so partial or
 *  out-of-order Reading-view section renders still resolve correctly. */
export function slotForLineRange(
  markdown: string,
  frontmatter: unknown,
  lineStart: number,
  lineEnd: number
): Slot | null {
  const slots = classifyBlocks(markdown, frontmatter);
  if (slots.length === 0) return null;

  // slots are in source order, so their start offsets are monotonic — a single
  // forward scan converts char offsets to 0-based line numbers in O(n) total.
  let line = 0;
  let offset = 0;
  const lineOf = (off: number): number => {
    while (offset < off && offset < markdown.length) {
      if (markdown[offset] === "\n") line++;
      offset++;
    }
    return line;
  };

  for (const slot of slots) {
    const sStart = lineOf(slot.sourceRange.from);
    const sEnd = lineOf(Math.max(slot.sourceRange.from, slot.sourceRange.to - 1));
    if (sStart <= lineEnd && sEnd >= lineStart) return slot;
  }
  return null;
}

/** Per-rendered-section result for the Reading-view post-processor: the slot
 *  the section belongs to, plus whether THIS section is the tail of a cue's
 *  notes region (so it — and only it — should break the divider line).
 *
 *  Obsidian can split one body slot into several rendered sections: a table and
 *  the paragraph immediately below it (no blank line between) are one body slot
 *  but two DOM sections. The `notesEnd` flag lives on the slot, so naively
 *  stamping every section of a notesEnd slot would break the divider at the
 *  table too. We instead break only on the section that contains the slot's
 *  final source line; interior sections stay connected. */
export function classifySection(
  markdown: string,
  frontmatter: unknown,
  lineStart: number,
  lineEnd: number
): { slot: Slot; notesEnd: boolean } | null {
  const slot = slotForLineRange(markdown, frontmatter, lineStart, lineEnd);
  if (!slot) return null;
  let notesEnd = false;
  if (slot.role === "body" && slot.notesEnd) {
    notesEnd = lineEnd >= lineIndexOf(markdown, slot.sourceRange.to - 1);
  }
  return { slot, notesEnd };
}

/** 0-based line index of a character offset (counts newlines before it). */
function lineIndexOf(markdown: string, offset: number): number {
  let line = 0;
  const end = Math.min(offset, markdown.length);
  for (let i = 0; i < end; i++) {
    if (markdown[i] === "\n") line++;
  }
  return line;
}

// ----- internals -----

interface Line {
  text: string;
  start: number;
  end: number;
}

type LineKind =
  | { kind: "frontmatter" }
  | { kind: "frontmatter-fence" }
  | { kind: "code-fence" }
  | { kind: "code-inside" }
  | { kind: "callout-start"; calloutType: "cue" | "summary" | string; titleText: string }
  | { kind: "callout-cont"; bodyText: string }
  | { kind: "blank" }
  | { kind: "heading"; level: number }
  | { kind: "horizontal-rule" }
  | { kind: "body" };

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      let lineText = text.slice(start, i);
      if (lineText.endsWith("\r")) lineText = lineText.slice(0, -1);
      out.push({ text: lineText, start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < text.length) {
    let lineText = text.slice(start);
    if (lineText.endsWith("\r")) lineText = lineText.slice(0, -1);
    out.push({ text: lineText, start, end: text.length });
  }
  return out;
}

function classifyLines(lns: Line[]): LineKind[] {
  const out: LineKind[] = [];
  let inFrontmatter = false;
  let frontmatterClosed = false;
  let inCodeFence = false;
  let codeFenceMarker = "";

  for (let i = 0; i < lns.length; i++) {
    const text = lns[i].text;

    if (!frontmatterClosed && i === 0 && text.trim() === "---") {
      inFrontmatter = true;
      out.push({ kind: "frontmatter-fence" });
      continue;
    }
    if (inFrontmatter) {
      if (text.trim() === "---") {
        inFrontmatter = false;
        frontmatterClosed = true;
        out.push({ kind: "frontmatter-fence" });
      } else {
        out.push({ kind: "frontmatter" });
      }
      continue;
    }

    const fenceMatch = text.match(/^\s*(`{3,}|~{3,})/);
    if (inCodeFence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === codeFenceMarker[0] &&
        fenceMatch[1].length >= codeFenceMarker.length
      ) {
        inCodeFence = false;
        codeFenceMarker = "";
        out.push({ kind: "code-fence" });
      } else {
        out.push({ kind: "code-inside" });
      }
      continue;
    }
    if (fenceMatch) {
      inCodeFence = true;
      codeFenceMarker = fenceMatch[1];
      out.push({ kind: "code-fence" });
      continue;
    }

    if (text.trim() === "") {
      out.push({ kind: "blank" });
      continue;
    }

    const calloutStart = text.match(/^>\s*\[!(\w[\w-]*)\][+-]?\s*(.*)$/);
    if (calloutStart) {
      out.push({
        kind: "callout-start",
        calloutType: calloutStart[1].toLowerCase(),
        titleText: calloutStart[2].trim(),
      });
      continue;
    }

    const calloutCont = text.match(/^>\s?(.*)$/);
    if (calloutCont) {
      const prev = out[out.length - 1];
      if (prev && (prev.kind === "callout-start" || prev.kind === "callout-cont")) {
        out.push({ kind: "callout-cont", bodyText: calloutCont[1] });
        continue;
      }
    }

    const headingMatch = text.match(/^(#+)\s+/);
    if (headingMatch) {
      out.push({ kind: "heading", level: headingMatch[1].length });
      continue;
    }

    // A horizontal rule: 3+ hyphens (or `*` / `_`), optional surrounding
    // whitespace, nothing else. The frontmatter case has already been handled
    // above, so any `---` reaching here is a real rule.
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(text)) {
      out.push({ kind: "horizontal-rule" });
      continue;
    }

    out.push({ kind: "body" });
  }

  return out;
}

function allBlankBetween(
  kinds: LineKind[],
  from: number,
  toExclusive: number
): boolean {
  for (let k = from; k < toExclusive; k++) {
    if (kinds[k].kind !== "blank") return false;
  }
  return true;
}

function extractContent(kinds: LineKind[], i: number, j: number): string {
  const startKind = kinds[i];
  if (startKind.kind !== "callout-start") return "";
  let content = startKind.titleText;
  for (let k = i + 1; k < j; k++) {
    const kk = kinds[k];
    if (kk.kind === "callout-cont" && kk.bodyText.trim()) {
      if (content) content += "\n";
      content += kk.bodyText;
    }
  }
  return content;
}

function findAnchorBlock(
  lns: Line[],
  kinds: LineKind[],
  start: number
): Range | null {
  let k = start;
  while (k < lns.length && kinds[k].kind === "blank") k++;
  if (k >= lns.length) return null;
  if (kinds[k].kind === "callout-start") {
    // Another callout follows immediately. Skip past it to find a real block.
    let nextStart = k + 1;
    while (nextStart < lns.length && kinds[nextStart].kind === "callout-cont") {
      nextStart++;
    }
    return findAnchorBlock(lns, kinds, nextStart);
  }

  const firstLine = lns[k];
  let m = k + 1;
  while (
    m < lns.length &&
    kinds[m].kind !== "blank" &&
    kinds[m].kind !== "callout-start"
  ) {
    m++;
  }
  const lastLine = lns[m - 1];
  return { from: firstLine.start, to: lastLine.end };
}
