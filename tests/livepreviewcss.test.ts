// Regression guard for the Live Preview click→line mapping bug.
//
// CodeMirror 6 does not support vertical margins on lines or block widgets:
// its height map measures border-box heights only, so any vertical margin on
// a `.cm-line` or `.cm-embed-block` desyncs CM's geometry model from the
// visual layout, and mouse clicks resolve to the wrong document line. The
// observed symptom: clicking the last notes line before the summary placed
// the cursor inside the summary (the error compounds toward the bottom of the
// note because collapsed gap lines pack many lines into few pixels of model
// space). Spacing in the CM6 section must therefore be padding, never margin.
//
// This test parses styles.css and fails if any rule whose selector targets
// `.cm-line` or `.cm-embed-block` declares a nonzero vertical margin. The
// full behavioural repro (real CM6 editor + headless Chromium probing
// posAtCoords round-trips) lives in tests/lpclick-harness/ and is run
// manually: `node tests/lpclick-harness/run.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface CssRule {
  selector: string;
  body: string;
}

/** Tolerant flattening CSS rule scanner: strips comments, descends into
 *  at-rule blocks (`@media`, `@supports`), and yields `selector { body }`
 *  pairs. Good enough for a hand-written stylesheet; not a spec parser. */
function extractRules(css: string): CssRule[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  const walk = (chunk: string): void => {
    let i = 0;
    while (i < chunk.length) {
      const open = chunk.indexOf("{", i);
      if (open === -1) break;
      const selector = chunk.slice(i, open).trim();
      // Find the matching close brace (at-rule blocks nest).
      let depth = 1;
      let j = open + 1;
      while (j < chunk.length && depth > 0) {
        if (chunk[j] === "{") depth++;
        else if (chunk[j] === "}") depth--;
        j++;
      }
      const body = chunk.slice(open + 1, j - 1);
      if (selector.startsWith("@")) {
        walk(body);
      } else {
        rules.push({ selector, body });
      }
      i = j;
    }
  };
  walk(noComments);
  return rules;
}

/** Split a shorthand value on top-level whitespace (spaces inside `calc()` /
 *  `var()` don't separate components). `!important` is dropped. */
function splitComponents(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts.filter((p) => p !== "!important");
}

const isZero = (v: string): boolean => /^-?0(px|em|rem|%)?$/.test(v);

/** Nonzero vertical components of any margin declaration in a rule body. */
function verticalMarginViolations(body: string): string[] {
  const found: string[] = [];
  for (const decl of body.split(";")) {
    const colon = decl.indexOf(":");
    if (colon === -1) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (prop === "margin-top" || prop === "margin-bottom") {
      const v = splitComponents(value)[0] ?? "";
      if (!isZero(v)) found.push(`${prop}: ${value}`);
    } else if (prop === "margin") {
      const parts = splitComponents(value);
      // CSS shorthand expansion: top is parts[0]; bottom is parts[2] when
      // given, else parts[0].
      const top = parts[0] ?? "";
      const bottom = parts.length >= 3 ? parts[2] : top;
      if (!isZero(top) || !isZero(bottom)) found.push(`${prop}: ${value}`);
    }
  }
  return found;
}

const STYLES = readFileSync(
  join(__dirname, "..", "..", "styles.css"),
  "utf8"
);

test("scanner catches a vertical margin on a CM6 selector (self-check)", () => {
  const fixture = `
    .cornell-note .cm-line[data-x] { margin-top: var(--cue-gap); }
    .other { margin-top: 4px; }
  `;
  const bad = extractRules(fixture).filter(
    (r) =>
      /\.cm-line|\.cm-embed-block/.test(r.selector) &&
      verticalMarginViolations(r.body).length > 0
  );
  assert.equal(bad.length, 1);
});

test("no CM6 line/widget rule declares a nonzero vertical margin", () => {
  const violations: string[] = [];
  for (const rule of extractRules(STYLES)) {
    if (!/\.cm-line|\.cm-embed-block/.test(rule.selector)) continue;
    for (const v of verticalMarginViolations(rule.body)) {
      violations.push(`${rule.selector.replace(/\s+/g, " ")}  →  ${v}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    "Vertical margins on CM6 lines/widgets break click→line mapping " +
      "(CM6's height map ignores margins). Use padding instead.\n" +
      violations.join("\n")
  );
});
