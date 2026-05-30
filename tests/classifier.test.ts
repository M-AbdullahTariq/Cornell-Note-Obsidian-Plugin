import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBlocks, type Slot } from "../classifier";

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

test("a cue with a body block is not flagged invalid", () => {
  const md = `> [!cue] Valid
## Valid

body
`;
  const cue = classifyBlocks(md, FM).find((s) => s.role === "cue");
  assert.equal(cue?.invalid, undefined);
});
