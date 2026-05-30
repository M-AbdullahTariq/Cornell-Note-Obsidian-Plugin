// Legacy parse adapter. The placement logic now lives in `classifier.ts`
// (the single source of truth — a list of Slots). This module derives the
// historical `CornellParseResult` shape from that Slot list so existing
// callers (the two renderers, cueLayout) keep working unchanged while the
// renderers migrate to consuming Slots directly.

import { classifyBlocks, hasCornellCssClass, type Range, type Slot } from "./classifier";

export type { Range } from "./classifier";
export { hasCornellCssClass } from "./classifier";

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
   *  (paragraphs, list items, code-block content, plain-blockquote lines)
   *  anywhere in the file. Matches Reading view's per-wrapper `border-left`
   *  rule, which borders every body wrapper regardless of position — so
   *  Cornell sections after the summary's `---` keep their divider too. */
  bodyLineRanges: Range[];
  /** Per-line source ranges for blank lines that sit immediately between a
   *  cue's last source line and its anchor body block's first source line.
   *  Live Preview collapses these so the cue and its body align on the same
   *  visual row, matching Reading view (which renders no wrapper for blanks). */
  cueGapRanges: Range[];
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

  const slots = classifyBlocks(markdown, frontmatter);

  const items: CornellItem[] = [];
  const bodyLineRanges: Range[] = [];
  const cueGapRanges: Range[] = [];
  let firstHorizontalRule: Range | null = null;

  for (const slot of slots) {
    switch (slot.role) {
      case "cue":
      case "summary":
        items.push({
          type: slot.role,
          sourceRange: slot.sourceRange,
          content: slot.content ?? "",
          anchorBlockRange:
            slot.role === "cue"
              ? slot.anchorBlockRange ?? slot.sourceRange
              : slot.sourceRange,
          ...(slot.invalid ? { invalid: slot.invalid } : {}),
        });
        break;
      case "body":
        bodyLineRanges.push(...slot.lineRanges);
        break;
      case "gap":
        cueGapRanges.push(...slot.lineRanges);
        break;
      case "full":
        if (slot.isHorizontalRule && firstHorizontalRule === null) {
          firstHorizontalRule = slot.sourceRange;
        }
        break;
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
