// Marking-vocabulary tests: the attribute set `slotAttributes` produces for a
// classified note — the contract the Reading-view post-processor stamps onto
// block wrappers. Pure: classify a markdown sample, pick slots by role, assert
// the attribute map. External behaviour only (the map), never classifier
// internals.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTR_CUE_GROUP,
  ATTR_IN_REGION,
  ATTR_NOTES_END,
  ATTR_PAGE_BREAK,
  ATTR_REVIEW_BLUR,
  ATTR_SLOT,
  classifyBlocks,
  slotAttributes,
  type Slot,
} from "../classifier";

const FRONTMATTER = { cssclasses: ["cornell-note"] };

const classify = (markdown: string): Slot[] =>
  classifyBlocks(markdown, FRONTMATTER);

const BASIC_NOTE = [
  "> [!cue] What is a habit?",
  "",
  "A routine repeated until automatic.",
  "",
  "> [!summary]",
  "> Habits compound.",
  "",
].join("\n");

test("a cue stamps its slot and reveal group but never blurs", () => {
  const slot = classify(BASIC_NOTE).find((s) => s.role === "cue");
  assert.ok(slot);
  const attrs = slotAttributes(slot, false);
  assert.equal(attrs[ATTR_SLOT], "cue");
  assert.equal(attrs[ATTR_CUE_GROUP], "cue:0");
  assert.equal(attrs[ATTR_REVIEW_BLUR], null);
  assert.equal(attrs[ATTR_IN_REGION], null);
  assert.equal(attrs[ATTR_PAGE_BREAK], null);
});

test("a body block blurs under its owning cue's group", () => {
  const slot = classify(BASIC_NOTE).find((s) => s.role === "body");
  assert.ok(slot);
  const attrs = slotAttributes(slot, false);
  assert.equal(attrs[ATTR_SLOT], "body");
  assert.equal(attrs[ATTR_CUE_GROUP], "cue:0");
  assert.equal(attrs[ATTR_REVIEW_BLUR], "");
});

test("notes-end is the caller's per-section decision", () => {
  const slot = classify(BASIC_NOTE).find((s) => s.role === "body");
  assert.ok(slot);
  assert.equal(slotAttributes(slot, true)[ATTR_NOTES_END], "");
  assert.equal(slotAttributes(slot, false)[ATTR_NOTES_END], null);
});

test("the summary blurs and reveals itself, keyed per page", () => {
  const slot = classify(BASIC_NOTE).find((s) => s.role === "summary");
  assert.ok(slot);
  const attrs = slotAttributes(slot, false);
  assert.equal(attrs[ATTR_SLOT], "summary");
  assert.equal(attrs[ATTR_CUE_GROUP], "summary:0");
  assert.equal(attrs[ATTR_REVIEW_BLUR], "");
});

test("an in-region heading stamps heading + in-region, no blur", () => {
  const note = [
    "> [!cue] Topic",
    "## Topic",
    "",
    "Notes under the heading.",
    "",
  ].join("\n");
  const slot = classify(note).find((s) => s.isHeading);
  assert.ok(slot);
  const attrs = slotAttributes(slot, false);
  assert.equal(attrs[ATTR_SLOT], "heading");
  assert.equal(attrs[ATTR_IN_REGION], "");
  assert.equal(attrs[ATTR_REVIEW_BLUR], null);
});

test("an orphan heading (before any cue) is not in-region", () => {
  const note = ["## Orphan", "", "> [!cue] Q", "", "A.", ""].join("\n");
  const slot = classify(note).find((s) => s.isHeading);
  assert.ok(slot);
  assert.equal(slotAttributes(slot, false)[ATTR_IN_REGION], null);
});

test("every page title after the first carries the page-break marker", () => {
  const note = [
    "> [!title] Page one",
    "",
    "> [!cue] Q",
    "",
    "A.",
    "",
    "> [!title] Page two",
    "",
  ].join("\n");
  const titles = classify(note).filter((s) => s.role === "title");
  assert.equal(titles.length, 2);
  assert.equal(slotAttributes(titles[0], false)[ATTR_PAGE_BREAK], null);
  assert.equal(slotAttributes(titles[1], false)[ATTR_PAGE_BREAK], "");
  assert.equal(slotAttributes(titles[0], false)[ATTR_SLOT], "title");
});

test("orphan body content before the first cue gets no reveal group", () => {
  const note = ["Loose intro paragraph.", "", "> [!cue] Q", "", "A.", ""].join(
    "\n"
  );
  const slot = classify(note).find((s) => s.role === "body");
  assert.ok(slot);
  const attrs = slotAttributes(slot, false);
  assert.equal(attrs[ATTR_CUE_GROUP], null);
  assert.equal(attrs[ATTR_REVIEW_BLUR], null);
});
