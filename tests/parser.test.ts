import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCornell } from "../parser";
import { buildCueLayout, invalidFlagsFromLayout } from "../cueLayout";

// Behavioral tests: assert what a reader/renderer observes about a note's
// placement — which source lines become body (get the divider), which cues
// are flagged invalid, whether the note is Cornell at all — never private
// helpers. These pin the placement contract that drifted between the two
// renderers, so the Phase-1 Classifier refactor can be checked against them.

const FM = { cssclasses: ["cornell-note"] };

function offsetToLine(md: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < md.length; i++) {
    if (md[i] === "\n") line++;
  }
  return line;
}

/** 1-based line number of the first line containing `marker`. */
function lineNo(md: string, marker: string): number {
  const lines = md.split("\n");
  const i = lines.findIndex((l) => l.includes(marker));
  assert.ok(i >= 0, `marker not found in fixture: ${marker}`);
  return i + 1;
}

/** Set of 1-based source line numbers that receive the body divider. */
function bodyLines(md: string): Set<number> {
  const r = parseCornell(md, FM);
  return new Set(r.bodyLineRanges.map((rng) => offsetToLine(md, rng.from)));
}

function invalidFlags(md: string): boolean[] {
  return invalidFlagsFromLayout(buildCueLayout(parseCornell(md, FM)));
}

// --- Regression: divider truncated after the first horizontal rule ---------
// A cue + body placed below the summary's `---` must still get the divider.
test("body blocks after the summary rule still get the divider", () => {
  const md = `---
cssclasses:
  - cornell-note
---

> [!cue] First topic
## First topic

FIRST_BODY before the rule

---

# Summary

> [!summary]
> The summary text.

---

> [!cue] how can we

POST_SUMMARY_BODY after the summary
ANOTHER_POST line
`;
  const body = bodyLines(md);
  assert.ok(body.has(lineNo(md, "FIRST_BODY")), "pre-rule body should get divider");
  assert.ok(body.has(lineNo(md, "POST_SUMMARY_BODY")), "post-summary body should get divider");
  assert.ok(body.has(lineNo(md, "ANOTHER_POST")), "post-summary body should get divider");
});

// --- Basic single-section classification -----------------------------------
test("a Cornell note exposes its cue and summary items", () => {
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
  const r = parseCornell(md, FM);
  assert.equal(r.isCornell, true);
  const cues = r.items.filter((i) => i.type === "cue");
  const summaries = r.items.filter((i) => i.type === "summary");
  assert.equal(cues.length, 1);
  assert.equal(summaries.length, 1);
  assert.ok(bodyLines(md).has(lineNo(md, "Body text.")));
});

// --- Tables count as body content ------------------------------------------
test("a table after a cue is treated as body content", () => {
  const md = `---
cssclasses:
  - cornell-note
---

> [!cue] Data

| TABLE_HEAD | b |
| --- | --- |
| 1 | 2 |
`;
  assert.ok(bodyLines(md).has(lineNo(md, "TABLE_HEAD")));
});

// --- Adjacent cues are both flagged invalid --------------------------------
test("two cues with no body between them are both flagged invalid", () => {
  const md = `---
cssclasses:
  - cornell-note
---

> [!cue] A

> [!cue] B

Body after B.
`;
  assert.deepEqual(invalidFlags(md), [true, true]);
});

// --- A valid cue with a body block is not flagged --------------------------
test("a cue with a body block is not flagged invalid", () => {
  const md = `---
cssclasses:
  - cornell-note
---

> [!cue] Valid
## Valid

Body here.
`;
  assert.deepEqual(invalidFlags(md), [false]);
});

// --- Non-Cornell notes are inert -------------------------------------------
test("a note without the cornell-note cssclass is not a Cornell note", () => {
  const md = `# Just a normal note

> [!cue] ignored

Some text.
`;
  const r = parseCornell(md, {});
  assert.equal(r.isCornell, false);
  assert.equal(r.items.length, 0);
  assert.equal(r.bodyLineRanges.length, 0);
});
