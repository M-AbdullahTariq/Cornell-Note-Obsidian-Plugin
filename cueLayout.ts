// Pure module — no DOM, no Obsidian, no CodeMirror.
// Reshapes the parser's output into per-row descriptors that both renderers
// (Reading view post-processor, Live Preview ViewPlugin) consume to decide
// what goes in the cue column vs the body column, and which cues are flagged.

import type { CornellParseResult, Range } from "./parser";

export interface CueRow {
  /** Source range of the cue's callout (start line + any continuation lines). */
  cueRange: Range;
  /** Source range of the body block this cue anchors to, or null when the
   *  cue has no external body block (only internal `>` continuation, or it
   *  is an invalid adjacent cue with no body before the next cue). */
  bodyRange: Range | null;
  /** True when the parser flagged this cue as part of an adjacent-cue pair. */
  isInvalid: boolean;
}

export function buildCueLayout(parsed: CornellParseResult): CueRow[] {
  if (!parsed.isCornell) return [];
  const rows: CueRow[] = [];
  for (const item of parsed.items) {
    if (item.type !== "cue") continue;
    // The parser falls back to sourceRange when no real anchor body block
    // exists. Treat that self-anchor case as "no body" so renderers can
    // decide to leave the body column empty for this row.
    const hasRealBody =
      item.anchorBlockRange !== null &&
      item.anchorBlockRange.from !== item.sourceRange.from;
    rows.push({
      cueRange: item.sourceRange,
      bodyRange: hasRealBody ? item.anchorBlockRange : null,
      isInvalid: item.invalid === "adjacent-cue",
    });
  }
  return rows;
}

/** Convenience: per-cue boolean flag list in the same order rendered cue
 *  DOM nodes appear, so renderers can `forEach((el, i) => el.classList.toggle(..., flags[i]))`. */
export function invalidFlagsFromLayout(rows: CueRow[]): boolean[] {
  return rows.map((r) => r.isInvalid);
}
