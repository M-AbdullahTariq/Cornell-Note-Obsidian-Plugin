# Cornell Notes — Obsidian Plugin

Cornell-style note layout for Obsidian using native callouts. A title sits across the top, cue callouts appear in a left margin column beside the notes, and a full-width summary band runs across the bottom. You can stack several Cornell pages in one file. Works in both Reading view and Live Preview — titles and cues remain inline-editable in Live Preview without switching to source mode.

## Usage

**Quickest path:** use the command palette (`Ctrl/Cmd-P` → "Create new Cornell note") or click the columns ribbon icon in the left sidebar. The plugin creates a new note in the current folder, pre-filled with the right frontmatter and a starter cue/summary skeleton.

To convert an existing note manually, add `cornell-note` to its `cssclasses` frontmatter:

```yaml
---
cssclasses:
  - cornell-note
---
```

(The legacy `cssclass: cornell-note` form is also accepted.)

Write cues as callouts before the heading or block they describe:

```markdown
> [!cue] Note's Layout
## Note's Layout

The Cornell method offers a specific layout for each page of notes.
```

Write the summary the same way at the bottom. It renders as a full-width band across **both** the cue and notes columns, like a classic Cornell sheet:

```markdown
> [!summary]
> The Cornell system encourages active engagement and structured review.
```

Use a standard `---` horizontal rule to separate sections **within** a single page. (A `---` does not start a new page — see below.)

### Titles and multiple pages

Give a page a title with a `> [!title]` callout. It renders full-width and centered across the top:

```markdown
> [!title] Photosynthesis
```

**File-name fallback:** if a page has no `> [!title]` (or the title is left empty), Obsidian's built-in inline title — the file name — is used as the title automatically, so every Cornell note always has a heading with zero effort. Type a `> [!title]` at the very top to override it; the file name's inline title is then hidden in favor of your title.

**Multiple pages in one file:** each `> [!title]` begins a new Cornell page — its own title, cues/notes, and summary — continuing until the next `> [!title]`. Consecutive pages are separated by a large whitespace gap (a page-break feel, no drawn line). Content written before the first `> [!title]` stays under the file-name title.

```markdown
> [!title] Page One
> [!cue] Cue
Notes for page one.

> [!summary]
> Summary of page one.

> [!title] Page Two
> [!cue] Cue
Notes for page two.

> [!summary]
> Summary of page two.
```

Anything you write under a cue — paragraphs, lists, tables, embedded images, code blocks, and even other callouts (`note`, `tip`, `warning`, …) — sits in the notes column and shares one continuous divider line, so the whole block reads as belonging to that cue. Only headings, the `---` rule, and the `summary` span the full page width.

### Faster cues

You can always type `> [!cue]` by hand. To speed it up, set a **Cue shortcut** in the settings (see below): type that word on its own line inside a Cornell note and it auto-expands into `> [!cue] ` with the cursor placed right after, ready for the cue text.

## Settings

Settings → Community Plugins → Cornell Notes:

| Setting | Default | Notes |
|---|---|---|
| Cue column width | `120` (px) | Width of the left margin column. |
| Divider line color | `lightgrey` | Any CSS color value (named, hex, rgb). |
| Divider line thickness | `1` (px) | Set to `0` to hide the divider. |
| Cue shortcut | `` (empty) | A trigger word that auto-expands into `> [!cue] ` when typed on its own line. Empty disables it. |

Changes apply live — no plugin reload required.

## Architecture

- `classifier.ts` — pure module, the single source of truth for placement. `classifyBlocks` turns a note's source into an ordered list of *slots* (`title`, `cue`, `summary`, `body`, `full`, `gap`), each with a block range, per-line ranges, and a 0-based `page` number (a `> [!title]` increments the page). `slotForLineRange` maps a source line range (from `getSectionInfo`) to its slot for Reading view; `leadsWithTitle` reports whether the file opens with a non-empty title (drives the file-name fallback). No Obsidian or DOM dependencies.
- `livePreview.ts` — CodeMirror `ViewPlugin` that maps slots to line decorations on title / cue / summary / body / gap source lines.
- `main.ts` — plugin entry. Registers the editor extension, the Reading-view post-processor (which stamps `data-cornell-slot` on each block from its slot and toggles `cornell-leading-title` on the sizer to hide Obsidian's inline title when the file leads with an explicit title), the settings tab, and listens for metadata changes.
- `settings.ts` — settings interface + tab UI.
- `styles.css` — visual layout. Reading view places blocks by their `data-cornell-slot` attribute; the title is centered full-width and a `--cornell-page-gap` of whitespace separates stacked pages. CSS variables (`--cue-width`, `--cue-line-color`, `--cue-line-thickness`) are written to `:root` by the plugin so settings updates re-flow the page without restyling.
- `tests/` — `node:test` fixtures over the pure classifier; run with `npm test`.

## Build

```
npm install
npm run build
```

Produces `main.js`. The plugin folder is symlinked into the vault's `.obsidian/plugins/cornell-notes`.
