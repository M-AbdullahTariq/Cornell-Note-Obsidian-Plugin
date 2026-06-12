// Pure export decisions — no Obsidian, no DOM (mirrors classifier.ts's
// discipline, and bundles for the Node test runner the same way).
//
// The PDF export has the note's markdown source, so block placement comes from
// the classifier — the same authority both live views use — instead of a
// parallel structural rule-set. This module owns the two pure halves of that:
// building the printable markdown, and mapping the classifier's slots onto the
// rendered top-level blocks by document order. pdfExport.ts wraps these with
// the thin DOM/Electron shell.

import { classifyBlocks, type Slot } from "./classifier";

/** Strip a single leading YAML frontmatter block (`---` … `---`) from source. */
function stripFrontmatter(source: string): string {
  const m = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? source.slice(m[0].length) : source;
}

/** Pure: decide the markdown to render for the PDF. Frontmatter is stripped (the
 *  renderer ignores it anyway) and the file name is ALWAYS injected as a leading
 *  `> [!title]` callout, so every exported sheet shows the file name as its title.
 *  A note that already leads with its own `> [!title]` keeps it — that title
 *  renders just below the file-name title. */
export function buildPrintableMarkdown(source: string, basename: string): string {
  const body = stripFrontmatter(source);
  const safeTitle = basename.replace(/[\r\n]+/g, " ").trim();
  return `> [!title] ${safeTitle}\n\n${body}`;
}

/** Classify printable markdown (the `buildPrintableMarkdown` output). Its
 *  frontmatter is already stripped, and the caller only exports notes that
 *  passed the Cornell check, so the cssclass is supplied synthetically. */
export function classifyPrintable(markdown: string): Slot[] {
  return classifyBlocks(markdown, { cssclasses: ["cornell-note"] });
}

/** The structural signature of one rendered top-level block, extracted from the
 *  export DOM by pdfExport.ts. Deliberately dumb: shapes exist only to ALIGN
 *  the classifier's slot list with the rendered children — the slots carry the
 *  actual placement decisions. */
export interface BlockShape {
  kind: "callout" | "heading" | "hr" | "chrome" | "other";
  /** `callout` only: the `data-callout` type ("cue", "summary", "title", or
   *  anything else for admonitions, which render as body content). */
  calloutType?: string;
}

/** What the export stamps on one rendered block: the slot role (null → no
 *  attribute, full-width default), the in-region divider marker for headings,
 *  and the notes-end divider break. */
export interface BlockAssignment {
  role: "cue" | "summary" | "title" | "heading" | "body" | null;
  inRegion: boolean;
  notesEnd: boolean;
}

type AnchorKind = "cue" | "summary" | "title" | "heading" | "hr";

/** A shape that can be matched 1:1 against a specific slot. Bodies are not
 *  anchors: one body slot can cover a RUN of rendered blocks (paragraph +
 *  table + list under one cue), so body children never advance the slot
 *  cursor — they inherit "body" until the next anchor re-synchronises. */
function anchorKind(shape: BlockShape): AnchorKind | null {
  if (shape.kind === "callout") {
    const t = shape.calloutType;
    return t === "cue" || t === "summary" || t === "title" ? t : null;
  }
  if (shape.kind === "heading") return "heading";
  if (shape.kind === "hr") return "hr";
  return null;
}

function slotMatches(slot: Slot, anchor: AnchorKind): boolean {
  switch (anchor) {
    case "cue":
    case "summary":
    case "title":
      return slot.role === anchor;
    case "heading":
      return slot.role === "full" && !!slot.isHeading;
    case "hr":
      return slot.role === "full" && !!slot.isHorizontalRule;
  }
}

/** Pure: assign a role to every rendered block by walking the classifier's
 *  slot list and the rendered blocks' shapes in parallel document order.
 *
 *  Anchor shapes (cue / summary / title callouts, headings, rules) consume the
 *  next matching slot — the classifier's decision (e.g. a heading's owning
 *  cue region) rides along. Chrome (frontmatter, properties, the inline
 *  title) is skipped without consuming a slot, since the classifier never saw
 *  it. Everything else is body content under the most recent cue.
 *
 *  When a shape finds no matching slot (a plugin injected DOM the source never
 *  had, or render order diverged), the assignment falls back to the shape's
 *  own structural reading — per block, so one surprise can't shift every
 *  block after it. The fallback tracks cue regions structurally (a cue opens,
 *  a title or summary closes), exactly like the old DOM-only stamper.
 *
 *  `notesEnd` is a post-pass over the assigned roles: the last
 *  divider-carrying block (body, or in-region heading) before a
 *  non-divider block breaks the line, mirroring Reading view's behaviour. */
export function mapSlotsToBlocks(
  slots: Slot[],
  shapes: BlockShape[]
): BlockAssignment[] {
  const assigned: { role: BlockAssignment["role"]; inRegion: boolean }[] = [];
  let j = 0;
  // Structural region state, used only by the no-matching-slot fallback.
  let fallbackActive = false;

  for (const shape of shapes) {
    if (shape.kind === "chrome") {
      assigned.push({ role: null, inRegion: false });
      continue;
    }
    const anchor = anchorKind(shape);
    if (anchor) {
      let k = j;
      while (k < slots.length && !slotMatches(slots[k], anchor)) k++;
      if (k < slots.length) {
        const slot = slots[k];
        j = k + 1;
        if (anchor === "hr") {
          assigned.push({ role: null, inRegion: false });
        } else if (anchor === "heading") {
          assigned.push({ role: "heading", inRegion: slot.cueGroup != null });
        } else {
          assigned.push({ role: anchor, inRegion: false });
        }
      } else if (anchor === "hr") {
        assigned.push({ role: null, inRegion: false });
      } else if (anchor === "heading") {
        assigned.push({ role: "heading", inRegion: fallbackActive });
      } else {
        assigned.push({ role: anchor, inRegion: false });
      }
    } else {
      assigned.push({ role: "body", inRegion: false });
    }
    const role = assigned[assigned.length - 1].role;
    if (role === "cue") fallbackActive = true;
    else if (role === "title" || role === "summary") fallbackActive = false;
  }

  const dividing = (i: number): boolean => {
    const a = assigned[i];
    return !!a && (a.role === "body" || (a.role === "heading" && a.inRegion));
  };
  return assigned.map((a, i) => ({
    ...a,
    notesEnd: dividing(i) && !dividing(i + 1),
  }));
}
