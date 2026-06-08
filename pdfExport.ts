// Custom "Export note to PDF" — renders the Cornell layout into a DOM the plugin
// owns and prints THAT through an isolated Electron <webview>, instead of relying
// on Obsidian's built-in Export to PDF (whose render pipeline never applies our
// post-processor / layout CSS).
//
// Why a <webview> and not the current window's `printToPDF`: printing the live
// app window rasterizes the base (themed, often dark) frame — mutating the live
// DOM right before capture is unreliable (see pdf_export_error.md). Instead we
// load our rendered HTML + all app/plugin CSS into a *separate* web contents we
// fully control, force a light palette, and `printToPDF` that. Same technique as
// l1xnan/obsidian-better-export-pdf.
//
// Flow: read source → build printable markdown (strip frontmatter, inject the
// file-name fallback title when absent) → render into an off-screen container →
// stamp slot roles structurally → serialize → load into an off-screen <webview>
// with all styles + the `cornell-printing` light/paged palette → `printToPDF` →
// write `<note>.pdf` next to the note. Desktop only; the caller guards mobile.

import {
  App,
  Component,
  MarkdownRenderer,
  normalizePath,
  Notice,
  TFile,
} from "obsidian";
import { leadsWithTitle } from "./classifier";

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

/** Classify one top-level block wrapper in a rendered (non-source-mapped) DOM by
 *  its content. Mirrors the classifier's roles structurally: cue/summary/title
 *  from the callout type, any other callout is body, a heading-only block is a
 *  heading, and a horizontal rule or Obsidian chrome (frontmatter / properties /
 *  inline title) stays full-width (null → no attribute → default rule). Shared
 *  by the export command and the Reading-view post-processor's export fallback. */
function exportRole(
  child: HTMLElement
): "cue" | "summary" | "title" | "heading" | "body" | null {
  const hasCallout = (type: string): boolean =>
    child.matches(`.callout[data-callout="${type}"]`) ||
    !!child.querySelector(`.callout[data-callout="${type}"]`);
  if (hasCallout("cue")) return "cue";
  if (hasCallout("summary")) return "summary";
  if (hasCallout("title")) return "title";
  if (child.matches(".callout") || child.querySelector(".callout")) return "body";
  if (
    child.matches(".mod-header, .metadata-container, .frontmatter") ||
    child.querySelector(".metadata-container, .frontmatter, .inline-title")
  ) {
    return null;
  }
  if (child.matches(HEADING_SELECTOR) || child.querySelector(HEADING_SELECTOR)) {
    return "heading";
  }
  if (child.matches("hr") || child.querySelector(":scope > hr")) return null;
  return "body";
}

/** Stamp `data-cornell-slot` (+ in-region / notes-end markers) on every top-level
 *  child of a grid host by walking the DOM. Used where source line info is not
 *  available (the export command's own render, and the post-processor's
 *  export-to-PDF fallback). Idempotent. Review-mode blur markers are stripped so
 *  the result is always fully revealed. */
export function stampExportHost(host: HTMLElement): void {
  const kids = Array.from(host.children).filter(
    (c): c is HTMLElement => c instanceof HTMLElement
  );
  const roles = kids.map(exportRole);

  // In-region tracking mirrors the classifier's cueGroup: a cue opens a region;
  // a title or summary closes it. Headings inside an open region draw the
  // cue|notes divider; orphan headings (before any cue) do not.
  let active = false;
  const inRegion = roles.map((role) => {
    if (role === "cue") {
      active = true;
      return false;
    }
    if (role === "title" || role === "summary") {
      active = false;
      return false;
    }
    return active;
  });

  const dividing = (i: number): boolean =>
    roles[i] === "body" || (roles[i] === "heading" && inRegion[i]);

  kids.forEach((child, i) => {
    const role = roles[i];
    child.removeAttribute("data-cornell-review-blur");
    if (role === null) {
      child.removeAttribute("data-cornell-slot");
      child.removeAttribute("data-cornell-in-region");
      child.removeAttribute("data-cornell-notes-end");
      return;
    }
    child.setAttribute("data-cornell-slot", role);
    child.toggleAttribute(
      "data-cornell-in-region",
      role === "heading" && inRegion[i]
    );
    child.toggleAttribute(
      "data-cornell-notes-end",
      dividing(i) && !dividing(i + 1)
    );
  });
}

