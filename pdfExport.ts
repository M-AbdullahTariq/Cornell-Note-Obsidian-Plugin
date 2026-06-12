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
// file-name title) → render into an off-screen container → classify the
// printable source and stamp slot roles from the classifier's slots (the same
// authority both live views use; see exportMap.ts) → serialize → load into an
// off-screen <webview> with all styles + the `cornell-printing` light/paged
// palette → `printToPDF` → write `<note>.pdf` next to the note. Desktop only;
// the caller guards mobile.

import {
  App,
  Component,
  MarkdownRenderer,
  normalizePath,
  TFile,
  TFolder,
} from "obsidian";
import {
  ATTR_IN_REGION,
  ATTR_NOTES_END,
  ATTR_REVIEW_BLUR,
  ATTR_SLOT,
  hasCornellCssClass,
  type Slot,
} from "./classifier";
import {
  type BlockAssignment,
  type BlockShape,
  buildPrintableMarkdown,
  classifyPrintable,
  mapSlotsToBlocks,
} from "./exportMap";

export { buildPrintableMarkdown } from "./exportMap";

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

/** Read one rendered top-level block's structural signature, for aligning the
 *  classifier's slots with the export DOM (see exportMap.ts). Match priority
 *  mirrors the old DOM-only role reader: callouts first (nested matches
 *  count), then Obsidian chrome, then headings and rules. */
function blockShape(child: HTMLElement): BlockShape {
  const hasCallout = (type: string): boolean =>
    child.matches(`.callout[data-callout="${type}"]`) ||
    !!child.querySelector(`.callout[data-callout="${type}"]`);
  // Cue > summary > title, ANY descendant counts — identical to the old
  // role reader, so the fallback path's edge cases don't shift.
  for (const type of ["cue", "summary", "title"]) {
    if (hasCallout(type)) return { kind: "callout", calloutType: type };
  }
  if (child.matches(".callout") || child.querySelector(".callout")) {
    return { kind: "callout" };
  }
  if (
    child.matches(".mod-header, .metadata-container, .frontmatter") ||
    child.querySelector(".metadata-container, .frontmatter, .inline-title")
  ) {
    return { kind: "chrome" };
  }
  if (child.matches(HEADING_SELECTOR) || child.querySelector(HEADING_SELECTOR)) {
    return { kind: "heading" };
  }
  if (child.matches("hr") || child.querySelector(":scope > hr")) {
    return { kind: "hr" };
  }
  return { kind: "other" };
}

/** Apply one mapped assignment to a rendered block. Review-mode blur markers
 *  are stripped so an export is always fully revealed. */
function applyAssignment(child: HTMLElement, a: BlockAssignment): void {
  child.removeAttribute(ATTR_REVIEW_BLUR);
  if (a.role === null) {
    child.removeAttribute(ATTR_SLOT);
    child.removeAttribute(ATTR_IN_REGION);
    child.removeAttribute(ATTR_NOTES_END);
    return;
  }
  child.setAttribute(ATTR_SLOT, a.role);
  child.toggleAttribute(ATTR_IN_REGION, a.role === "heading" && a.inRegion);
  child.toggleAttribute(ATTR_NOTES_END, a.notesEnd);
}

/** Stamp a freshly rendered export grid from the classifier's slot list — the
 *  same placement authority both live views use. The DOM contributes only each
 *  block's structural shape, for alignment; the decisions ride in the slots. */
export function stampGridFromSlots(host: HTMLElement, slots: Slot[]): void {
  const kids = Array.from(host.children).filter(
    (c): c is HTMLElement => c.instanceOf(HTMLElement)
  );
  const assignments = mapSlotsToBlocks(slots, kids.map(blockShape));
  kids.forEach((child, i) => applyAssignment(child, assignments[i]));
}

/** FALLBACK ONLY — structural stamping with no source available. The one
 *  caller is the Reading-view post-processor's built-in "Export to PDF" path,
 *  where `getSectionInfo` returns null and the rendered DOM is all there is.
 *  The plugin's own export goes through `stampGridFromSlots` (classifier-
 *  driven); keep this walker byte-compatible with it, not the other way
 *  around. Idempotent. Review-mode blur markers are stripped so the result is
 *  always fully revealed. */
export function stampExportHost(host: HTMLElement): void {
  const kids = Array.from(host.children).filter(
    (c): c is HTMLElement => c.instanceOf(HTMLElement)
  );
  // With no slots to consume, every shape takes the mapper's structural
  // fallback branch — the old DOM-only behaviour, through the same code path.
  const assignments = mapSlotsToBlocks([], kids.map(blockShape));
  kids.forEach((child, i) => applyAssignment(child, assignments[i]));
}

const HOLDER_CLASS = "cornell-pdf-export-holder";

/** Electron `printToPDF` options for a Cornell PDF — always A4. The dimensions
 *  are passed explicitly in inches (210×297 mm ÷ 25.4) rather than the named "A4"
 *  size, so they apply regardless of how Electron resolves the named size.
 *  `printBackground` keeps the divider lines/colors without any user toggle. */
const A4_PRINT_OPTIONS: Record<string, unknown> = {
  printBackground: true,
  pageSize: { width: 210 / 25.4, height: 297 / 25.4 },
};

/** Pure: where the exported PDF is written — `<note>.pdf` in the note's own
 *  folder (root folder → vault root). Mirrors the note's location so the PDF
 *  sits beside its source. */
export function resolvePdfOutputPath(file: TFile): string {
  const dir = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
  return normalizePath(`${dir}${file.basename}.pdf`);
}

