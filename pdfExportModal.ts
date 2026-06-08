// Multi-note "Export to PDF" modal. Lists the in-scope Cornell notes with
// checkboxes, lets the user pick the page size (persisted in settings), renders
// the checked notes into a scrollable preview on demand, and on Export writes one
// `<note>.pdf` next to each selected note. Built with plain DOM on Obsidian's
// Modal — no Svelte. Desktop only — the caller guards mobile.
//
// Preview and capture are intentionally DECOUPLED:
//   - Preview: each Cornell grid is rendered as native in-app DOM (exactly like
//     Reading view) and stacked in a scrollable container, so it always paints.
//     No webview is involved in the preview.
//   - Capture: at export time each note is rendered and printed through an
//     Electron <webview> (which renders in print media, independent of on-screen
//     paint), ONE note at a time — Electron throttles off-screen/overlapping
//     webviews, so a single on-screen capture host is reused per note.
//
// Preview / capture technique adapted from l1xnan/obsidian-better-export-pdf
// (MIT); see README credits.

import { ButtonComponent, Modal, Notice, TFile, TFolder } from "obsidian";
import type CornellNotesPlugin from "./main";
import {
  PAGE_SIZES,
  PageSize,
  PrintWebview,
  bodyClassForExport,
  buildCombinedExportBody,
  buildExportBody,
  prepareExportWebview,
  printPreparedWebview,
  renderCornellExportGrid,
  resolveCombinedOutputPath,
  resolvePdfOutputPath,
} from "./pdfExport";

type OutputMode = "separate" | "combined";

/** Tally returned by an export run. `exported` is the count of notes written
 *  (PDFs in separate mode, notes included in combined mode); `failed` lists the
 *  basenames that could not be rendered/written; `wrote` is whether any output
 *  file was produced. */
interface ExportSummary {
  exported: number;
  failed: string[];
  wrote: boolean;
}

export class CornellPdfExportModal extends Modal {
  private readonly plugin: CornellNotesPlugin;
  private readonly files: TFile[];
  /** The notes currently ticked for export. Seeded with every in-scope note. */
  private readonly checked: Set<TFile>;
  private pageSize: PageSize;
  private outputMode: OutputMode = "separate";
  /** Combined-mode output target — a file name (extension optional) and a vault
   *  folder path ("/" = root). Only used when `outputMode === "combined"`. */
  private combinedName = "Cornell Notes";
  private combinedFolder = "/";
  /** The combined-only inputs row, shown/hidden with the output mode. */
  private combinedRow: HTMLElement | null = null;

  private renderBtn: ButtonComponent | null = null;
  private exportBtn: ButtonComponent | null = null;
  private previewEl: HTMLElement | null = null;
  /** Disposers for the grids currently mounted in the preview, cleared on
   *  re-render and on close so render components are always unloaded. */
  private previewDisposers: (() => void)[] = [];
  /** Body-level on-screen host that backs the capture <webview> during export.
   *  Held so it can be torn down if the modal closes mid-export. */
  private captureHost: HTMLElement | null = null;
  private exporting = false;

