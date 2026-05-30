import { MarkdownView, Notice, Plugin, TFile, TFolder } from "obsidian";
import { EditorView } from "@codemirror/view";
import { classifySection, hasCornellCssClass } from "./classifier";
import {
  buildCornellEditorExtension,
  cornellRefreshEffect,
} from "./livePreview";
import {
  CornellSettings,
  CornellSettingsTab,
  DEFAULT_SETTINGS,
} from "./settings";

const _sig = "VGhpcyBJcyBCZWFzdEh1bnRlcnMgQ29kZQ==";

const CSS_VAR_CUE_WIDTH = "--cue-width";
const CSS_VAR_LINE_COLOR = "--cue-line-color";
const CSS_VAR_LINE_THICKNESS = "--cue-line-thickness";
const INVALID_TOOLTIP =
  "Cue has no body block before the next cue. Add content below, or merge the cues.";

const CORNELL_TEMPLATE = `---
cssclasses:
  - cornell-note
---

> [!cue] Topic 1
## Topic 1

Body notes for topic 1 go here. Write freely — paragraphs, lists, code, anything.

> [!cue] Topic 2
- Bullet point
- Another bullet point

> [!cue] Topic 3
## Topic 3

More notes...

---

# Summary

> [!summary]
> Write your summary here.
`;

/** Walk up from a rendered element to the `.markdown-preview-sizer`'s direct
 *  child — the element that becomes a grid item. Returns null if none is found
 *  (e.g. the element is detached), in which case the caller stamps `el` itself. */
function sizerChild(el: HTMLElement): HTMLElement | null {
  let e: HTMLElement | null = el;
  while (e && !e.parentElement?.classList.contains("markdown-preview-sizer")) {
    e = e.parentElement;
  }
  return e;
}

export default class CornellNotesPlugin extends Plugin {
  settings: CornellSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();
    this.applyCssVariables();
    this.addSettingTab(new CornellSettingsTab(this.app, this));

    this.addCommand({
      id: "create-cornell-note",
      name: "Create new Cornell note",
      callback: () => this.createCornellNote(),
    });

    this.addRibbonIcon(
      "columns-3",
      "Create new Cornell note",
      () => this.createCornellNote()
    );

    this.registerEditorExtension(
      buildCornellEditorExtension({ app: this.app })
    );

    this.registerMarkdownPostProcessor(async (el, ctx) => {
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!(file instanceof TFile)) return;
      const cache = this.app.metadataCache.getFileCache(file);
      if (!hasCornellCssClass(cache?.frontmatter)) return;

      // Resolve which slot this rendered block is by SOURCE POSITION rather
      // than DOM index: getSectionInfo gives the block's line range, and the
      // classifier maps that range to a slot. Robust to partial / out-of-order
      // section renders. A block with no section info (e.g. the inline title)
      // gets no attribute and falls back to the full-width default in CSS.
      const info = ctx.getSectionInfo(el);
      if (!info) return;

      const source = await this.app.vault.cachedRead(file);
      const resolved = classifySection(
        source,
        cache?.frontmatter,
        info.lineStart,
        info.lineEnd
      );
      if (!resolved) return;
      const { slot, notesEnd } = resolved;

      // Stamp the slot role on the grid-item wrapper (the preview-sizer's
      // direct child) so the stylesheet can place it without `:has()` guesswork.
      const wrapper = sizerChild(el) ?? el;
      wrapper.setAttribute("data-cornell-slot", slot.role);

      // Break the divider line before the next cue, but only on the section
      // that holds the region's last source line. A body slot can render as
      // several sections (e.g. a table and the paragraph right below it); the
      // interior ones must stay connected, so classifySection decides per
      // section, not per slot. Toggle so re-renders don't leave a stale flag.
      if (notesEnd) {
        wrapper.setAttribute("data-cornell-notes-end", "");
      } else {
        wrapper.removeAttribute("data-cornell-notes-end");
      }

      // Mark this section's cue invalid (adjacent-cue) directly — no whole-
      // preview index matching.
      if (slot.role === "cue") {
        const cueEl = el.querySelector<HTMLElement>(
          '.callout[data-callout="cue"]'
        );
        if (cueEl) {
          const invalid = slot.invalid === "adjacent-cue";
          cueEl.classList.toggle("cornell-invalid", invalid);
          if (invalid) {
            cueEl.setAttribute("title", INVALID_TOOLTIP);
          } else {
            cueEl.removeAttribute("title");
          }
        }
      }
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.refreshForFile(file);
      })
    );
  }

  onunload() {
    const r = document.documentElement;
    r.style.removeProperty(CSS_VAR_CUE_WIDTH);
    r.style.removeProperty(CSS_VAR_LINE_COLOR);
    r.style.removeProperty(CSS_VAR_LINE_THICKNESS);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyCssVariables();
    this.dispatchRefreshToAllEditors();
  }

  private applyCssVariables() {
    const r = document.documentElement;
    r.style.setProperty(CSS_VAR_CUE_WIDTH, `${this.settings.cueWidth}px`);
    r.style.setProperty(CSS_VAR_LINE_COLOR, this.settings.dividerColor);
    r.style.setProperty(
      CSS_VAR_LINE_THICKNESS,
      `${this.settings.dividerThickness}px`
    );
  }

  private dispatchRefreshToAllEditors() {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view as MarkdownView;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (cm) {
        cm.dispatch({ effects: cornellRefreshEffect.of() });
      }
    });
  }

  private refreshForFile(file: TFile) {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view as MarkdownView;
      if (!view || view.file?.path !== file.path) return;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (cm) {
        cm.dispatch({ effects: cornellRefreshEffect.of() });
      }
    });
  }

  private async createCornellNote(): Promise<void> {
    const folder = this.targetFolder();
    const path = await this.uniqueChildPath(folder, "Untitled Cornell note");
    try {
      const file = await this.app.vault.create(path, CORNELL_TEMPLATE);
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (e) {
      new Notice(`Could not create Cornell note: ${String(e)}`);
    }
  }

  private targetFolder(): TFolder {
    const active = this.app.workspace.getActiveFile();
    const parent = active?.parent;
    if (parent instanceof TFolder) return parent;
    return this.app.vault.getRoot();
  }

  private async uniqueChildPath(
    folder: TFolder,
    baseName: string
  ): Promise<string> {
    const prefix = folder.isRoot() ? "" : `${folder.path}/`;
    let candidate = `${prefix}${baseName}.md`;
    if (!(await this.app.vault.adapter.exists(candidate))) return candidate;
    for (let n = 1; n < 1000; n++) {
      candidate = `${prefix}${baseName} ${n}.md`;
      if (!(await this.app.vault.adapter.exists(candidate))) return candidate;
    }
    return `${prefix}${baseName} ${Date.now()}.md`;
  }
}
