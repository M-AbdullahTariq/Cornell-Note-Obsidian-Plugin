# Changelog

All notable changes to the Cornell Notes plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1]

### Fixed

- **Clicks in Live Preview land on the correct line.** Vertical spacing
  around the page title, the notes/summary separator, and the page-break gap
  was applied as CSS margins, which CodeMirror's height model does not
  measure — so clicks resolved against stale geometry and drifted downward,
  worst on the last notes line before the summary (the cursor jumped into the
  summary). All vertical spacing on editor lines and block widgets is now
  padding; the layout is visually unchanged. Guarded by a stylesheet
  regression test and a headless click-mapping harness
  (`node tests/lpclick-harness/run.mjs`).

## [1.3.0]

### Added

- **Stable theming attributes.** Every Cornell block is marked with documented
  `data-cornell-*` attributes — block roles, editor-line roles, review-mode
  markers — shared by Reading view, Live Preview, and the PDF export. The
  vocabulary is listed in the README and treated as a public surface for
  themes and CSS snippets.

### Changed

- **The Live Preview title is now full-width.** The rendered `>[!title]`
  widget spans and centers on the full sheet width, matching Reading view, the
  PDF export, and the title's own source line — so the title no longer shifts
  sideways when the cursor enters or leaves it. (Previously the rendered
  widget sat centered within the notes column.)
- **One classification authority everywhere.** The PDF export now derives
  block placement from the same classifier both live views use, mapping its
  slots onto the rendered blocks by document order; the old DOM-only rule-set
  survives only as the fallback for Obsidian's built-in Export to PDF, and
  runs through the same mapper. Review-mode reveal semantics moved into a
  pure, unit-tested state model. The test suite grew from 32 to 56 tests.

### Fixed

- **Community CSS lint warnings resolved.** All `:has()` selectors are
  replaced by attributes the plugin stamps directly (no more broad selector
  invalidation), the grid no longer declares multicolumn-flagged gap
  properties, print rules use the legacy `page-break-*` spellings Chromium
  aliases natively, and the PDF capture element is selected by class instead
  of the non-standard `webview` type selector.

## [1.2.2]

### Changed

- Marked the plugin **desktop-only** (`isDesktopOnly: true`) so the community
  listing no longer advertises mobile support.

## [1.2.1]

### Changed

- Maintenance release for the Obsidian community review: passes the
  `eslint-plugin-obsidianmd` guideline checks across every source file. Two UI
  strings were reworded to sentence case (no rule-disable comments), the PDF
  export sets element sizing through `setCssStyles` instead of inline `style`
  attributes, uses the cross-window-safe `instanceOf` check, no longer returns a
  floating promise from the webview-setup listener, and drops an unnecessary
  type assertion. The lint script now covers the PDF-export modules too.

## [1.2.0]

### Added

- **Settings tabs.** The settings pane is split into a **Layout** tab (cue
  column width, divider color and thickness) and an **Optional** tab (PDF
  export, the review-mode hover highlight, and the cue/summary/title
  shortcuts), so the everyday layout knobs aren't crowded by the extras.
- **PDF export is now opt-in.** A new "Enable PDF export" toggle on the
  Optional tab controls whether the right-click "Export PDF" option appears.
  Off by default; turn it on to export.

### Fixed

- **Cue/notes alignment in editing view.** Cues now sit on the same row as the
  first line of their notes. The rendered cue widget had kept an explicit
  height that left empty space below the floating cue and pushed the notes down
  a full block.
- **Title spacing in editing view.** A page title now sits a controlled gap
  above the first cue — matching Reading view — instead of the large gap left
  by blank source lines and the title widget's reserved padding. Blank lines
  around a title now collapse in Live Preview the way the post-cue gap already
  did.
- **Doubled notes/summary separator in editing view.** The rule above the
  summary drew twice when the callout widget was wrapped in nested blocks; it
  now draws exactly once, on the summary callout itself.
- Over-limit page titles are flagged in editing view too (red text + tooltip),
  matching Reading view.

## [1.1.0]

### Added

- **Export to PDF.** Right-click a Cornell note — or a folder of them — to
  export. A modal lists the in-scope notes (a folder includes every Cornell
  note beneath it, so right-clicking the vault root is the "export all" path),
  with checkboxes to choose which to include and a Render-preview button that
  shows the selected notes as paper-like sheets before exporting. For multiple
  notes, export as **one PDF per note** (written next to each note) or a single
  **combined PDF** with each note on a fresh page, written to a file name and
  folder you choose. Every sheet is A4, shows the file name as its title, and
  reproduces the Reading-view layout (cue column, divider, summary band) on a
  light, paper-like background; review-mode blur never carries into the export.
  Desktop only.

## [1.0.2]

### Changed

- Sentence-cased the command name, ribbon tooltip, and two setting
  descriptions to satisfy the Obsidian review's UI-text rule. The "Create new
  note" command and ribbon no longer repeat the plugin name (the command
  palette already shows it).
- README title now matches the plugin name in `manifest.json`.

## [1.0.1]

### Changed

- Maintenance release for the Obsidian community review: passes the official
  `eslint-plugin-obsidianmd` guideline checks (use `activeDocument` for popout
  compatibility, typed `loadData()`, tidied union types and assertions) and
  drops the `builtin-modules` dependency in favor of Node's built-in. No
  user-facing behavior changes.

## [1.0.0]

### Added

- Licensed under the GNU General Public License v3.0.
- **Lazy-continuation guard.** A cue whose notes are glued directly beneath it
  with no blank line — which makes Markdown fold the paragraph *into* the cue
  callout — is now flagged with a red warning border and a tooltip prompting you
  to add the blank line. Works in both Reading view and Live Preview. Lists and
  tables (which start their own block) are not flagged.

### Changed

- **Headings now sit in the notes column.** A `#`–`######` heading renders in
  the notes column beside its cue instead of spanning the full page width, so
  Reading view matches Live Preview. The cue｜notes divider line runs unbroken
  through an in-region heading; a heading written before the first cue keeps the
  column but draws no divider segment. Headings still stay visible (as prompts)
  in review mode.

### Fixed

- **Heading fold arrow no longer collapses the whole sheet.** Obsidian's native
  heading-fold collapses by heading *level*, ignoring the cues between — so with
  a single heading it folded the entire note. The fold affordance is now
  suppressed inside Cornell notes (Reading view and Live Preview); folding in
  every other note is untouched.

## [0.1.0]

### Added

- Cornell-style layout, activated by the `cornell-note` cssclass: cue callouts
  in a left margin column, a full-width summary band across the bottom, and
  several Cornell pages stackable in one file.
- Renders in both Reading view and Live Preview, with titles and cues remaining
  inline-editable in Live Preview.
- `> [!title]` page titles — full-width and centered — with a file-name fallback
  when none is given; each title begins a new page.
- **Review mode** (Reading view): blurs each cue's notes region and the summary
  for active recall; click a cue to reveal its region, click the summary to
  reveal it. Cue titles, the page title, and in-region headings stay visible as
  prompts. Reset and toggle commands included.
- Configurable cue / summary / title auto-expand shortcuts, validated to keep
  their trigger words distinct.
- Settings for cue column width, divider line color and thickness, and an
  optional review-mode hover highlight.
- Commands: "Create new Cornell note", "Toggle review mode", and "Reset review
  reveals (re-blur all)".

### Fixed

- Adjacent cues (with no body block between them) are flagged rather than
  overlapping in Live Preview.
- One continuous divider line per cue's notes region — paragraphs, tables,
  lists, images, and embedded callouts all connect.
- Table cell text no longer indents into the cue column while being edited in
  Live Preview.
