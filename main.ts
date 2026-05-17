import { MarkdownView, Notice, Plugin, TFile, TFolder } from "obsidian";
import { EditorView } from "@codemirror/view";
import { hasCornellCssClass } from "./parser";
import {
  buildCornellEditorExtension,
  cornellRefreshEffect,
} from "./livePreview";
import {
  CornellSettings,
  CornellSettingsTab,
  DEFAULT_SETTINGS,
} from "./settings";
import { ancestorChain, describeElement, Logger } from "./logger";

const CSS_VAR_CUE_WIDTH = "--cue-width";
const CSS_VAR_LINE_COLOR = "--cue-line-color";
const CSS_VAR_LINE_THICKNESS = "--cue-line-thickness";
const LOG_PATH = "cornell-debug.log";

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

export default class CornellNotesPlugin extends Plugin {
  settings: CornellSettings = { ...DEFAULT_SETTINGS };
  logger!: Logger;

  async onload() {
    this.logger = new Logger(this.app, LOG_PATH);
    this.logger.log("=== onload ===");

    await this.loadSettings();
    this.logger.log("settings:", this.settings);

    this.applyCssVariables();
    this.logger.log("CSS variables applied to documentElement");

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
      buildCornellEditorExtension({
        app: this.app,
        logger: this.logger,
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file) {
          this.logger.log("file-open: <null>");
          return;
        }
        const cache = this.app.metadataCache.getFileCache(file);
        this.logger.log("file-open:", file.path);
        this.logger.log("  frontmatter:", cache?.frontmatter ?? "<none>");
        this.logger.log(
          "  hasCornellCssClass:",
          hasCornellCssClass(cache?.frontmatter)
        );
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf) return;
        const view = leaf.view as MarkdownView;
        if (!view || view.getViewType() !== "markdown") return;

        this.logger.log("active-leaf-change");
        this.logger.log(
          "  containerEl ancestor chain:",
          ancestorChain(view.containerEl, 12)
        );

        const sourceView = view.containerEl.querySelector(
          ".markdown-source-view"
        );
        const previewView = view.containerEl.querySelector(
          ".markdown-preview-view"
        );
        this.logger.log(
          "  source-view:",
          describeElement(sourceView)
        );
        this.logger.log(
          "  preview-view:",
          describeElement(previewView)
        );

        const cornellEl = view.containerEl.querySelector(".cornell-note");
        this.logger.log(
          "  first descendant with .cornell-note:",
          describeElement(cornellEl)
        );
        const cornellAnc = view.containerEl.closest(".cornell-note");
        this.logger.log(
          "  closest ancestor with .cornell-note (from containerEl):",
          describeElement(cornellAnc)
        );
      })
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.logger.log("metadataCache changed:", file.path);
        this.refreshForFile(file);
      })
    );
  }

  onunload() {
    this.logger?.log("=== onunload ===");
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
      this.logger?.log("created Cornell note:", file.path);
    } catch (e) {
      this.logger?.log("create Cornell note failed:", String(e));
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