/** Strip a single leading YAML frontmatter block (`---` … `---`) from source. */
function stripFrontmatter(source: string): string {
  const m = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? source.slice(m[0].length) : source;
}

/** Pure: decide the markdown to render for the PDF. Frontmatter is stripped (the
 *  renderer ignores it anyway), and when the note does not lead with a
 *  `> [!title]` the file name is injected as the title callout — reproducing the
 *  Reading-view file-name fallback so every exported sheet has a heading. */
export function buildPrintableMarkdown(
  source: string,
  frontmatter: unknown,
  basename: string
): string {
  const body = stripFrontmatter(source);
  if (leadsWithTitle(source, frontmatter)) return body;
  const safeTitle = basename.replace(/[\r\n]+/g, " ").trim();
  return `> [!title] ${safeTitle}\n\n${body}`;
}

const HOLDER_CLASS = "cornell-pdf-export-holder";

/** Paper size offered for export. Electron's `printToPDF` accepts these names
 *  directly as its `pageSize` option. Persisted in settings as the last-used. */
export type PageSize = "A4" | "Letter";

/** Pure: the Electron `printToPDF` options for a given page size. `printBackground`
 *  keeps the divider lines/colors without any user toggle. */
export function printOptionsForPageSize(
  pageSize: PageSize
): Record<string, unknown> {
  return { printBackground: true, pageSize };
}

/** Pure: where the exported PDF is written — `<note>.pdf` in the note's own
 *  folder (root folder → vault root). Mirrors the note's location so the PDF
 *  sits beside its source. */
export function resolvePdfOutputPath(file: TFile): string {
  const dir = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
  return normalizePath(`${dir}${file.basename}.pdf`);
}

/** Minimal shape of the Electron `<webview>` element we drive. The tag exposes
 *  its own `printToPDF` (printing ITS web contents, not the app window's),
 *  plus `insertCSS` / `executeJavaScript` to set up the isolated document. */
export interface PrintWebview extends HTMLElement {
  insertCSS(css: string): Promise<string>;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  printToPDF(options: Record<string, unknown>): Promise<Uint8Array>;
}

/** Collect every CSS rule currently applied in the app (theme variables + the
 *  plugin's own styles.css) as text, so it can be replayed into the isolated
 *  print webview. Cross-origin sheets that throw on `cssRules` access are
 *  skipped — they hold no styles relevant to our rendered content. */
function collectAppStyles(doc: Document): string {
  const css: string[] = [];
  Array.from(doc.styleSheets).forEach((sheet) => {
    try {
      Array.from(sheet.cssRules ?? []).forEach((rule) => css.push(rule.cssText));
    } catch {
      /* opaque/cross-origin sheet — skip */
    }
  });
  return css.join("\n");
}

/** Body markup for the export webview. The wrapper carries:
 *  - `markdown-preview-view markdown-rendered`: standard Obsidian content
 *    classes so app styling applies.
 *  - `cornell-pdf-export-holder` + `cornell-note`: drive the light palette and
 *    the Cornell grid layout.
 *  The `print` class is deliberately NOT set here. Obsidian's app stylesheet
 *  only reveals `.print` containers in `@media print` and HIDES them on screen,
 *  so tagging it up-front would make the on-screen preview blank. Instead it's
 *  toggled on transiently by `printPreparedWebview`, right before capture, so
 *  the preview shows content AND the PDF (print emulation) reveals it. */
function buildExportBody(gridHtml: string): string {
  return `<div class="${HOLDER_CLASS} cornell-note markdown-preview-view markdown-rendered">${gridHtml}</div>`;
}

/** Patch injected into the webview. Two jobs:
 *  1. Defeat skipped painting: Obsidian puts `content-visibility`/`contain` on
 *     `.markdown-preview-view` / rendered content, so off-screen blocks get a
 *     reserved size but are NOT painted on screen — the live preview shows blank
 *     even though the DOM is laid out (print media still renders everything, so
 *     the PDF was always fine). Force every block in our holder to paint.
 *  2. Print media: keep our content visible + un-collapsed when printToPDF
 *     switches to print emulation (app print CSS otherwise constrains heights /
 *     hides non-`.print` content). */