/** Pure: destination for the combined PDF — `name` (with a `.pdf` extension
 *  ensured, newlines stripped, blank → "Cornell Notes") inside `folderPath`
 *  (vault root when empty or "/"). Mirrors the per-note resolver's location
 *  handling for the single combined file. */
export function resolveCombinedOutputPath(
  folderPath: string,
  name: string
): string {
  const base = name.replace(/[\r\n]+/g, " ").trim() || "Cornell Notes";
  const fileName = base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
  const dir = folderPath && folderPath !== "/" ? `${folderPath}/` : "";
  return normalizePath(`${dir}${fileName}`);
}

/** Recursively collect every markdown file under a folder, descendants included.
 *  A plain walk over the vault's in-memory folder tree (no file reads); the
 *  caller filters to Cornell notes with `collectCornellNotes`. */
export function descendantMarkdownFiles(folder: TFolder): TFile[] {
  const out: TFile[] = [];
  const walk = (f: TFolder): void => {
    for (const child of f.children) {
      if (child instanceof TFolder) {
        walk(child);
      } else if (child instanceof TFile && child.extension === "md") {
        out.push(child);
      }
    }
  };
  walk(folder);
  return out;
}

/** Filter a list of markdown files to the Cornell notes among them, reusing the
 *  cssclass check against each file's frontmatter. `getFrontmatter` decouples the
 *  filter from the metadata cache so the Cornell-only rule has a single source of
 *  truth, shared between the export scope and the context-menu visibility check. */
export function collectCornellNotes(
  files: TFile[],
  getFrontmatter: (file: TFile) => unknown
): TFile[] {
  return files.filter((file) => hasCornellCssClass(getFrontmatter(file)));
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
export function buildExportBody(gridHtml: string): string {
  return `<div class="${HOLDER_CLASS} cornell-note markdown-preview-view markdown-rendered">${gridHtml}</div>`;
}

/** Body markup for a COMBINED export: every selected note's grid stacked under a
 *  single holder, in selection order. Each grid is a `.cornell-grid` sibling, so
 *  the stylesheet's "page break between consecutive grids" rule starts each note
 *  on a fresh sheet (the first has no break). Same holder classes as the
 *  single-note body, so the light palette and grid layout apply identically. */
export function buildCombinedExportBody(gridHtmls: string[]): string {
  return `<div class="${HOLDER_CLASS} cornell-note markdown-preview-view markdown-rendered">${gridHtmls.join(
    ""
  )}</div>`;
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
  const markdown = buildPrintableMarkdown(source, file.basename);

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
    // Placement comes from the classifier — the authority both live views use —
    // with the rendered blocks contributing only their shapes for alignment.
    stampGridFromSlots(grid, classifyPrintable(markdown));
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
  options: { bodyHtml: string; bodyClass: string }
): Promise<PrintWebview> {
  const doc = activeDocument;
  const win = activeWindow;

  const webview = doc.createElement("webview") as PrintWebview;
  // Styling hook: `webview` is not a standard HTML type selector (the
  // community CSS lint rejects it), so styles.css targets this class instead.
  webview.classList.add("cornell-pdf-capture");
  webview.setAttribute("src", "app://obsidian.md/help.html");
  webview.setAttribute("nodeintegration", "true");
  // Electron throttles a zero-size webview (it then prints blank), so it must
  // fill its host. Set via setCssStyles rather than a static inline `style`
  // attribute, per the Obsidian guidelines.
  webview.setCssStyles({ width: "100%", height: "100%", border: "0" });
  host.appendChild(webview);

  // `dom-ready` fires once the webview's document is ready to script against.
  await new Promise<void>((resolve, reject) => {
    const timer = win.setTimeout(
      () => reject(new Error("webview load timed out")),
      15_000
    );
    webview.addEventListener(
      "dom-ready",
      () => {
        // Wrapped in a void IIFE so the listener itself returns void (not a
        // floating Promise) while the async setup still runs to resolve/reject.
        void (async () => {
          try {
            win.clearTimeout(timer);
            await webview.insertCSS(collectAppStyles(doc));
            await webview.executeJavaScript(
              buildSetupScript(options.bodyHtml, options.bodyClass)
            );
            // Patch print media LAST so it wins over app print rules.
            await webview.insertCSS(PRINT_PATCH);
            resolve();
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        })();
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
  webview.setCssStyles({ width: "99%" });
  await new Promise<void>((resolve) => win.setTimeout(resolve, 30));
  webview.setCssStyles({ width: baseWidth });
  await new Promise<void>((resolve) => win.setTimeout(resolve, 30));
  return webview;
}

/** Print a prepared export webview to PDF bytes (an `ArrayBuffer` ready for
 *  `vault.adapter.writeBinary`). The `.print` class is toggled on the holder only
 *  for the duration of the capture — it's what Obsidian's print stylesheet keys
 *  off to reveal the content under print emulation — then removed so the
 *  on-screen preview (which Obsidian hides while `.print` is set) stays visible. */
export async function printPreparedWebview(
  webview: PrintWebview
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
    const data = await webview.printToPDF(A4_PRINT_OPTIONS);
    // Copy into a fresh ArrayBuffer (not data.buffer.slice, whose type varies
    // by lib version) so the return is a plain ArrayBuffer with no assertion.
    const out = new ArrayBuffer(data.byteLength);
    new Uint8Array(out).set(data);
    return out;
  } finally {
    await toggle(false);
  }
}
