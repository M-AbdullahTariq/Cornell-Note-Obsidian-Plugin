import { test } from "node:test";
import assert from "node:assert/strict";
import { slotForLineRange } from "../classifier";

// The Reading-view bridge maps a source line range (what ctx.getSectionInfo
// reports) to a slot, so the post-processor can stamp data-cornell-slot on the
// right wrapper. Tested purely on line ranges — the DOM stamping itself is
// verified manually in Obsidian.

const FM = { cssclasses: ["cornell-note"] };

// 0-based lines:
//  0 ---             5 > [!cue] One   10 # Summary      15 ---
//  1 cssclasses:     6 ## One         11 (blank)        16 (blank)
//  2   - cornell..   7 (blank)        12 > [!summary]   17 > [!cue] Two
//  3 ---             8 body1          13 > sum          18 (blank)
//  4 (blank)         9 (blank)        14 (blank)        19 body2
const MD = `---
cssclasses:
  - cornell-note
---

> [!cue] One
## One

body1

# Summary

> [!summary]
> sum

---

> [!cue] Two

body2
`;

const roleAt = (start: number, end: number) =>
  slotForLineRange(MD, FM, start, end)?.role ?? null;

test("a cue section resolves to the cue slot", () => {
  assert.equal(roleAt(5, 5), "cue");
});

test("a body section resolves to the body slot", () => {
  assert.equal(roleAt(8, 8), "body");
});

test("a heading section resolves to a full slot", () => {
  assert.equal(roleAt(6, 6), "full"); // ## One
  assert.equal(roleAt(10, 10), "full"); // # Summary
});

test("the summary callout resolves to the summary slot", () => {
  assert.equal(roleAt(12, 13), "summary");
});

test("the horizontal rule resolves to a full slot", () => {
  assert.equal(roleAt(15, 15), "full");
});

test("a cue section after the summary still resolves to cue", () => {
  assert.equal(roleAt(17, 17), "cue");
});

test("body after the summary still resolves to body", () => {
  assert.equal(roleAt(19, 19), "body");
});

test("a line range covering no block returns null", () => {
  // line 4 is blank between frontmatter and the first cue — but the
  // frontmatter block spans 0..3, so 4 belongs to no slot.
  assert.equal(roleAt(4, 4), null);
});
