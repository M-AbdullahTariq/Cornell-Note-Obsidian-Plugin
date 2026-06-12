import {
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TFile,
  TFolder,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import {
  type AttributeMap,
  classifySection,
  hasCornellCssClass,
  invalidTooltip,
  leadsWithTitle,
  slotAttributes,
  TITLE_OVER_LIMIT_TOOLTIP,
  titleExceedsLimit,
} from "./classifier";
import {
  collectCornellNotes,
  descendantMarkdownFiles,
  stampExportHost,
} from "./pdfExport";
import { CornellPdfExportModal } from "./pdfExportModal";
import {
  buildCornellEditorExtension,
  buildCalloutExpander,
  cornellRefreshEffect,
} from "./livePreview";
import { ReviewModeController } from "./reviewMode";
import {
  CornellSettings,
  CornellSettingsTab,
  DEFAULT_SETTINGS,
} from "./settings";

const CSS_VAR_CUE_WIDTH = "--cue-width";
const CSS_VAR_LINE_COLOR = "--cue-line-color";
const CSS_VAR_LINE_THICKNESS = "--cue-line-thickness";
const CLASS_REVIEW_HOVER_BOX = "cornell-review-hover-box";

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

> [!summary]
> Write your summary here.
`;

/** Locate the Cornell grid host for a rendered element — the container whose
 *  direct children are the note's top-level blocks and onto which the grid is
 *  applied.
 *
 *  - Reading view / Live Preview: the `.markdown-preview-sizer`.
 *  - Export to PDF / print: Obsidian renders into a different container (no
 *    preview sizer). We anchor on a Cornell callout and climb to the block
 *    whose parent is the rendered-markdown container, returning that parent.
 *
 *  The caller tags the host `.cornell-grid` so the layout stylesheet (which
 *  matches `:is(.markdown-preview-sizer, .cornell-grid)`) applies in both. */
function cornellHost(el: HTMLElement): HTMLElement | null {
  const sizer = el.closest<HTMLElement>(".markdown-preview-sizer");
  if (sizer) return sizer;
  const CONTAINER = ".markdown-rendered, .markdown-preview-view, .print";
  // The export render container — found from `el` whether it is the container
  // itself, a block inside it, or (if Obsidian hands us a detached block) by
  // searching the document. Falls back to `el` only as a last resort.
  const scope =
    el.closest<HTMLElement>(CONTAINER) ??
    el.ownerDocument?.querySelector<HTMLElement>(CONTAINER) ??
    el;
  const anchor = scope.querySelector<HTMLElement>(
    '.callout[data-callout="cue"], .callout[data-callout="title"], .callout[data-callout="summary"]'
  );
  if (!anchor) return null;
  let block: HTMLElement = anchor;
  while (block.parentElement && block.parentElement !== scope) {
    block = block.parentElement;
  }
  return block.parentElement === scope ? scope : block.parentElement;
}

/** Apply an attribute map from the classifier's marking vocabulary: a string
 *  value is set (empty string = boolean-style attribute), null removes — so
 *  re-stamping a re-rendered block always clears stale markers. */
function applyAttributes(el: HTMLElement, attrs: AttributeMap): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null) {
      el.removeAttribute(name);
    } else {
      el.setAttribute(name, value);
    }
  }
}

/** Walk up from a rendered element to the host's direct child — the element
 *  that becomes a grid item. Returns null if `el` is not inside `host`. */
function hostChild(el: HTMLElement, host: HTMLElement): HTMLElement | null {
  let e: HTMLElement | null = el;
  while (e && e.parentElement && e.parentElement !== host) {
    e = e.parentElement;
  }
  return e && e.parentElement === host ? e : null;
}

export default class CornellNotesPlugin extends Plugin {
  settings: CornellSettings = { ...DEFAULT_SETTINGS };
  private reviewMode!: ReviewModeController;

  async onload() {
    await this.loadSettings();
    this.applyCssVariables();
    this.reviewMode = new ReviewModeController(this.app);
    this.addSettingTab(new CornellSettingsTab(this.app, this));

    this.addCommand({
      id: "create-cornell-note",
      name: "Create new note",
      callback: () => this.createCornellNote(),
    });

    this.addCommand({
      id: "toggle-review-mode",
      name: "Toggle review mode",
      callback: () => this.reviewMode.toggle(),
    });

    this.addCommand({
      id: "reset-review-reveals",
      name: "Reset review reveals (re-blur all)",
      callback: () => this.reviewMode.resetReveals(),
    });

    // Click a cue (or the summary) in review mode to reveal/hide its region.
    // Delegated on the document so it survives Reading-view re-renders and
    // leaf changes; the handler is a no-op unless review mode is active.
    this.registerDomEvent(activeDocument, "click", (evt) =>
      this.reviewMode.handleClick(evt)
    );

    this.addRibbonIcon(
      "columns-3",
      "Create new note",
      () => this.createCornellNote()
    );

    this.registerEditorExtension([
      buildCornellEditorExtension({ app: this.app }),
      buildCalloutExpander({
        app: this.app,
        // Ordered rules; earlier wins on identical triggers. Cue is listed
        // first, so if the user sets the same word for both, the cue takes it.
        getRules: () => [
          { trigger: this.settings.cueShortcut.trim(), insert: "> [!cue] " },
          {
            trigger: this.settings.summaryShortcut.trim(),
            insert: "> [!summary] ",
          },
          {
            trigger: this.settings.titleShortcut.trim(),
            insert: "> [!title] ",
          },
        ],
      }),
    ]);

    this.registerMarkdownPostProcessor(async (el, ctx) => {
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!(file instanceof TFile)) return;
      const cache = this.app.metadataCache.getFileCache(file);
      if (!hasCornellCssClass(cache?.frontmatter)) return;

      const source = await this.app.vault.cachedRead(file);

      // Find the grid host (preview sizer in the live views, or the export
      // container during Export to PDF) and tag it `cornell-grid` so the layout
      // stylesheet applies in both. Title fallback: when the file leads with a
      // `>[!title]`, hide Obsidian's built-in inline (file-name) title so only
      // the explicit title shows; otherwise leave it as the file-name fallback.
      // The flag lives on the host — a stable ancestor of every block — and the
      // toggle is idempotent across the per-block post-processor calls.
      const host = cornellHost(el);
      if (host) {
        host.classList.add("cornell-grid");
        host.classList.toggle(
          "cornell-leading-title",
          leadsWithTitle(source, cache?.frontmatter)
        );
        // Reflect the global review-mode state onto this host so a freshly
        // rendered Cornell note matches it without waiting for a toggle.
        this.reviewMode.syncSizer(host);
      }

      // Resolve which slot this rendered block is by SOURCE POSITION rather
      // than DOM index: getSectionInfo gives the block's line range, and the
      // classifier maps that range to a slot. Robust to partial / out-of-order
      // section renders. A block with no section info (e.g. the inline title)
      // gets no attribute and falls back to the full-width default in CSS.
      const info = ctx.getSectionInfo(el);
      if (!info) {
        // Export to PDF / print: `getSectionInfo` returns null and there is no
        // preview sizer, so the source-position path can't run. Stamp the whole
        // host structurally from the rendered DOM instead, so the export
        // reproduces the Reading-view layout. Idempotent across calls.
        if (host) stampExportHost(host);
        return;
      }

      const resolved = classifySection(
        source,
        cache?.frontmatter,
        info.lineStart,
        info.lineEnd
      );
      if (!resolved) return;
      const { slot, notesEnd } = resolved;

      // Stamp the marking vocabulary on the grid-item wrapper (the
      // preview-sizer's direct child) so the stylesheet can place it without
      // `:has()` guesswork. The full attribute set — slot role, in-region and
      // page-break markers, review-mode reveal key and blur marker, and the
      // per-section notes-end divider break — is decided by the classifier's
      // `slotAttributes`, the single source of truth shared with the tests.
      const wrapper = (host ? hostChild(el, host) : null) ?? el;
      applyAttributes(wrapper, slotAttributes(slot, notesEnd));

      // Re-apply any reveal the user already made for this group, so revealed
      // regions survive Reading-view re-renders rather than snapping re-blurred.
      this.reviewMode.restoreWrapper(wrapper, ctx.sourcePath);

      // Mark this section's cue invalid (adjacent-cue / lazy-body) directly —
      // no whole-preview index matching.
      if (slot.role === "cue") {
        const cueEl = el.querySelector<HTMLElement>(
          '.callout[data-callout="cue"]'
        );
        if (cueEl) {
          const reason = slot.invalid ?? null;
          cueEl.classList.toggle("cornell-invalid", reason !== null);
          if (reason) {
            cueEl.setAttribute("title", invalidTooltip(reason));
          } else {
            cueEl.removeAttribute("title");
          }
        }
      }

      // Flag an over-limit page title (red text + tooltip) — the Reading-view
      // half of the warn-in-both-views behaviour. Mirrors the cue flagging
      // above; warn-and-keep, so the text is never blocked or trimmed and the
      // class clears on re-render once the title is shortened to the limit.
      if (slot.role === "title") {
        const titleEl = el.querySelector<HTMLElement>(
          '.callout[data-callout="title"]'
        );
        if (titleEl) {
          const over = titleExceedsLimit(slot.content ?? "");
          titleEl.classList.toggle("cornell-title-over-limit", over);
          if (over) {
            titleEl.setAttribute("title", TITLE_OVER_LIMIT_TOOLTIP);
          } else {
            titleEl.removeAttribute("title");
          }
        }
      }
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.refreshForFile(file);
      })
    );

    // Right-click export. Two entry points, both desktop only (the Electron
    // `printToPDF` capture path is desktop only):
    //  - on a Cornell note → the export modal scoped to that one note;
    //  - on a folder that contains Cornell notes → the modal scoped to every
    //    Cornell note beneath it (descendants included). Right-clicking the
    //    vault root is therefore the "export all Cornell notes" path.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (Platform.isMobile) return;
        // Opt-in feature: no menu items unless the user enabled PDF export.
        if (!this.settings.pdfExportEnabled) return;
        const getFrontmatter = (f: TFile): unknown =>
          this.app.metadataCache.getFileCache(f)?.frontmatter;

        if (file instanceof TFile && file.extension === "md") {
          if (!hasCornellCssClass(getFrontmatter(file))) return;
          menu.addItem((item) =>
            item
              .setTitle("Export PDF")
              .setIcon("file-text")
              .onClick(() =>
                new CornellPdfExportModal(this, [file]).open()
              )
          );
          return;
        }

        if (file instanceof TFolder) {
          const notes = collectCornellNotes(
            descendantMarkdownFiles(file),
            getFrontmatter
          );
          if (notes.length === 0) return;
          menu.addItem((item) =>
            item
              .setTitle("Export to PDF")
              .setIcon("file-text")
              .onClick(() => new CornellPdfExportModal(this, notes).open())
          );
        }
      })
    );
  }

  onunload() {
    const r = activeDocument.documentElement;
    r.style.removeProperty(CSS_VAR_CUE_WIDTH);
    r.style.removeProperty(CSS_VAR_LINE_COLOR);
    r.style.removeProperty(CSS_VAR_LINE_THICKNESS);
    r.classList.remove(CLASS_REVIEW_HOVER_BOX);
  }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<CornellSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyCssVariables();
    this.dispatchRefreshToAllEditors();
  }

  private applyCssVariables() {
    const r = activeDocument.documentElement;
    r.style.setProperty(CSS_VAR_CUE_WIDTH, `${this.settings.cueWidth}px`);
    r.style.setProperty(CSS_VAR_LINE_COLOR, this.settings.dividerColor);
    r.style.setProperty(
      CSS_VAR_LINE_THICKNESS,
      `${this.settings.dividerThickness}px`
    );
    // Opt-in review-mode hover highlight: a root class gates the box-shadow
    // rule in the stylesheet, so toggling the setting applies it live.
    r.classList.toggle(
      CLASS_REVIEW_HOVER_BOX,
      this.settings.reviewHoverHighlight
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
