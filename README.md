# Cornell Notes — Obsidian Plugin

Cornell-style note layout for Obsidian using native callouts. Cue callouts appear in a left margin column, summaries at the bottom. Works in both Reading view and Live Preview — cues remain inline-editable in Live Preview without switching to source mode.

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

Write the summary the same way at the bottom:

```markdown
> [!summary]
> The Cornell system encourages active engagement and structured review.
```

Use a standard `---` horizontal rule to separate multiple Cornell sections in one file.

Other callout types (`note`, `warning`, `info`, etc.) are ignored by the plugin and render as normal Obsidian callouts.

## Settings

Settings → Community Plugins → Cornell Notes:

| Setting | Default | Notes |
|---|---|---|
| Cue column width | `120` (px) | Width of the left margin column. |
| Divider line color | `lightgrey` | Any CSS color value (named, hex, rgb). |
| Divider line thickness | `1` (px) | Set to `0` to hide the divider. |

Changes apply live — no plugin reload required.

## Architecture

- `parser.ts` — pure module that identifies cue / summary callouts and their anchor blocks. No Obsidian or DOM dependencies.
- `livePreview.ts` — CodeMirror `ViewPlugin` that applies line decorations to cue / summary source lines.
- `main.ts` — plugin entry. Registers the editor extension, the Reading-view post-processor, the settings tab, and listens for metadata changes.
- `settings.ts` — settings interface + tab UI.
- `styles.css` — visual layout. CSS variables (`--cue-width`, `--cue-line-color`, `--cue-line-thickness`) are written to `:root` by the plugin so settings updates re-flow the page without restyling.

## Build

```
npm install
npm run build
```

Produces `main.js`. The plugin folder is symlinked into the vault's `.obsidian/plugins/cornell-notes`.