const PRINT_PATCH = `
.${HOLDER_CLASS}, .${HOLDER_CLASS} * {
  content-visibility: visible !important;
  contain: none !important;
}
html, body { height: auto !important; overflow: visible !important; }
.print, .${HOLDER_CLASS} { display: block !important; }
@media print {
  html, body { height: auto !important; overflow: visible !important; }
  .print, .${HOLDER_CLASS} { display: block !important; }
  .${HOLDER_CLASS} { min-height: 0 !important; }
}
`;

/** JS run inside the webview once it's ready: swap in our content and force the
 *  light theme so a dark app theme can't bleed into the printed sheet. Content
 *  is passed URI-encoded to survive any quotes/backticks in the rendered HTML. */
function buildSetupScript(bodyHtml: string, bodyClass: string): string {
  return `
    document.body.className = ${JSON.stringify(bodyClass)};
    document.body.innerHTML = decodeURIComponent("${encodeURIComponent(bodyHtml)}");
    true;
  `;
}

/** Render the active Cornell note to the grid HTML used for export: build the
 *  printable markdown, render it into an off-screen container, stamp slot roles,
 *  and return the grid's `outerHTML`. The container only exists to host the
 *  render and is always cleaned up. Throws if the markdown render fails. */
export async function renderCornellExportHtml(
  app: App,
  file: TFile
): Promise<string> {
  const { grid, dispose } = await renderCornellExportGrid(app, file);
  try {
    return grid.outerHTML;
  } finally {
    dispose();
  }
}

/** Render the Cornell note into an off-screen, slot-stamped grid element and
 *  return it live, along with a `dispose()` that unloads the render component
 *  and removes the off-screen host. The element stays mounted in the host until
 *  disposed; move it elsewhere with `appendChild` (which detaches it from the
 *  host) to reuse it — e.g. as a native, in-app preview that does not depend on
 *  the webview painting on screen. Call `dispose()` when the element is no
 *  longer needed. Throws if the markdown render fails. */
