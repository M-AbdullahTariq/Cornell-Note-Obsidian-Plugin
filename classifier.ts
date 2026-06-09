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

export type SlotRole = "cue" | "summary" | "body" | "full" | "gap" | "title";

export interface Slot {
  role: SlotRole;
  /** Char range of the whole block. */
  sourceRange: Range;
  /** Per-source-line char ranges making up the block, in order. */
  lineRanges: Range[];
  /** Cue / summary / title only: the callout's title + body text. */
  content?: string;
  /** Cue only: char range of the body block this cue anchors to (falls back to
   *  the cue's own range when there is no external body block). */
  anchorBlockRange?: Range | null;
  /** Cue only: a layout warning.
   *  - `"adjacent-cue"`: another cue sits directly above/below with only blank
   *    lines between (no body block). Both cues in the pair receive the flag.
   *  - `"lazy-body"`: a plain paragraph sits directly under the cue with no
   *    blank line between, so Markdown lazy continuation folds it INTO the cue
   *    callout (the notes render in the narrow cue column). The fix is a blank
   *    line; see `isLazyContinuation`. */
  invalid?: "adjacent-cue" | "lazy-body";
  /** Body or in-region heading: true when this block is the last divider-
   *  participating block in its cue's notes region (the next block is a cue /
   *  title / summary / rule / orphan heading, or there is none). Reading view
   *  uses it to break the continuous divider line before the next cue — within a
   *  region the line spans every body block and in-region heading unbroken. */
  notesEnd?: boolean;
  /** `full` only: true when the block is a horizontal rule `---`. */
  isHorizontalRule?: boolean;
  /** `full` only: true when the block is a heading (`#`..`######`). Lets review
   *  mode blur in-region headings while leaving horizontal rules and
   *  frontmatter — also `full` slots — untouched. */
  isHeading?: boolean;
  /** 0-based Cornell "page" this slot belongs to. A `>[!title]` callout starts
   *  a new page; everything before the first title is page 0 (the file-name
   *  page). Renderers use it to scope a summary to its page and to separate
   *  consecutive pages. */
  page?: number;
  /** `title` only: true for every page title EXCEPT the first in the document.
   *  Reading view stamps it as `data-cornell-page-break` so the page-break gap
   *  is applied by attribute on the title block itself — robust to Reading
   *  view's scroll-driven section re-renders, which can drop the earlier title
   *  a `~` sibling selector would depend on. */
  pageBreak?: boolean;
  /** 0-based ordinal of the cue that "owns" this slot for review mode. Each cue
   *  gets an ordinal; every block in its notes region (until the next cue /
   *  title / summary, or end) inherits it, so review mode can reveal a cue's
   *  whole region as a unit. `null` for titles, summaries, and orphan content
   *  before the first cue — none of which is owned by a cue. */
  cueGroup?: number | null;
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
        } else if (
          j < lns.length &&
          kinds[j].kind === "body" &&
          isLazyContinuation(lns[j].text)
        ) {
          // The line directly below the cue (no blank line between) is plain
          // paragraph text. Markdown lazy continuation folds that paragraph
          // INTO the cue callout, so Obsidian renders the notes inside the
          // narrow cue column instead of the notes column — and in Live Preview
          // the over-tall cues then overlap. Flag it; the fix is a blank line.
          slot.invalid = "lazy-body";
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

    // --- Title callout → full-width page title -----------------------------
    // `>[!title]` renders as a full-width title and delimits a new Cornell
    // "page" (see the page-assignment pass below). Like the summary it spans
    // all columns; unlike other callouts it is NOT body.
    if (kind.kind === "callout-start" && kind.calloutType === "title") {
      let m = i + 1;
      while (m < lns.length && kinds[m].kind === "callout-cont") m++;
      slots.push({
        role: "title",
        sourceRange: blockRange(i, m),
        lineRanges: lineRangesOf(i, m),
        content: extractContent(kinds, i, m),
      });
      // Blank lines immediately AFTER a title become a `gap` slot so Live
      // Preview collapses them (like the post-cue gap). Without this the literal
      // empty source lines below a `>[!title]` render full-height, so the editing
      // view shows a large gap under the title that Reading view doesn't (it
      // collapses blank markdown and uses --cornell-title-gap instead). The
      // controlled gap is re-added in CSS as the title's own margin-bottom.
      let g = m;
      while (g < lns.length && kinds[g].kind === "blank") g++;
      if (g > m) {
        slots.push({
          role: "gap",
          sourceRange: blockRange(m, g),
          lineRanges: lineRangesOf(m, g),
        });
      }
      i = g;
      continue;
    }

    // --- Other callout (note/warning/etc.) → body --------------------------
    // A non-cue / non-summary callout placed in a note is treated as ordinary
    // notes content: it joins the body column and carries the divider line,
    // exactly like a paragraph or table. This keeps "everything under a cue
    // belongs to the cue" visually true — an embedded admonition, image, or
    // table all sit in the notes region with the same block line. (Headings,
    // horizontal rules, the summary, and frontmatter remain full-width below.)
    if (kind.kind === "callout-start") {
      let m = i + 1;
      while (m < lns.length && kinds[m].kind === "callout-cont") m++;
      slots.push({
        role: "body",
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
        isHeading: true,
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

    // --- Blank lines -------------------------------------------------------
    if (kind.kind === "blank") {
      // A run of blanks directly BEFORE a page title collapses in Live Preview
      // (like the post-cue / post-title gap), so the editing view doesn't stack
      // empty source lines above the title. Page separation for the 2nd+ title
      // is owned by the page-break margin, not by these blank lines, so dropping
      // them is safe. Any other trailing/leading blank carries no slot.
      let b = i;
      while (b < lns.length && kinds[b].kind === "blank") b++;
      const next = b < lns.length ? kinds[b] : null;
      if (
        next &&
        next.kind === "callout-start" &&
        next.calloutType === "title"
      ) {
        slots.push({
          role: "gap",
          sourceRange: blockRange(i, b),
          lineRanges: lineRangesOf(i, b),
        });
        i = b;
        continue;
      }
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

  // Page assignment: a `>[!title]` starts a new page. Everything before the
  // first title is page 0 (the file-name page); each title increments the
  // counter so its block and the content beneath it share a page number.
  let page = 0;
  let titleSeen = false;
  for (const slot of slots) {
    if (slot.role === "title") {
      page++;
      // First title stays flush with the top; every later title carries the
      // page-break flag so the gap is applied per-block (see Slot.pageBreak).
      slot.pageBreak = titleSeen;
      titleSeen = true;
    }
    slot.page = page;
  }

  // Cue-group assignment (review mode): each cue gets a 0-based ordinal and
  // every slot in its notes region inherits it — the region runs from the cue
  // until the next cue, title, or summary, or the end. A title or summary ends
  // the current region and is itself unowned; content before the first cue
  // (orphans) stays unowned (null). Renderers map the ordinal to a reveal key
  // so clicking a cue toggles its whole region. Ordinals are global across
  // pages — reveal is per-cue regardless of page.
  let cueOrdinal = -1;
  let currentCue: number | null = null;
  for (const slot of slots) {
    if (slot.role === "cue") {
      currentCue = ++cueOrdinal;
      slot.cueGroup = currentCue;
    } else if (slot.role === "title" || slot.role === "summary") {
      currentCue = null;
      slot.cueGroup = null;
    } else {
      slot.cueGroup = currentCue;
    }
  }

  // Divider regions (computed after cueGroup, which it depends on). A cue's
  // notes region is the run of body blocks AND the in-region headings between
  // them — a heading sits in the notes column and the cue|notes divider runs
  // unbroken through it. A divider-participating block is the region's last
  // when the next block isn't also one (a cue / title / summary / rule / orphan
  // heading follows, or it's the end). Reading view breaks the line there;
  // consecutive participating blocks stay connected for one continuous line.
  // An orphan heading (no owning cue) does NOT participate — it gets the notes
  // column but draws no divider segment.
  const dividing = (slot?: Slot): boolean =>
    !!slot &&
    (slot.role === "body" ||
      (slot.role === "full" && !!slot.isHeading && slot.cueGroup != null));
  for (let s = 0; s < slots.length; s++) {
    if (!dividing(slots[s])) continue;
    if (!dividing(slots[s + 1])) slots[s].notesEnd = true;
  }

  return slots;
}

/** Human-readable warning shown as a `title` tooltip on a cue flagged
 *  `invalid`. Centralised here so the Reading-view post-processor and the Live
 *  Preview decorator show the same message for each reason. */
export function invalidTooltip(reason: NonNullable<Slot["invalid"]>): string {
  switch (reason) {
    case "adjacent-cue":
      return "Cue has no body block before the next cue. Add content below, or merge the cues.";
    case "lazy-body":
      return "This cue's notes are glued to it. Add a blank line between the cue and the text below so the notes move into the notes column.";
  }
}

/** Review-mode placement decision for a single slot (pure). Returns whether the
 *  slot should be blurred in review mode and the reveal-group key it
 *  participates in:
 *
 *  - A cue is never blurred but carries its group key, since clicking it is what
 *    reveals the region.
 *  - Body blocks owned by a cue blur and share that cue's group key, so they
 *    reveal together when the cue is clicked.
 *  - A summary blurs and is its own reveal target (keyed per page).
 *  - Headings stay visible: a heading inside a cue's region (e.g. `## Topic`)
 *    reads as a prompt alongside the cue, not an answer to hide. Titles,
 *    horizontal rules, frontmatter, gaps, and orphan content (no owning cue)
 *    are likewise never blurred and carry no group key.
 *
 *  `group` is the single source of truth for what the DOM controller stamps as
 *  `data-cornell-cue-group`; `blur` drives the blur marker. */
export function reviewBlurInfo(
  slot: Slot
): { blur: boolean; group: string | null } {
  if (slot.role === "summary") {
    return { blur: true, group: `summary:${slot.page ?? 0}` };
  }
  if (slot.role === "cue" && slot.cueGroup != null) {
    return { blur: false, group: `cue:${slot.cueGroup}` };
  }
  if (slot.cueGroup != null && slot.role === "body") {
    return { blur: true, group: `cue:${slot.cueGroup}` };
  }
  return { blur: false, group: null };
}

/** Maximum length, in characters, of a `>[!title]` page title's text. A page
 *  title must fit on a single line; over the cap, both renderers flag the title
 *  (red text + the tooltip below) and clamp it to one line. A fixed character
 *  count — predictable and independent of theme, font, or window width. */
export const TITLE_MAX_LENGTH = 60;

/** Tooltip shown on an over-limit page title, in both Reading view and Live
 *  Preview. Centralised so the two renderers show the identical message — the
 *  same arrangement as `invalidTooltip` for cues. */
export const TITLE_OVER_LIMIT_TOOLTIP = "Max title limit hit";

/** Pure: true when a page title's text is longer than `limit` characters. The
 *  single source of truth for "is this title too long," consumed by both
 *  renderers. Measures the title text only (the text after the `>[!title]`
 *  marker, as the classifier records it in `Slot.content`). */
export function titleExceedsLimit(
  text: string,
  limit: number = TITLE_MAX_LENGTH
): boolean {
  return text.length > limit;
}

/** True when the document's first content block (after any YAML frontmatter)
 *  is a `>[!title]` callout WITH text — i.e. the user explicitly titled the
 *  first page. Reading view uses this to decide whether to hide Obsidian's
 *  built-in inline (file-name) title: hide it when the file leads with a title,
 *  keep it as the file-name fallback otherwise. Any leading content (a heading
 *  or paragraph) before the first title makes this false.
 *
 *  An empty `>[!title]` (no text) does NOT count: it still delimits a page, but
 *  with no title text there is nothing to replace the file name, so the
 *  file-name fallback stays visible until the user types a title. This avoids a
 *  blank title band while the user is mid-typing a fresh `>[!title]`. */
export function leadsWithTitle(markdown: string, frontmatter: unknown): boolean {
  const slots = classifyBlocks(markdown, frontmatter);
  if (slots.length === 0) return false;
  let idx = 0;
  // Skip a leading YAML frontmatter block — the first `full` slot at offset 0
  // when the document opens with a `---` fence.
  if (slots[0].role === "full" && slots[0].sourceRange.from === 0) {
    const nl = markdown.indexOf("\n");
    const firstLine = nl === -1 ? markdown : markdown.slice(0, nl);
    if (firstLine.trim() === "---") idx = 1;
  }
  const lead = slots[idx];
  return lead?.role === "title" && !!lead.content?.trim();
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
  if (slot.notesEnd && (slot.role === "body" || slot.isHeading)) {
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
  // calloutType is any callout name; "cue" / "summary" / "title" are the ones we act on.
  | { kind: "callout-start"; calloutType: string; titleText: string }
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

/** True when a non-blank `body` line sitting directly under a callout would be
 *  folded into it by Markdown "lazy continuation" — i.e. it is plain paragraph
 *  text rather than a line that starts its own block. List items and table rows
 *  start a new block and break out of the callout instead, so they are excluded
 *  (and must NOT be flagged). Headings, horizontal rules, code fences and blank
 *  lines are already separate line kinds, so only list/table need excluding. */
function isLazyContinuation(text: string): boolean {
  const t = text.replace(/^\s+/, "");
  if (/^([-*+]|\d+[.)])\s+/.test(t)) return false; // list item
  if (t.startsWith("|")) return false; // table row
  return true;
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
