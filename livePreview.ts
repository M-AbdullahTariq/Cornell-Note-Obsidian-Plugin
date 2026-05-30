import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { Range, StateEffect } from "@codemirror/state";
import { App, MarkdownView, TFile } from "obsidian";
import { classifyBlocks, hasCornellCssClass } from "./classifier";

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
}

export function buildCornellEditorExtension(ctx: CornellExtensionContext) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private rebuildTimer: number | null = null;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(update: ViewUpdate) {
        // Refresh effect (settings / metadata cache change): rebuild now.
        // These are user-driven events, not keystroke-spammy.
        for (const tr of update.transactions) {
          for (const effect of tr.effects) {
            if (effect.is(cornellRefreshEffect)) {
              this.cancelPendingRebuild();
              this.decorations = this.build(update.view);
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

      build(view: EditorView): DecorationSet {
        const file = findFileForEditor(view, ctx.app);
        if (!file) return Decoration.none;

        const cache = ctx.app.metadataCache.getFileCache(file);
        if (!hasCornellCssClass(cache?.frontmatter)) return Decoration.none;

        const text = view.state.doc.toString();
        const slots = classifyBlocks(text, cache?.frontmatter);

        // classifyBlocks yields [] for an empty Cornell note, which simply
        // produces no decorations.
        const ranges: Range<Decoration>[] = [];

        for (const slot of slots) {
          if (slot.role === "cue" || slot.role === "summary") {
            const cls = slot.role === "cue" ? CUE_LINE_CLASS : SUMMARY_LINE_CLASS;
            const startLineNum = view.state.doc.lineAt(slot.sourceRange.from).number;
            const endLineNum = view.state.doc.lineAt(
              Math.max(slot.sourceRange.from, slot.sourceRange.to - 1)
            ).number;
            for (let n = startLineNum; n <= endLineNum; n++) {
              const line = view.state.doc.line(n);
              ranges.push(Decoration.line({ class: cls }).range(line.from));
            }
          } else if (slot.role === "body") {
            for (const r of slot.lineRanges) {
              ranges.push(
                Decoration.line({ class: BODY_LINE_CLASS }).range(
                  view.state.doc.lineAt(r.from).from
                )
              );
            }
          } else if (slot.role === "gap") {
            for (const r of slot.lineRanges) {
              ranges.push(
                Decoration.line({ class: COLLAPSED_GAP_CLASS }).range(
                  view.state.doc.lineAt(r.from).from
                )
              );
            }
          }
        }

        // CodeMirror requires line decorations to be supplied in source-order.
        ranges.sort((a, b) => a.from - b.from);

        // Apply `.cornell-invalid` to rendered cue callouts whose slot is
        // flagged. Done on the next animation frame because the embed-block
        // DOM is populated asynchronously by Obsidian's callout renderer.
        const invalidFlags = slots
          .filter((s) => s.role === "cue")
          .map((s) => s.invalid === "adjacent-cue");
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
