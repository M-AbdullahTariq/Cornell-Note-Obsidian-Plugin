import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBlocks, classifySection, type Slot } from "../classifier";

// The Classifier is the single source of truth for block placement. These
// tests assert its observable output — the ordered sequence of slot roles and
// the cue-specific facts (anchor, invalid) — which is the contract both
// renderers depend on. They do not reach into private line classification.

const FM = { cssclasses: ["cornell-note"] };

function roles(md: string): string[] {
  return classifyBlocks(md, FM).map((s) => s.role);
}
function bySource(md: string, marker: string): Slot {
  const slots = classifyBlocks(md, FM);
  const idx = (() => {
    const offset = md.indexOf(marker);
    return slots.findIndex(
      (s) => offset >= s.sourceRange.from && offset < s.sourceRange.to
    );
  })();
  assert.ok(idx >= 0, `no slot covers marker: ${marker}`);
  return slots[idx];
}

test("a non-Cornell note yields no slots", () => {
  assert.deepEqual(classifyBlocks("# Hi\n\ntext\n", {}), []);
});

test("a cue, its body, and a summary classify in document order", () => {
  const md = `---
cssclasses:
  - cornell-note
---

> [!cue] Topic
## Topic

Body text.

> [!summary]
> Wrap up.
`;
  // frontmatter(full), cue, heading(full), body, summary. No gap slot: the
  // heading follows the cue with no blank line between them.
  assert.deepEqual(roles(md), ["full", "cue", "full", "body", "summary"]);
});

test("a cue records the body block it anchors to", () => {
  const md = `> [!cue] A

ANCHOR_BODY
`;
  const cue = bySource(md, "[!cue] A");
  assert.equal(cue.role, "cue");
  assert.ok(cue.anchorBlockRange, "cue should have an anchor");
  const anchorText = md.slice(
    cue.anchorBlockRange!.from,
    cue.anchorBlockRange!.to
  );
  assert.ok(anchorText.includes("ANCHOR_BODY"));
});

test("adjacent cues are both flagged invalid", () => {
  const md = `> [!cue] A

> [!cue] B

body
`;
  const slots = classifyBlocks(md, FM);
  const cues = slots.filter((s) => s.role === "cue");
  assert.equal(cues.length, 2);
  assert.ok(cues.every((c) => c.invalid === "adjacent-cue"));
});

test("blank lines after a cue become a gap slot", () => {
  const md = `> [!cue] A


body
`;
  const slots = classifyBlocks(md, FM);
  assert.equal(slots[0].role, "cue");
  assert.equal(slots[1].role, "gap");
  // two blank lines collapsed into one gap slot
  assert.equal(slots[1].lineRanges.length, 2);
});

test("a horizontal rule is a flagged full-width slot", () => {
  const md = `> [!cue] A
## A

body

---

more
`;
  const rule = classifyBlocks(md, FM).find((s) => s.isHorizontalRule);
  assert.ok(rule, "should find a horizontal-rule slot");
  assert.equal(rule!.role, "full");
});

test("a body slot exposes per-line ranges for Live Preview", () => {
  const md = `> [!cue] A

line one
line two
line three
`;
  const body = classifyBlocks(md, FM).find((s) => s.role === "body");
  assert.ok(body);
  assert.equal(body!.lineRanges.length, 3);
});

/** True when `marker` falls inside some body slot (i.e. it gets the divider). */
function bodyCovers(md: string, marker: string): boolean {
  const off = md.indexOf(marker);
  assert.ok(off >= 0, `marker not found: ${marker}`);
  return classifyBlocks(md, FM).some(
    (s) => s.role === "body" && off >= s.sourceRange.from && off < s.sourceRange.to
  );
}

// Regression: body content after the summary's `---` must still be body
// (the divider bug). Both the pre-rule and post-summary blocks count.
test("body before and after the summary rule are both body slots", () => {
  const md = `---
cssclasses:
  - cornell-note
---

> [!cue] One
## One

FIRST_BODY

---

# Summary

> [!summary]
> sum

---

> [!cue] Two

POST_SUMMARY_BODY
`;
  assert.ok(bodyCovers(md, "FIRST_BODY"));
  assert.ok(bodyCovers(md, "POST_SUMMARY_BODY"));
});

test("a table after a cue is a body slot", () => {
  const md = `> [!cue] T

| TABLE_HEAD | b |
| --- | --- |
| 1 | 2 |
`;
  assert.ok(bodyCovers(md, "TABLE_HEAD"));
});

// A non-cue / non-summary callout under a cue is notes content: it must be a
// body slot so it joins the notes column and carries the divider line, just
// like a paragraph, table, or image. (Cue and summary callouts keep their own
// roles; only "other" callouts changed.)
test("a note/tip callout is a body slot (gets the divider)", () => {
  const md = `> [!cue] C

> [!note] NESTED_NOTE
> body of the admonition

> [!tip] NESTED_TIP
> a tip
`;
  assert.ok(bodyCovers(md, "NESTED_NOTE"));
  assert.ok(bodyCovers(md, "NESTED_TIP"));
  // The two cue/summary roles are unaffected; no slot here is "full".
  assert.ok(!classifyBlocks(md, FM).some((s) => s.role === "full"));
});