  constructor(plugin: CornellNotesPlugin, files: TFile[]) {
    super(plugin.app);
    this.plugin = plugin;
    this.files = files;
    this.checked = new Set(files);
    this.pageSize = plugin.settings.pdfPageSize;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("cornell-pdf-export-modal");
    this.titleEl.setText(
      this.files.length === 1 ? "Export note to PDF" : "Export notes to PDF"
    );

    // Page size selector — defaults to the persisted choice, writes it back.
    const controls = contentEl.createDiv({ cls: "cornell-pdf-export-controls" });
    const sizeLabel = controls.createEl("label", { text: "Page size" });
    sizeLabel.addClass("cornell-pdf-export-label");
    const select = sizeLabel.createEl("select");
    PAGE_SIZES.forEach((size) => {
      select.createEl("option", { text: size, value: size });
    });
    select.value = this.pageSize;
    select.addEventListener("change", () => {
      this.pageSize = select.value as PageSize;
      this.plugin.settings.pdfPageSize = this.pageSize;
      void this.plugin.saveSettings();
    });

    // Output mode — one PDF per note, or a single combined PDF.
    const modeLabel = controls.createEl("label", { text: "Output" });
    modeLabel.addClass("cornell-pdf-export-label");
    const modeSelect = modeLabel.createEl("select");
    modeSelect.createEl("option", {
      text: "One PDF per note",
      value: "separate",
    });
    modeSelect.createEl("option", { text: "Combined PDF", value: "combined" });
    modeSelect.value = this.outputMode;
    modeSelect.addEventListener("change", () => {
      this.outputMode = modeSelect.value as OutputMode;
      this.combinedRow?.classList.toggle(
        "cornell-pdf-hidden",
        this.outputMode !== "combined"
      );
    });

    // Combined-only inputs: file name + target folder (shown only in combined).
    this.combinedRow = contentEl.createDiv({ cls: "cornell-pdf-combined-row" });
    const nameLabel = this.combinedRow.createEl("label", { text: "File name" });
    nameLabel.addClass("cornell-pdf-export-label");
    const nameInput = nameLabel.createEl("input", { type: "text" });
    nameInput.value = this.combinedName;
    nameInput.addEventListener("input", () => {
      this.combinedName = nameInput.value;
    });
    const folderLabel = this.combinedRow.createEl("label", { text: "Folder" });
    folderLabel.addClass("cornell-pdf-export-label");
    const folderSelect = folderLabel.createEl("select");
    this.folderOptions().forEach((opt) => {
      folderSelect.createEl("option", { text: opt.label, value: opt.value });
    });
    folderSelect.value = this.combinedFolder;
    folderSelect.addEventListener("change", () => {
      this.combinedFolder = folderSelect.value;
    });
    this.combinedRow.classList.toggle(
      "cornell-pdf-hidden",
      this.outputMode !== "combined"
    );

    // Selection header with select-all / select-none.
    const selHeader = contentEl.createDiv({
      cls: "cornell-pdf-selection-header",
    });
    selHeader.createEl("span", {
      cls: "cornell-pdf-selection-title",
      text: `${this.files.length} cornell note${
        this.files.length === 1 ? "" : "s"
      }`,
    });
    const selActions = selHeader.createDiv({
      cls: "cornell-pdf-selection-actions",
    });
    new ButtonComponent(selActions)
      .setButtonText("Select all")
      .onClick(() => this.setAllChecked(true));
    new ButtonComponent(selActions)
      .setButtonText("Select none")
      .onClick(() => this.setAllChecked(false));

    // Checkbox list of the in-scope notes (pre-checked).
    const list = contentEl.createDiv({ cls: "cornell-pdf-note-list" });
    this.files.forEach((file) => {
      const item = list.createEl("label", { cls: "cornell-pdf-note-item" });
      const box = item.createEl("input", { type: "checkbox" });
      box.checked = this.checked.has(file);
      box.dataset.path = file.path;
      box.addEventListener("change", () => {
        if (box.checked) this.checked.add(file);
        else this.checked.delete(file);
        this.updateButtons();
      });
      item.createEl("span", {
        cls: "cornell-pdf-note-name",
        text: file.basename,
      });
      if (file.parent && !file.parent.isRoot()) {
        item.createEl("span", {
          cls: "cornell-pdf-note-path",
          text: file.parent.path,
        });
      }
    });

    // Render (preview) button — preview is on demand, nothing renders on open.
    const renderRow = contentEl.createDiv({ cls: "cornell-pdf-render-row" });
    this.renderBtn = new ButtonComponent(renderRow)
      .setButtonText("Render preview")
      .onClick(() => void this.renderPreview());

    // Scrollable preview surface (empty until Render is clicked).
    this.previewEl = contentEl.createDiv({ cls: "cornell-pdf-export-preview" });
    this.previewEl.createDiv({
      cls: "cornell-pdf-export-status",
      text: "Select notes and click Render preview to see them here.",
    });

    // Action buttons.
    const buttons = contentEl.createDiv({ cls: "cornell-pdf-export-buttons" });
    new ButtonComponent(buttons)
      .setButtonText("Cancel")
      .onClick(() => this.close());
    this.exportBtn = new ButtonComponent(buttons)
      .setButtonText("Export")
      .setCta()
      .onClick(() => void this.runExport());

    this.updateButtons();
  }

