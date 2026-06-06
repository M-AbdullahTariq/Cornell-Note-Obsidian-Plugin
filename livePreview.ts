import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { Range, StateEffect } from "@codemirror/state";
import { App, MarkdownView, TFile } from "obsidian";
import {
  classifyBlocks,
  hasCornellCssClass,
  invalidTooltip,
  type Slot,
} from "./classifier";

const CUE_LINE_CLASS = "cornell-cue-line";
const SUMMARY_LINE_CLASS = "cornell-summary-line";
const SUMMARY_START_CLASS = "cornell-summary-start";
const TITLE_LINE_CLASS = "cornell-title-line";
const BODY_LINE_CLASS = "cornell-body-line";
const HEADING_LINE_CLASS = "cornell-heading-line";
const COLLAPSED_GAP_CLASS = "cornell-collapsed-gap";
const INVALID_CALLOUT_CLASS = "cornell-invalid";

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
          if (
            slot.role === "cue" ||
            slot.role === "summary" ||
            slot.role === "title"
          ) {
            const cls =
              slot.role === "cue"
                ? CUE_LINE_CLASS
                : slot.role === "summary"
                ? SUMMARY_LINE_CLASS
                : TITLE_LINE_CLASS;
            const startLineNum = view.state.doc.lineAt(slot.sourceRange.from).number;
            const endLineNum = view.state.doc.lineAt(
              Math.max(slot.sourceRange.from, slot.sourceRange.to - 1)
            ).number;
            for (let n = startLineNum; n <= endLineNum; n++) {
              const line = view.state.doc.line(n);
              ranges.push(Decoration.line({ class: cls }).range(line.from));
            }
            // Summary only: also tag the FIRST line so the full-width top rule
            // (the notes/summary separator) draws exactly once, not between
            // every summary line. The first line carries both classes.
            if (slot.role === "summary") {
              const firstLine = view.state.doc.line(startLineNum);
              ranges.push(
                Decoration.line({ class: SUMMARY_START_CLASS }).range(
                  firstLine.from
                )
              );
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
          } else if (
            slot.role === "full" &&
            slot.isHeading &&
            slot.cueGroup != null
          ) {
            // In-region heading: give its line(s) the same divider + indent as
            // a body line so a heading sits in the notes column aligned with the
            // body and the cue|notes line runs through it — matching Reading
            // view. Orphan headings (no owning cue) get no class and stay at the
            // content's default indent, no divider.
            for (const r of slot.lineRanges) {
              ranges.push(
                Decoration.line({ class: HEADING_LINE_CLASS }).range(
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
        const invalidReasons = slots
          .filter((s) => s.role === "cue")
          .map((s) => s.invalid ?? null);
        window.requestAnimationFrame(() => {
          markInvalidCueCallouts(view, invalidReasons);
        });

        return Decoration.set(ranges, true);
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}

/** One auto-expansion rule: when a line's entire text equals `trigger`, replace
 *  the line with `insert` (the cursor lands at its end). An empty `trigger`
 *  disables the rule. */
export interface ExpansionRule {
  trigger: string;
  insert: string;
}

/** Pure trigger-matching core (no CodeMirror / Obsidian deps, unit-testable in
 *  isolation). Returns the `insert` of the FIRST rule whose non-empty trigger
 *  equals the line exactly, or null when none match. "First wins" is the
 *  collision rule: if two rules share a trigger, the earlier one (cue, by the
 *  order main.ts supplies them) takes it. Matching is whole-line equality —
 *  the line must BE the trigger, so it never fires on the word mid-sentence
 *  (a callout is always its own line anyway). */
export function resolveExpansion(
  lineText: string,
  rules: ExpansionRule[]
): string | null {
  for (const rule of rules) {
    if (rule.trigger && lineText === rule.trigger) return rule.insert;
  }
  return null;
}

export interface CalloutExpanderContext {
  app: App;
  /** Read live so a settings change takes effect without reload. Rules are
   *  ordered; earlier rules win on identical triggers (see resolveExpansion). */
  getRules: () => ExpansionRule[];
}

/** Auto-expand a configurable trigger word into a callout (cue / summary).
 *  Thin CodeMirror shell around the pure `resolveExpansion`: it reads the
 *  editor state, asks the resolver which (if any) expansion applies to the
 *  just-typed line, and dispatches the replacement. */
export function buildCalloutExpander(ctx: CalloutExpanderContext) {
  return ViewPlugin.fromClass(
    class {
      constructor(_view: EditorView) {}

      update(update: ViewUpdate) {
        if (!update.docChanged) return;

        const rules = ctx.getRules();
        // Cheap exit when nothing is configured (all triggers blank).
        if (!rules.some((r) => r.trigger)) return;

        const view = update.view;
        const file = findFileForEditor(view, ctx.app);
        if (!file) return;
        const cache = ctx.app.metadataCache.getFileCache(file);
        if (!hasCornellCssClass(cache?.frontmatter)) return;

        const sel = view.state.selection.main;
        if (!sel.empty) return;
        const line = view.state.doc.lineAt(sel.head);
        if (sel.head !== line.to) return;
        const insert = resolveExpansion(line.text, rules);
        if (insert === null) return;

        // Dispatching during an update is illegal in CodeMirror, so defer to a
        // microtask. Re-validate against the (possibly changed) current state —
        // the line must still be the trigger we matched — before committing.
        const from = line.from;
        const expected = line.text;
        queueMicrotask(() => {
          if (from > view.state.doc.length) return;
          const ln = view.state.doc.lineAt(from);
          if (ln.from !== from || ln.text !== expected) return;
          view.dispatch({
            changes: { from: ln.from, to: ln.to, insert },
            selection: { anchor: ln.from + insert.length },
          });
        });
      }
    }
  );
}

function markInvalidCueCallouts(
  view: EditorView,
  reasons: (Slot["invalid"] | null)[]
): void {
  const cueEls = view.dom.querySelectorAll<HTMLElement>(
    '.callout[data-callout="cue"]'
  );
  cueEls.forEach((el, idx) => {
    const reason = reasons[idx] ?? null;
    el.classList.toggle(INVALID_CALLOUT_CLASS, reason !== null);
    if (reason) {
      el.setAttribute("title", invalidTooltip(reason));
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