// The summary callout still resolves to its own role, not body — only generic
// callouts were redirected.
test("the summary callout is still a summary slot, not body", () => {
  const md = `> [!cue] C

body

> [!summary]
> SUMMARY_TEXT
`;
  const summary = classifyBlocks(md, FM).find((s) => s.role === "summary");
  assert.ok(summary, "summary callout should keep the summary role");
  assert.ok(!bodyCovers(md, "SUMMARY_TEXT"));
});

// Regression for the divider-continuity bug (wrong.jpg): within one cue's
// notes region the divider must be unbroken, breaking only before the next
// cue. The classifier marks the LAST body block of each region with notesEnd;
// interior body blocks (paragraph → table → paragraph) must NOT be marked, so
// Reading view keeps their divider segments connected.
test("only the last body block of a cue region is flagged notesEnd", () => {
  const md = `> [!cue] crazy how this works?

PARA_ONE

| AWD | AD |
| --- | --- |
| 1 | 2 |

PARA_TWO

> [!cue] next cue

LAST_REGION
`;
  const slots = classifyBlocks(md, FM);
  const bodies = slots.filter((s) => s.role === "body");
  // three blocks in region one (paragraph, table, paragraph) + one in region two
  assert.equal(bodies.length, 4);
  const flagOf = (marker: string) =>
    bodies.find(
      (b) =>
        md.indexOf(marker) >= b.sourceRange.from &&
        md.indexOf(marker) < b.sourceRange.to
    )?.notesEnd ?? false;
  assert.equal(flagOf("PARA_ONE"), false); // interior — divider continues
  assert.equal(flagOf("AWD"), false); // interior table — divider continues
  assert.equal(flagOf("PARA_TWO"), true); // last of region one — break here
  assert.equal(flagOf("LAST_REGION"), true); // last block overall — break
});

// Regression for the real-note bug: a table immediately followed by a one-line
// paragraph (no blank between) is ONE body slot but renders as TWO sections in
// Obsidian. Only the trailing-paragraph section (the slot's last line) may
// break the divider; the table section must stay connected.
test("a notesEnd body slot breaks the divider only on its last line", () => {
  // 0-based lines: 0 cue, 1 blank, 2 table, 3 table, 4 table, 5 "Ad",
  //                6 blank, 7 cue, 8 blank, 9 body
  const md = `>[!cue] one

| Awd | Ad |
| --- | --- |
| Awdawd | Awd |
Ad

>[!cue] two

next region
`;
  // The table+"Ad" body slot spans lines 2..5 and is notesEnd.
  const tableSlot = classifyBlocks(md, FM).find(
    (s) => s.role === "body" && md.slice(s.sourceRange.from, s.sourceRange.to).includes("Awd")
  );
  assert.ok(tableSlot?.notesEnd, "table+Ad slot should be notesEnd");

  // The table section (lines 2..4) is interior → must NOT break.
  assert.equal(classifySection(md, FM, 2, 4)?.notesEnd, false);
  // The trailing "Ad" section (line 5) is the region tail → breaks.
  assert.equal(classifySection(md, FM, 5, 5)?.notesEnd, true);
  // The whole slot rendered as one section (lines 2..5) also breaks (at bottom).
  assert.equal(classifySection(md, FM, 2, 5)?.notesEnd, true);
});

test("classifySection reports the slot role and never breaks on a cue", () => {
  const md = `>[!cue] a

body
`;
  assert.equal(classifySection(md, FM, 0, 0)?.slot.role, "cue");
  assert.equal(classifySection(md, FM, 0, 0)?.notesEnd, false);
});

test("a cue with a body block is not flagged invalid", () => {
  const md = `> [!cue] Valid
## Valid

body
`;
  const cue = classifyBlocks(md, FM).find((s) => s.role === "cue");
  assert.equal(cue?.invalid, undefined);
});

test("a paragraph glued to a cue (no blank line) is flagged lazy-body", () => {
  // Markdown lazy continuation folds this paragraph into the cue callout.
  const md = `> [!cue] Topic
Notes glued directly under the cue.

> [!summary]
> Wrap up.
`;
  const cue = classifyBlocks(md, FM).find((s) => s.role === "cue");
  assert.equal(cue?.invalid, "lazy-body");
});

test("a blank line between a cue and its paragraph clears lazy-body", () => {
  const md = `> [!cue] Topic

Notes separated by a blank line.
`;
  const cue = classifyBlocks(md, FM).find((s) => s.role === "cue");
  assert.equal(cue?.invalid, undefined);
});

test("a list or table glued to a cue is not lazy-body (it breaks out of the callout)", () => {
  const list = `> [!cue] Topic
- item one
- item two
`;
  const table = `> [!cue] Topic
| a | b |
| - | - |
`;
  assert.equal(
    classifyBlocks(list, FM).find((s) => s.role === "cue")?.invalid,
    undefined
  );
  assert.equal(
    classifyBlocks(table, FM).find((s) => s.role === "cue")?.invalid,
    undefined
  );
});