  /** Tick or untick every note and sync the checkboxes + buttons. */
  private setAllChecked(on: boolean): void {
    this.checked.clear();
    if (on) this.files.forEach((f) => this.checked.add(f));
    this.contentEl
      .querySelectorAll<HTMLInputElement>(".cornell-pdf-note-item input")
      .forEach((box) => {
        box.checked = on;
      });
    this.updateButtons();
  }

  /** The notes currently ticked, in the original (scope) order. */
  private selectedFiles(): TFile[] {
    return this.files.filter((f) => this.checked.has(f));
  }

  /** Enable Render / Export only when at least one note is checked and no export
   *  is in flight. */
  private updateButtons(): void {
    const has = this.selectedFiles().length > 0;
    this.renderBtn?.setDisabled(this.exporting || !has);
    this.exportBtn?.setDisabled(this.exporting || !has);
  }

  /** Unload every preview render component and clear the preview surface. */
  private disposePreview(): void {
    this.previewDisposers.forEach((d) => d());
    this.previewDisposers = [];
    this.previewEl?.empty();
  }

  /** Render each checked note as native in-app DOM, stacked in the scrollable
   *  preview. A note that fails to render is reported inline; the rest still
   *  render. Re-rendering disposes the previous preview first. */
  private async renderPreview(): Promise<void> {
    if (this.exporting || !this.previewEl) return;
    const files = this.selectedFiles();
    if (files.length === 0) {
      new Notice("Select at least one cornell note to preview.");
      return;
    }
    this.disposePreview();
    const status = this.previewEl.createDiv({
      cls: "cornell-pdf-export-status",
      text: "Rendering preview…",
    });
    for (const file of files) {
      try {
        const { grid, dispose } = await renderCornellExportGrid(this.app, file);
        this.previewDisposers.push(dispose);
        // Mount under a `.cornell-note` ancestor so the plugin's grid-layout CSS
        // applies, exactly like Reading view.
        const sheet = this.previewEl.createDiv({
          cls: "cornell-pdf-preview-sheet cornell-note",
        });
        sheet.appendChild(grid);
      } catch (e) {
        this.previewEl.createDiv({
          cls: "cornell-pdf-export-status cornell-pdf-export-error",
          text: `Could not render "${file.basename}": ${String(e)}`,
        });
      }
    }
    status.remove();
  }

  /** Vault folders for the combined-mode target dropdown — root first, then every
   *  folder by path. Root is shown as "(vault root)" and stored as "/". */
  private folderOptions(): { value: string; label: string }[] {
    const byPath = new Map<string, string>([["/", "(vault root)"]]);
    this.app.vault.getAllLoadedFiles().forEach((f) => {
      if (f instanceof TFolder && !f.isRoot()) byPath.set(f.path, f.path);
    });
    return Array.from(byPath, ([value, label]) => ({ value, label })).sort(
      (a, b) => a.label.localeCompare(b.label)
    );
  }

  /** Export the checked notes, branching on the output mode, with one shared
   *  on-screen capture host. Tears the host down and reports a summary either
   *  way; a clean run closes the modal, any failure keeps it open for retry. */
  private async runExport(): Promise<void> {
    if (this.exporting) return;
    const files = this.selectedFiles();
    if (files.length === 0) {
      new Notice("Select at least one cornell note to export.");
      return;
    }

    this.exporting = true;
    this.updateButtons();
    this.exportBtn?.setButtonText("Exporting…");

    // Body-level on-screen capture host positioned over the preview surface, so
    // the webview is laid out and painted (Electron throttles off-screen ones).
    const host = activeDocument.body.createDiv({ cls: "cornell-pdf-export-host" });
    this.captureHost = host;
    this.positionCaptureHost();
    const bodyClass = bodyClassForExport(activeDocument);

    let summary: ExportSummary;
    try {
      summary =
        this.outputMode === "combined"
          ? await this.exportCombined(files, host, bodyClass)
          : await this.exportSeparate(files, host, bodyClass);
    } finally {
      this.captureHost?.remove();
      this.captureHost = null;
      this.exporting = false;
    }

    this.reportExport(files.length, summary);
  }

