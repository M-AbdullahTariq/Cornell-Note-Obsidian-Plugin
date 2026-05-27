// Pure parser module — no Obsidian, no DOM. Single source of truth for
// "what does this file mean as a Cornell note." Consumed by both the
// Reading view post-processor (Phase 2/4) and the Live Preview decorator (Phase 4).
//
// Given the full markdown source of a file and its parsed frontmatter, returns
// whether the file is a Cornell note and the list of cue/summary callouts found,
// each with its source character range and the range of the block it should
// visually anchor to.

export interface Range {
  from: number;
  to: number;
}

export interface CornellItem {
  type: "cue" | "summary";
  sourceRange: Range;
  content: string;
  anchorBlockRange: Range | null;
  /** Set when this cue is invalid because the previous or next cue sits
   *  directly above/below it with only blank lines between (no body block).
   *  Both cues in an adjacent pair receive the flag. */
  invalid?: "adjacent-cue";
}

export interface CornellParseResult {
  isCornell: boolean;
  items: CornellItem[];
  /** Source range of the FIRST `---` horizontal rule outside of frontmatter
   *  and code fences. Null when the file has no such rule. */
  firstHorizontalRule: Range | null;
  /** Per-line source ranges for lines classified as body content
   *  (paragraphs, list items, code-block content, plain-blockquote lines).
   *  Lines at or after `firstHorizontalRule` are excluded, matching Reading
   *  view's per-wrapper `border-left` rule which stops above the rule. */
  bodyLineRanges: Range[];
  /** Per-line source ranges for blank lines that sit immediately between a
   *  cue's last source line and its anchor body block's first source line.
   *  Live Preview collapses these so the cue and its body align on the same
   *  visual row, matching Reading view (which renders no wrapper for blanks). */
  cueGapRanges: Range[];
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

export function parseCornell(
  markdown: string,
  frontmatter: unknown
): CornellParseResult {
  if (!hasCornellCssClass(frontmatter)) {
    return {
      isCornell: false,
      items: [],
      firstHorizontalRule: null,
      bodyLineRanges: [],
      cueGapRanges: [],
    };
  }

  const lns = splitLines(markdown);
  const kinds = classifyLines(lns);
  const items: CornellItem[] = [];
  const cueGapRanges: Range[] = [];
  let firstHorizontalRule: Range | null = null;
  let firstHorizontalRuleIndex = -1;

  let i = 0;
  let lastCueItemIdx = -1;
  let lastCueEndLineIdx = -1;
  while (i < lns.length) {
    const kind = kinds[i];
    if (
      kind.kind === "callout-start" &&
      (kind.calloutType === "cue" || kind.calloutType === "summary")
    ) {
      let j = i + 1;
      while (j < lns.length && kinds[j].kind === "callout-cont") j++;

      const sourceRange: Range = { from: lns[i].start, to: lns[j - 1].end };
      const content = extractContent(kinds, i, j);

      const anchorBlockRange: Range | null =
        kind.calloutType === "cue"
          ? findAnchorBlock(lns, kinds, j) ?? sourceRange
          : sourceRange;

      const item: CornellItem = {
        type: kind.calloutType,
        sourceRange,
        content,
        anchorBlockRange,
      };

      if (kind.calloutType === "cue") {
        if (
          lastCueItemIdx >= 0 &&
          allBlankBetween(kinds, lastCueEndLineIdx + 1, i)
        ) {
          item.invalid = "adjacent-cue";
          items[lastCueItemIdx].invalid = "adjacent-cue";
        }

        // Collect blank lines immediately after the cue, up to the first
        // non-blank source line. Live Preview collapses these so the cue
        // visually lands on the same row as its anchor body block.
        for (let g = j; g < lns.length && kinds[g].kind === "blank"; g++) {
          cueGapRanges.push({ from: lns[g].start, to: lns[g].end });
        }
      }

      items.push(item);

      if (kind.calloutType === "cue") {
        lastCueItemIdx = items.length - 1;
        lastCueEndLineIdx = j - 1;
      }

      i = j;
    } else {
      if (firstHorizontalRule === null && kind.kind === "horizontal-rule") {
        firstHorizontalRule = { from: lns[i].start, to: lns[i].end };
        firstHorizontalRuleIndex = i;
      }
      i++;
    }
  }

  // Body-line ranges: lines that should get the per-line divider in Live
  // Preview. Mirrors Reading view's `:has(p, ul, ol, pre, blockquote)`
  // wrapper match — i.e. paragraphs, list items, code-fence content, and
  // plain `> ` blockquotes (which fall through to `body` kind here because
  // they have no callout-start ancestor). Stops at the first horizontal
  // rule so the summary region below it has no divider, matching Reading
  // view's `:not(:has(.callout[data-callout="summary"]))` exclusion.
  const bodyLineRanges: Range[] = [];
  const bodyEnd =
    firstHorizontalRuleIndex >= 0 ? firstHorizontalRuleIndex : lns.length;
  for (let k = 0; k < bodyEnd; k++) {
    const kk = kinds[k];
    if (
      kk.kind === "body" ||
      kk.kind === "code-fence" ||
      kk.kind === "code-inside"
    ) {
      bodyLineRanges.push({ from: lns[k].start, to: lns[k].end });
    }
  }

  return {
    isCornell: true,
    items,
    firstHorizontalRule,
    bodyLineRanges,
    cueGapRanges,
  };
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
