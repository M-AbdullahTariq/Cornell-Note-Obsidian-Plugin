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
