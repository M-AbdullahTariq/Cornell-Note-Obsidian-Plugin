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
  ATTR_INVALID,
  ATTR_LINE,
  ATTR_OVER_LIMIT,
  ATTR_SLOT,
  ATTR_SUMMARY_START,
  classifyBlocks,
  hasCornellCssClass,
  invalidTooltip,
  TITLE_OVER_LIMIT_TOOLTIP,
  titleExceedsLimit,
  type Slot,
} from "./classifier";

// Warning chrome on the callout ELEMENTS themselves (red border / red text).
// These stay classes — they are presentation state on a single element, not
// part of the block-marking vocabulary the data attributes carry.
const INVALID_CALLOUT_CLASS = "cornell-invalid";
const TITLE_OVER_LIMIT_CLASS = "cornell-title-over-limit";

export const cornellRefreshEffect = StateEffect.define<void>();

export interface CornellExtensionContext {
  app: App;
}

export function buildCornellEditorExtension(ctx: CornellExtensionContext) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private rebuildTimer: number | null = null;
      /** Re-stamps embed-block wrapper classes whenever Obsidian (re)builds
       *  widget DOM. Widgets appear/disappear on cursor moves and scrolling —
       *  events that never reach `build()` — and their callout content is
       *  populated asynchronously, so a DOM observer is the one hook that sees
       *  every case. It runs as a microtask after each mutation, BEFORE the
       *  next paint, so the stamped classes never flash. */
      private embedObserver: MutationObserver;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
        this.embedObserver = new MutationObserver((records) => {
          const touched = new Set<HTMLElement>();
          for (const record of records) {
            const target = record.target;
            if (target.instanceOf(HTMLElement)) {
              const host = target.closest<HTMLElement>(".cm-embed-block");
              if (host) touched.add(host);
            }
            record.addedNodes.forEach((node) => {
              if (!node.instanceOf(HTMLElement)) return;
              if (node.matches(".cm-embed-block")) touched.add(node);
              node
                .querySelectorAll<HTMLElement>(".cm-embed-block")
                .forEach((block) => touched.add(block));
            });
          }
          touched.forEach(stampEmbedBlock);
        });
        this.embedObserver.observe(view.dom, {
          childList: true,
          subtree: true,
        });
        view.dom
          .querySelectorAll<HTMLElement>(".cm-embed-block")
          .forEach(stampEmbedBlock);
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
        this.embedObserver.disconnect();
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

        // Per-line markers use the shared vocabulary's `data-cornell-line`
        // attribute (values mirror the slot roles), so themes and the
        // stylesheet target one dialect across both views.
        const lineDeco = (attrs: Record<string, string>): Decoration =>
          Decoration.line({ attributes: attrs });

        for (const slot of slots) {
          if (
            slot.role === "cue" ||
            slot.role === "summary" ||
            slot.role === "title"
          ) {
            const attrs: Record<string, string> = { [ATTR_LINE]: slot.role };
            // An over-limit title's raw source line turns red too, so the error
            // shows while the cursor is inside the title (editing). The rendered
            // title callout is flagged separately on the next frame.
            if (slot.role === "title" && titleExceedsLimit(slot.content ?? "")) {
              attrs[ATTR_OVER_LIMIT] = "";
            }
            const startLineNum = view.state.doc.lineAt(slot.sourceRange.from).number;
            const endLineNum = view.state.doc.lineAt(
              Math.max(slot.sourceRange.from, slot.sourceRange.to - 1)
            ).number;
            for (let n = startLineNum; n <= endLineNum; n++) {
              const line = view.state.doc.line(n);
              ranges.push(lineDeco(attrs).range(line.from));
            }
            // Summary only: also tag the FIRST line so the full-width top rule
            // (the notes/summary separator) draws exactly once, not between
            // every summary line. CodeMirror merges the two decorations'
            // attribute sets (distinct keys), so the first line carries both.
            if (slot.role === "summary") {
              const firstLine = view.state.doc.line(startLineNum);
              ranges.push(
                lineDeco({ [ATTR_SUMMARY_START]: "" }).range(firstLine.from)
              );
            }
          } else if (slot.role === "body") {
            for (const r of slot.lineRanges) {
              ranges.push(
                lineDeco({ [ATTR_LINE]: "body" }).range(
                  view.state.doc.lineAt(r.from).from
                )
              );
            }
          } else if (slot.role === "gap") {
            for (const r of slot.lineRanges) {
              ranges.push(
                lineDeco({ [ATTR_LINE]: "gap" }).range(
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
            // view. Orphan headings (no owning cue) get no marker and stay at
            // the content's default indent, no divider.
            for (const r of slot.lineRanges) {
              ranges.push(
                lineDeco({ [ATTR_LINE]: "heading" }).range(
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
        const titleOverFlags = slots
          .filter((s) => s.role === "title")
          .map((s) => titleExceedsLimit(s.content ?? ""));
        window.requestAnimationFrame(() => {
          markInvalidCueCallouts(view, invalidReasons);
          markOverLimitTitles(view, titleOverFlags);
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

/** Mirror the type of the callout rendered inside a `.cm-embed-block` onto the
 *  wrapper, using the shared vocabulary's `data-cornell-slot` — the same
 *  attribute the Reading-view post-processor stamps on its block wrappers, so
 *  both views speak one dialect. styles.css used to discover this with
 *  `:has()` content selectors, which the community CSS lint flags for their
 *  broad style-invalidation cost. Like `:has()`, ANY descendant match counts —
 *  when Obsidian nests two `.cm-embed-block` wrappers around one rendered
 *  callout, both carry the attribute (the summary-separator CSS relies on
 *  that). Cue wins over summary over title when nested (mirrors the export's
 *  structural priority). The attributes are inert outside Cornell notes: every
 *  rule consuming them is scoped under `.cornell-note`. */
function stampEmbedBlock(block: HTMLElement): void {
  const has = (type: string): boolean =>
    block.querySelector(`.callout[data-callout="${type}"]`) !== null;
  const type = has("cue")
    ? "cue"
    : has("summary")
    ? "summary"
    : has("title")
    ? "title"
    : null;
  if (type) {
    block.setAttribute(ATTR_SLOT, type);
  } else {
    block.removeAttribute(ATTR_SLOT);
  }
  block.toggleAttribute(
    ATTR_INVALID,
    block.querySelector(
      `.callout[data-callout="cue"].${INVALID_CALLOUT_CLASS}`
    ) !== null
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
    // Mirror the invalid state onto the embed-block wrapper directly: the
    // observer in the view plugin only watches childList mutations, so it
    // never sees this class toggle.
    const wrapper = el.closest<HTMLElement>(".cm-embed-block");
    if (wrapper) {
      wrapper.toggleAttribute(ATTR_INVALID, reason !== null);
    }
    if (reason) {
      el.setAttribute("title", invalidTooltip(reason));
    } else {
      el.removeAttribute("title");
    }
  });
}

/** Apply the over-limit warning (red text + tooltip) to the rendered title
 *  callouts whose slot is flagged — the Live Preview half of the
 *  warn-in-both-views behaviour. Title callouts are matched to the title slots
 *  by document order, the same approach `markInvalidCueCallouts` uses for cues.
 *  Run on an animation frame because the callout DOM is populated asynchronously
 *  by Obsidian's renderer. */
function markOverLimitTitles(view: EditorView, overFlags: boolean[]): void {
  const titleEls = view.dom.querySelectorAll<HTMLElement>(
    '.callout[data-callout="title"]'
  );
  titleEls.forEach((el, idx) => {
    const over = overFlags[idx] ?? false;
    el.classList.toggle(TITLE_OVER_LIMIT_CLASS, over);
    if (over) {
      el.setAttribute("title", TITLE_OVER_LIMIT_TOOLTIP);
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
