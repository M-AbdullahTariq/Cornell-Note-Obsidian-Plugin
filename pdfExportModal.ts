// Preview-and-export modal for "Export note to PDF". Shows a live preview of the
// Cornell sheet, lets the user pick the page size (A4 / Letter, persisted in
// settings), and writes `<note>.pdf` next to the note on Export. Built with plain
// DOM on Obsidian's Modal — no Svelte. Desktop only — the caller guards mobile.
//
// Preview and capture are intentionally DECOUPLED:
//   - Preview: the Cornell grid is rendered as native in-app DOM (exactly like
//     Reading view), so it always paints. An Electron <webview> nested in the
//     modal does NOT reliably paint on screen (content gets a reserved size but
//     is skipped during paint), so it can't back the visible preview.
//   - Capture: a <webview> renders the same content and is used ONLY for
//     `printToPDF` (which renders in print media, independent of on-screen
//     paint, so it works regardless). It sits behind the native preview.
//
// Preview / capture technique adapted from l1xnan/obsidian-better-export-pdf
// (MIT); see README credits.

import { ButtonComponent, Modal, Notice, TFile } from "obsidian";
import type CornellNotesPlugin from "./main";
import {
  PAGE_SIZES,
  PageSize,
  PrintWebview,
  bodyClassForExport,
  prepareExportWebview,
  printPreparedWebview,
  renderCornellExportGrid,
  resolvePdfOutputPath,
} from "./pdfExport";

export class CornellPdfExportModal extends Modal {
  private readonly plugin: CornellNotesPlugin;
  private readonly file: TFile;
  private pageSize: PageSize;
  private webview: PrintWebview | null = null;
  private exportBtn: ButtonComponent | null = null;
  // The visible preview (native DOM) and the capture <webview> both live in a
  // body-level fixed host positioned over an in-modal placeholder slot. The host
  // is body-level so the webview stays on-screen and full-size (Electron throttles
  // off-screen webviews), while the native preview layer sits on top of it.
  private previewHost: HTMLElement | null = null;
  private previewSlot: HTMLElement | null = null;
  private gridDispose: (() => void) | null = null;
  private readonly syncRect = (): void => this.positionPreviewHost();

  constructor(plugin: CornellNotesPlugin, file: TFile) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
    this.pageSize = plugin.settings.pdfPageSize;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    this.modalEl.addClass("cornell-pdf-export-modal");
    titleEl.setText("Export to PDF");

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

    // In-modal placeholder reserving the preview's space in the layout.
    this.previewSlot = contentEl.createDiv({ cls: "cornell-pdf-export-preview" });

    // Body-level fixed host (positioned over the slot) for the preview layers.
    this.previewHost = activeDocument.body.createDiv({
      cls: "cornell-pdf-export-host",
    });
    const status = this.previewHost.createDiv({
      cls: "cornell-pdf-export-status",
      text: "Rendering preview…",
    });

    // Action buttons.
    const buttons = contentEl.createDiv({ cls: "cornell-pdf-export-buttons" });
    new ButtonComponent(buttons)
      .setButtonText("Cancel")
      .onClick(() => this.close());
    this.exportBtn = new ButtonComponent(buttons)
      .setButtonText("Export")
      .setCta()
      .setDisabled(true)
      .onClick(() => void this.runExport());

    // Keep the host aligned with the slot on layout changes.
    activeWindow.addEventListener("resize", this.syncRect);
    activeWindow.requestAnimationFrame(this.syncRect);

    void this.renderPreview(status);
  }

  /** Position the body-level host over the in-modal placeholder slot. */
  private positionPreviewHost(): void {
    if (!this.previewHost || !this.previewSlot) return;
    const r = this.previewSlot.getBoundingClientRect();
    this.previewHost.style.left = `${r.left}px`;
    this.previewHost.style.top = `${r.top}px`;
    this.previewHost.style.width = `${r.width}px`;
    this.previewHost.style.height = `${r.height}px`;
  }

  /** Render the note once: mount the live grid as the native preview (front),
   *  and prepare a capture webview with the same content (behind). */
  private async renderPreview(status: HTMLElement): Promise<void> {
    if (!this.previewHost) return;
    try {
      this.positionPreviewHost();
      const { grid, dispose } = await renderCornellExportGrid(
        this.app,
        this.file
      );
      this.gridDispose = dispose;
      const gridHtml = grid.outerHTML;

      // Native preview layer (front): move the live grid under a `.cornell-note`
      // ancestor so the plugin's grid-layout CSS applies, exactly like Reading
      // view. This is what the user sees.
      const native = this.previewHost.createDiv({
        cls: "cornell-pdf-preview-native cornell-note",
      });
      native.appendChild(grid);

      // Capture layer (behind): the webview, used only for printToPDF.
      this.webview = await prepareExportWebview(this.previewHost, {
        gridHtml,
        bodyClass: bodyClassForExport(activeDocument),
      });

      status.remove();
      this.exportBtn?.setDisabled(false);
    } catch (e) {
      status.setText(`Preview failed: ${String(e)}`);
    }
  }

  /** Print the prepared capture webview to `<note>.pdf` next to the note. */
  private async runExport(): Promise<void> {
    if (!this.webview) {
      new Notice("Preview isn't ready yet.");
      return;
    }
    this.exportBtn?.setDisabled(true).setButtonText("Exporting…");
    try {
      const bytes = await printPreparedWebview(this.webview, this.pageSize);
      const outPath = resolvePdfOutputPath(this.file);
      await this.app.vault.adapter.writeBinary(outPath, bytes);
      new Notice(`Exported PDF: ${outPath}`);
      this.close();
    } catch (e) {
      new Notice(`PDF export failed: ${String(e)}`);
      this.exportBtn?.setDisabled(false).setButtonText("Export");
    }
  }

  onClose(): void {
    activeWindow.removeEventListener("resize", this.syncRect);
    this.gridDispose?.();
    this.previewHost?.remove();
    this.contentEl.empty();
    this.previewHost = null;
    this.previewSlot = null;
    this.gridDispose = null;
    this.webview = null;
    this.exportBtn = null;
  }
}