  /** One PDF per note, beside each source, captured one at a time through the
   *  shared host. A note that fails is skipped; the rest still export. */
  private async exportSeparate(
    files: TFile[],
    host: HTMLElement,
    bodyClass: string
  ): Promise<ExportSummary> {
    const failed: string[] = [];
    let exported = 0;
    for (const file of files) {
      let webview: PrintWebview | null = null;
      try {
        const { grid, dispose } = await renderCornellExportGrid(this.app, file);
        const gridHtml = grid.outerHTML;
        dispose();
        webview = await prepareExportWebview(host, {
          bodyHtml: buildExportBody(gridHtml),
          bodyClass,
        });
        const bytes = await printPreparedWebview(webview, this.pageSize);
        await this.app.vault.adapter.writeBinary(
          resolvePdfOutputPath(file),
          bytes
        );
        exported++;
      } catch (e) {
        console.error(`Cornell PDF export failed for ${file.path}`, e);
        failed.push(file.basename);
      } finally {
        webview?.remove();
      }
    }
    return { exported, failed, wrote: exported > 0 };
  }

  /** All selected notes merged into one PDF (each note on a fresh page), written
   *  to the combined name + folder. Notes that fail to render are skipped; the
   *  combined file is still written from the rest. `exported` is the number of
   *  notes included in the file. */
  private async exportCombined(
    files: TFile[],
    host: HTMLElement,
    bodyClass: string
  ): Promise<ExportSummary> {
    const failed: string[] = [];
    const gridHtmls: string[] = [];
    for (const file of files) {
      try {
        const { grid, dispose } = await renderCornellExportGrid(this.app, file);
        gridHtmls.push(grid.outerHTML);
        dispose();
      } catch (e) {
        console.error(`Cornell PDF render failed for ${file.path}`, e);
        failed.push(file.basename);
      }
    }
    if (gridHtmls.length === 0) return { exported: 0, failed, wrote: false };

    let webview: PrintWebview | null = null;
    try {
      webview = await prepareExportWebview(host, {
        bodyHtml: buildCombinedExportBody(gridHtmls),
        bodyClass,
      });
      const bytes = await printPreparedWebview(webview, this.pageSize);
      await this.app.vault.adapter.writeBinary(
        resolveCombinedOutputPath(this.combinedFolder, this.combinedName),
        bytes
      );
      return { exported: gridHtmls.length, failed, wrote: true };
    } finally {
      webview?.remove();
    }
  }

  /** Notice + close policy shared by both modes: a clean run closes the modal;
   *  any failure (or nothing written) keeps it open so the user can retry. */
  private reportExport(total: number, summary: ExportSummary): void {
    const { exported, failed, wrote } = summary;
    if (!wrote) {
      new Notice("Nothing exported — no notes could be rendered.");
    } else if (failed.length === 0) {
      const what =
        this.outputMode === "combined"
          ? `combined PDF (${exported} note${exported === 1 ? "" : "s"})`
          : exported === 1
          ? "1 PDF"
          : `${exported} PDFs`;
      new Notice(`Exported ${what}.`);
      this.close();
      return;
    } else {
      new Notice(
        `Exported ${exported} of ${total}. Failed: ${failed.join(", ")}.`
      );
    }
    this.exportBtn?.setButtonText("Export");
    this.updateButtons();
  }

  /** Size the body-level capture host to the in-modal preview surface. */
  private positionCaptureHost(): void {
    if (!this.captureHost || !this.previewEl) return;
    const r = this.previewEl.getBoundingClientRect();
    this.captureHost.style.left = `${r.left}px`;
    this.captureHost.style.top = `${r.top}px`;
    this.captureHost.style.width = `${r.width}px`;
    this.captureHost.style.height = `${r.height}px`;
  }

  onClose(): void {
    this.disposePreview();
    this.captureHost?.remove();
    this.contentEl.empty();
    this.previewEl = null;
    this.captureHost = null;
    this.renderBtn = null;
    this.exportBtn = null;
  }
}
