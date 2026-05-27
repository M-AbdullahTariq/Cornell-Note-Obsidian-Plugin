import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { Range, StateEffect } from "@codemirror/state";
import { App, MarkdownView, TFile } from "obsidian";
import { hasCornellCssClass, parseCornell } from "./parser";
import { ancestorChain, describeElement, Logger } from "./logger";

const CUE_LINE_CLASS = "cornell-cue-line";
const SUMMARY_LINE_CLASS = "cornell-summary-line";
const BODY_LINE_CLASS = "cornell-body-line";
const COLLAPSED_GAP_CLASS = "cornell-collapsed-gap";
const INVALID_CALLOUT_CLASS = "cornell-invalid";
const INVALID_TOOLTIP =
  "Cue has no body block before the next cue. Add content below, or merge the cues.";

export const cornellRefreshEffect = StateEffect.define<void>();

export interface CornellExtensionContext {
  app: App;
  logger?: Logger;
}

export function buildCornellEditorExtension(ctx: CornellExtensionContext) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private rebuildTimer: number | null = null;

      constructor(view: EditorView) {
        ctx.logger?.log("[LP] ViewPlugin constructed for view.dom:", describeElement(view.dom));
        this.decorations = this.build(view, "construct");
      }

      update(update: ViewUpdate) {
        // Refresh effect (settings / metadata cache change): rebuild now.
        // These are user-driven events, not keystroke-spammy.
        for (const tr of update.transactions) {
          for (const effect of tr.effects) {
            if (effect.is(cornellRefreshEffect)) {
              this.cancelPendingRebuild();
              this.decorations = this.build(update.view, "refresh-effect");
              return;
            }
          }
        }
        // Doc changed: debounce the rebuild so the red-border validation
        // doesn't flicker on every keystroke while the user is mid-typing
        // a body block between two cues. CodeMirror automatically maps
        // existing line decorations through the changes, so what's on
        // screen stays visually plausible during the debounce window.
        if (update.docChanged) {
          this.scheduleRebuild(update.view);
        }
      }

      private scheduleRebuild(view: EditorView) {
        this.cancelPendingRebuild();
        this.rebuildTimer = window.setTimeout(() => {
          this.rebuildTimer = null;
          view.dispatch({ effects: cornellRefreshEffect.of() });
        }, 300);
      }

      private cancelPendingRebuild() {
        if (this.rebuildTimer !== null) {
          window.clearTimeout(this.rebuildTimer);
          this.rebuildTimer = null;
        }
      }

      destroy() {
        this.cancelPendingRebuild();
      }

      build(view: EditorView, reason: string): DecorationSet {
        const log = ctx.logger;
        log?.log(`[LP] build (reason=${reason})`);

        const file = findFileForEditor(view, ctx.app);
        log?.log("  file:", file?.path ?? "<not found>");

        if (!file) {
          log?.log("  → no file, returning none");
          return Decoration.none;
        }

        const cache = ctx.app.metadataCache.getFileCache(file);
        log?.log("  frontmatter:", cache?.frontmatter ?? "<none>");
        const isCornell = hasCornellCssClass(cache?.frontmatter);
        log?.log("  hasCornellCssClass:", isCornell);

        // DOM diagnostics: how far up the tree does the cornell-note class go?
        log?.log("  view.dom ancestor chain:", ancestorChain(view.dom, 12));
        const cornellAncestor = view.dom.closest(".cornell-note");
        log?.log("  closest('.cornell-note'):", describeElement(cornellAncestor));

        if (!isCornell) {
          log?.log("  → not a Cornell file, returning none");
          return Decoration.none;
        }

        // Inspect rendered callouts and computed styles after a short delay so
        // the editor has had time to paint.
        window.setTimeout(() => {
          const cmContent = view.dom.querySelector(".cm-content") as HTMLElement | null;
          if (cmContent) {
            const cs = window.getComputedStyle(cmContent);
            log?.log("  [post] cm-content paddingLeft:", cs.paddingLeft);
          }
          const cmEditor = view.dom.classList.contains("cm-editor")
            ? view.dom
            : (view.dom.querySelector(".cm-editor") as HTMLElement | null);
          if (cmEditor) {
            const cs = window.getComputedStyle(cmEditor);
            log?.log("  [post] cm-editor position:", cs.position);
            // ::before pseudo
            const cb = window.getComputedStyle(cmEditor, "::before");
            log?.log("  [post] cm-editor::before content:", cb.content, "left:", cb.left, "top:", cb.top);
          }

          const cues = view.dom.querySelectorAll('.callout[data-callout="cue"]');
          log?.log(`  [post] rendered cue callouts: ${cues.length}`);
          cues.forEach((c, i) => {
            const el = c as HTMLElement;
            const cs = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            log?.log(
              `    cue[${i}] pos=${cs.position} left=${cs.left} top=${cs.top} w=${cs.width} h=${cs.height} bg=${cs.backgroundColor} z=${cs.zIndex} vis=${cs.visibility} opacity=${cs.opacity} transform=${cs.transform} clip=${cs.clipPath}`
            );
            log?.log(
              `    cue[${i}] rect: x=${rect.x.toFixed(1)} y=${rect.y.toFixed(1)} w=${rect.width.toFixed(1)} h=${rect.height.toFixed(1)}`
            );
            // Walk up logging each ancestor's potentially-clipping properties.
            let p: HTMLElement | null = el.parentElement;
            let depth = 0;
            while (p && depth < 6) {
              const pcs = window.getComputedStyle(p);
              const pr = p.getBoundingClientRect();
              log?.log(
                `      [${depth}] ${p.tagName}.${p.className.toString().slice(0, 60)} overflow=${pcs.overflow} clip=${pcs.clipPath} contain=${pcs.contain} transform=${pcs.transform} pos=${pcs.position} rect=(${pr.x.toFixed(0)},${pr.y.toFixed(0)},${pr.width.toFixed(0)}x${pr.height.toFixed(0)})`
              );
              p = p.parentElement;
              depth++;
            }
          });
        }, 500);

        const text = view.state.doc.toString();
        const result = parseCornell(text, cache?.frontmatter);
        log?.log(
          "  parser items:",
          result.items.length,
          "body lines:",
          result.bodyLineRanges.length,
          "gap lines:",
          result.cueGapRanges.length
        );

        if (!result.isCornell) return Decoration.none;

        const ranges: Range<Decoration>[] = [];

        for (const item of result.items) {
          const cls = item.type === "cue" ? CUE_LINE_CLASS : SUMMARY_LINE_CLASS;
          const startLineNum = view.state.doc.lineAt(item.sourceRange.from).number;
          const endLineNum = view.state.doc.lineAt(
            Math.max(item.sourceRange.from, item.sourceRange.to - 1)
          ).number;
          for (let n = startLineNum; n <= endLineNum; n++) {
            const line = view.state.doc.line(n);
            ranges.push(Decoration.line({ class: cls }).range(line.from));
          }
        }

        for (const r of result.bodyLineRanges) {
          ranges.push(
            Decoration.line({ class: BODY_LINE_CLASS }).range(
              view.state.doc.lineAt(r.from).from
            )
          );
        }

        for (const r of result.cueGapRanges) {
          ranges.push(
            Decoration.line({ class: COLLAPSED_GAP_CLASS }).range(
              view.state.doc.lineAt(r.from).from
            )
          );
        }

        // CodeMirror requires line decorations to be supplied in source-order.
        ranges.sort((a, b) => a.from - b.from);

        log?.log(`  → applying ${ranges.length} line decorations`);

        // Apply `.cornell-invalid` to rendered cue callouts whose parser item
        // is flagged. Done on the next animation frame because the embed-block
        // DOM is populated asynchronously by Obsidian's callout renderer.
        const invalidFlags = result.items
          .filter((it) => it.type === "cue")
          .map((it) => it.invalid === "adjacent-cue");
        window.requestAnimationFrame(() => {
          markInvalidCueCallouts(view, invalidFlags);
        });

        return Decoration.set(ranges, true);
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}

function markInvalidCueCallouts(view: EditorView, flags: boolean[]): void {
  const cueEls = view.dom.querySelectorAll<HTMLElement>(
    '.callout[data-callout="cue"]'
  );
  cueEls.forEach((el, idx) => {
    const invalid = !!flags[idx];
    el.classList.toggle(INVALID_CALLOUT_CLASS, invalid);
    if (invalid) {
      el.setAttribute("title", INVALID_TOOLTIP);
    } else {
      el.removeAttribute("title");
    }
  });
}

function findFileForEditor(view: EditorView, app: App): TFile | null {
  const dom = view.dom;
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const v = leaf.view as MarkdownView;
    if (v.containerEl.contains(dom)) {
      return v.file ?? null;
    }
  }
  return null;
}
