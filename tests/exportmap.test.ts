// Export-mapping tests: the pure slot→rendered-block assignment the PDF export
// stamps from (exportMap.ts). Slots come from the real classifier via
// classifyPrintable, shapes mimic what pdfExport's DOM reader extracts —
// external behaviour only (the assignments), never mapper internals.
import test from "node:test";
import assert from "node:assert/strict";
import {
  type BlockShape,
  buildPrintableMarkdown,
  classifyPrintable,
  mapSlotsToBlocks,
} from "../exportMap";

const cue: BlockShape = { kind: "callout", calloutType: "cue" };
const summary: BlockShape = { kind: "callout", calloutType: "summary" };
const title: BlockShape = { kind: "callout", calloutType: "title" };
const admonition: BlockShape = { kind: "callout", calloutType: "note" };
const heading: BlockShape = { kind: "heading" };
const hr: BlockShape = { kind: "hr" };
const chrome: BlockShape = { kind: "chrome" };
const para: BlockShape = { kind: "other" };

const roles = (
  slots: ReturnType<typeof classifyPrintable>,
  shapes: BlockShape[]
) => mapSlotsToBlocks(slots, shapes).map((a) => a.role);

test("printable markdown always leads with the injected file-name title", () => {
  const printable = buildPrintableMarkdown(
    "---\ncssclasses:\n  - cornell-note\n---\n\n> [!cue] Q\n\nA.\n",
    "Biology 101"
  );
  assert.ok(printable.startsWith("> [!title] Biology 101\n"));
  assert.ok(!printable.includes("cssclasses"));
  const slots = classifyPrintable(printable);
  assert.equal(slots[0]?.role, "title");
});

test("a basic sheet maps title, cue, body run, summary in order", () => {
  const printable = buildPrintableMarkdown(
    "> [!cue] Q\n\nFirst paragraph.\n\nSecond paragraph.\n\n> [!summary]\n> S.\n",
    "Note"
  );
  const out = mapSlotsToBlocks(classifyPrintable(printable), [
    title,
    cue,
    para,
    para,
    summary,
  ]);
  assert.deepEqual(
    out.map((a) => a.role),
    ["title", "cue", "body", "body", "summary"]
  );
  // The divider breaks once, on the LAST body block before the summary.
  assert.deepEqual(
    out.map((a) => a.notesEnd),
    [false, false, false, true, false]
  );
});

test("an in-region heading takes the classifier's region, not a re-derivation", () => {
  const printable = buildPrintableMarkdown(
    "> [!cue] Topic\n## Topic\n\nNotes.\n",
    "Note"
  );
  const out = mapSlotsToBlocks(classifyPrintable(printable), [
    title,
    cue,
    heading,
    para,
  ]);
  assert.equal(out[2].role, "heading");
  assert.equal(out[2].inRegion, true);
  assert.equal(out[3].notesEnd, true);
});

test("an orphan heading after the injected title is not in-region", () => {
  const printable = buildPrintableMarkdown(
    "## Intro\n\nLoose text.\n\n> [!cue] Q\n\nA.\n",
    "Note"
  );
  const out = mapSlotsToBlocks(classifyPrintable(printable), [
    title,
    heading,
    para,
    cue,
    para,
  ]);
  assert.equal(out[1].role, "heading");
  assert.equal(out[1].inRegion, false);
});

test("admonition callouts are body content and keep the divider running", () => {
  const printable = buildPrintableMarkdown(
    "> [!cue] Q\n\nText.\n\n> [!note]\n> Aside.\n\n> [!cue] Q2\n\nA2.\n",
    "Note"
  );
  const out = mapSlotsToBlocks(classifyPrintable(printable), [
    title,
    cue,
    para,
    admonition,
    cue,
    para,
  ]);
  assert.deepEqual(
    out.map((a) => a.role),
    ["title", "cue", "body", "body", "cue", "body"]
  );
  // Divider breaks before the second cue and at the end — not mid-region.
  assert.deepEqual(
    out.map((a) => a.notesEnd),
    [false, false, false, true, false, true]
  );
});

test("rules and chrome get no slot attribute; chrome consumes no slot", () => {
  const printable = buildPrintableMarkdown(
    "> [!cue] Q\n\nA.\n\n---\n\n> [!summary]\n> S.\n",
    "Note"
  );
  const out = mapSlotsToBlocks(classifyPrintable(printable), [
    chrome,
    title,
    cue,
    para,
    hr,
    summary,
  ]);
  assert.deepEqual(
    out.map((a) => a.role),
    [null, "title", "cue", "body", null, "summary"]
  );
});

test("a second page title maps to the second title slot", () => {
  const printable = buildPrintableMarkdown(
    "> [!cue] Q\n\nA.\n\n> [!title] Page two\n\n> [!cue] Q2\n\nA2.\n",
    "Note"
  );
  const out = mapSlotsToBlocks(classifyPrintable(printable), [
    title,
    cue,
    para,
    title,
    cue,
    para,
  ]);
  assert.deepEqual(
    out.map((a) => a.role),
    ["title", "cue", "body", "title", "cue", "body"]
  );
});

test("with no slots every shape falls back to its structural reading", () => {
  // This is the built-in Export to PDF path (stampExportHost): same mapper,
  // empty slot list — must reproduce the old DOM-only stamper exactly.
  const out = mapSlotsToBlocks([], [chrome, title, cue, heading, para, summary]);
  assert.deepEqual(
    out.map((a) => a.role),
    [null, "title", "cue", "heading", "body", "summary"]
  );
  // Structural region tracking: cue opened a region, so the heading divides.
  assert.equal(out[3].inRegion, true);
  assert.deepEqual(
    out.map((a) => a.notesEnd),
    [false, false, false, false, true, false]
  );
});

test("a surprise block degrades that block only, not everything after it", () => {
  const printable = buildPrintableMarkdown("> [!cue] Q\n\nA.\n", "Note");
  // A plugin injected an extra cue the source never had: it falls back
  // structurally, and the REAL cue + body still map from the slots.
  const out = mapSlotsToBlocks(classifyPrintable(printable), [
    title,
    cue,
    para,
    cue,
  ]);
  assert.deepEqual(
    out.map((a) => a.role),
    ["title", "cue", "body", "cue"]
  );
});