export async function renderCornellExportGrid(
  app: App,
  file: TFile
): Promise<{ grid: HTMLElement; dispose: () => void }> {
  const doc = activeDocument;
  const win = activeWindow;

  const source = await app.vault.cachedRead(file);
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  const markdown = buildPrintableMarkdown(source, frontmatter, file.basename);

  const renderHost = doc.body.createDiv({
    cls: `${HOLDER_CLASS} cornell-note`,
  });
  const grid = renderHost.createDiv({ cls: "cornell-grid markdown-rendered" });
  const component = new Component();
  component.load();
  const dispose = (): void => {
    component.unload();
    renderHost.remove();
  };

  try {
    await MarkdownRenderer.render(app, markdown, grid, file.path, component);
    stampExportHost(grid);
    // Let any async sub-renders (callouts, math, embeds) settle.
    await new Promise<void>((resolve) => win.setTimeout(resolve, 150));
    return { grid, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}

/** The `<body>` class list for the export webview: the app's current body
 *  classes with the dark theme swapped for light, plus the `cornell-printing`
 *  flag that activates the light-palette / paged-output / un-blur rules. */
export function bodyClassForExport(doc: Document): string {
  return [
    ...Array.from(doc.body.classList).filter((c) => c !== "theme-dark"),
    "theme-light",
    "cornell-printing",
  ].join(" ");
}

/** Create the export webview inside `host`, load a real `app://` page (so
 *  relative font/image URLs and the CSP resolve as in the main window), then
 *  inject all app + plugin CSS, our content, and the print patch. Resolves with
 *  the prepared, painted webview — ready for `printPreparedWebview`. The webview
 *  MUST be on-screen (an off-screen one is render-throttled by Electron and
 *  prints blank); the caller owns `host` and its visibility/cleanup. */
export async function prepareExportWebview(
  host: HTMLElement,
  options: { gridHtml: string; bodyClass: string }
): Promise<PrintWebview> {
  const doc = activeDocument;
  const win = activeWindow;

  const webview = doc.createElement("webview") as PrintWebview;
  webview.setAttribute("src", "app://obsidian.md/help.html");
  webview.setAttribute("nodeintegration", "true");
  webview.setAttribute("style", "width:100%;height:100%;border:0;");
  host.appendChild(webview);

  // `dom-ready` fires once the webview's document is ready to script against.
  await new Promise<void>((resolve, reject) => {
    const timer = win.setTimeout(
      () => reject(new Error("webview load timed out")),
      15_000
    );
    webview.addEventListener(
      "dom-ready",
      async () => {
        try {
          win.clearTimeout(timer);
          await webview.insertCSS(collectAppStyles(doc));
          await webview.executeJavaScript(
            buildSetupScript(buildExportBody(options.gridHtml), options.bodyClass)
          );
          // Patch print media LAST so it wins over app print rules.
          await webview.insertCSS(PRINT_PATCH);
          resolve();
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
      { once: true }
    );
  });

  // Let the injected content lay out and paint before any capture.
  await new Promise<void>((resolve) => win.setTimeout(resolve, 250));

  // Repaint nudge: Electron's <webview> can keep compositing the stale initial
  // frame (blank) and never paint content injected after load, until it receives
  // a resize. A brief width toggle forces a resize → recomposite. Harmless when
  // the content already painted; required inside an animated container (the
  // preview modal), where the post-load paint is otherwise dropped.
  const baseWidth = webview.style.width || "100%";
  webview.style.width = "99%";
  await new Promise<void>((resolve) => win.setTimeout(resolve, 30));
  webview.style.width = baseWidth;
  await new Promise<void>((resolve) => win.setTimeout(resolve, 30));
  return webview;
}

/** Print a prepared export webview to PDF bytes (an `ArrayBuffer` ready for
 *  `vault.adapter.writeBinary`). The `.print` class is toggled on the holder only
 *  for the duration of the capture — it's what Obsidian's print stylesheet keys
 *  off to reveal the content under print emulation — then removed so the
 *  on-screen preview (which Obsidian hides while `.print` is set) stays visible. */
export async function printPreparedWebview(
  webview: PrintWebview,
  pageSize: PageSize
): Promise<ArrayBuffer> {
  const win = activeWindow;
  const toggle = (on: boolean): Promise<unknown> =>
    webview.executeJavaScript(
      `(function(){var h=document.querySelector(${JSON.stringify(
        `.${HOLDER_CLASS}`
      )});if(h){h.classList.${on ? "add" : "remove"}("print");}return true;})()`
    );

  await toggle(true);
  // Let the print-class reflow settle before capture.
  await new Promise<void>((resolve) => win.setTimeout(resolve, 50));
  try {
    const data = await webview.printToPDF(printOptionsForPageSize(pageSize));
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength
    ) as ArrayBuffer;
  } finally {
    await toggle(false);
  }
}

/** Render the active Cornell note, then print it to `<note>.pdf` via an isolated
 *  <webview> we fully control (own theme, own CSS, no app chrome). Orchestrates
 *  the extracted steps behind a transient "Generating PDF…" overlay that keeps
 *  the webview on-screen during capture. Desktop only; the caller guards mobile.
 *  (Phase 3 replaces this overlay with a preview modal that reuses the same
 *  render / prepare / print seams.) */
export async function exportCornellNoteToPdf(
  app: App,
  file: TFile,
  pageSize: PageSize = "A4"
): Promise<void> {
  const doc = activeDocument;

  let gridHtml: string;
  try {
    gridHtml = await renderCornellExportHtml(app, file);
  } catch (e) {
    new Notice(`Could not render note for PDF export: ${String(e)}`);
    return;
  }

  // Visible "Generating PDF…" overlay holding the webview. On-screen so Electron
  // lays out + paints it.
  const overlay = doc.body.createDiv();
  overlay.setAttribute(
    "style",
    "position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;" +
      "align-items:center;justify-content:center;gap:8px;" +
      "background:rgba(0,0,0,0.4);"
  );
  const caption = overlay.createDiv({ text: "Generating PDF…" });
  caption.setAttribute(
    "style",
    "color:#fff;font-size:14px;font-family:var(--font-interface,sans-serif);"
  );
  const frame = overlay.createDiv();
  frame.setAttribute(
    "style",
    "width:800px;height:520px;background:#fff;overflow:hidden;" +
      "box-shadow:0 4px 24px rgba(0,0,0,0.5);"
  );

  try {
    const webview = await prepareExportWebview(frame, {
      gridHtml,
      bodyClass: bodyClassForExport(doc),
    });
    const bytes = await printPreparedWebview(webview, pageSize);
    const outPath = resolvePdfOutputPath(file);
    await app.vault.adapter.writeBinary(outPath, bytes);
    new Notice(`Exported PDF: ${outPath}`);
  } catch (e) {
    new Notice(`PDF export failed: ${String(e)}`);
  } finally {
    overlay.remove();
  }
}
