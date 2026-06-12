// DEBUG HARNESS (throwaway) — Live Preview click→line mapping repro.
//
// Mounts a real CodeMirror 6 editor styled exactly like the plugin's Live
// Preview state (line attributes from livePreview.ts vocabulary + rendered
// callout widgets carrying the same classes/attributes Obsidian stamps), then
// round-trips coordsAtPos -> posAtCoords(_, false) — the same call mouse
// clicks use — for every body line. A mismatch means a click at that visual
// spot puts the cursor on a different document line.
//
// URL toggles:
//   ?fix=margins  inject overrides converting vertical margins to paddings
//   ?fix=nogap    disable the gap-line height collapse
import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { EditorState, RangeSetBuilder } from "@codemirror/state";

const LINES = [
  /* 1 */ "> [!title] Atomic Habits", // title widget
  /* 2 */ "",
  /* 3 */ "> [!cue] Identity-based habits", // cue widget
  /* 4 */ "",
  /* 5 */ "The most effective way to change habits is to focus on who you wish to become.",
  /* 6 */ "Every action is a vote for the type of person you want to be.",
  /* 7 */ "",
  /* 8 */ "> [!cue] Test", // cue widget
  /* 9 */ "",
  /* 10 */ "Awd",
  /* 11 */ "",
  /* 12 */ "> [!summary]", // summary widget (with line 13)
  /* 13 */ "> Big change is the product of many small, repeated decisions.",
];
const WIDGETS = [
  { from: 1, to: 1, type: "title", title: "Atomic Habits", body: null },
  { from: 3, to: 3, type: "cue", title: "Identity-based habits", body: null },
  { from: 8, to: 8, type: "cue", title: "Test", body: null },
  {
    from: 12,
    to: 13,
    type: "summary",
    title: "Summary",
    body: "Big change is the product of many small, repeated decisions.",
  },
];
const LINE_ATTRS = {
  2: "gap",
  4: "gap",
  5: "body",
  6: "body",
  7: "gap",
  9: "gap",
  10: "body",
  11: "gap",
};
const BODY_LINES = [5, 6, 10];

class CalloutWidget extends WidgetType {
  constructor(type, title, body) {
    super();
    this.type = type;
    this.title = title;
    this.body = body;
  }
  eq(other) {
    return other.type === this.type && other.title === this.title;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-embed-block cm-callout";
    wrap.setAttribute("data-cornell-slot", this.type);
    const rendered = wrap.appendChild(document.createElement("div"));
    rendered.className = "markdown-rendered";
    const callout = rendered.appendChild(document.createElement("div"));
    callout.className = "callout";
    callout.setAttribute("data-callout", this.type);
    const titleEl = callout.appendChild(document.createElement("div"));
    titleEl.className = "callout-title";
    const inner = titleEl.appendChild(document.createElement("div"));
    inner.className = "callout-title-inner";
    inner.textContent = this.title;
    if (this.body) {
      const content = callout.appendChild(document.createElement("div"));
      content.className = "callout-content";
      const p = content.appendChild(document.createElement("p"));
      p.textContent = this.body;
    }
    return wrap;
  }
  get estimatedHeight() {
    return -1;
  }
  ignoreEvent() {
    return false;
  }
}

function buildDecorations(state) {
  const builder = new RangeSetBuilder();
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const widget = WIDGETS.find((w) => w.from === n);
    if (widget) {
      const fromLine = state.doc.line(widget.from);
      const toLine = state.doc.line(widget.to);
      builder.add(
        fromLine.from,
        toLine.to,
        Decoration.replace({
          widget: new CalloutWidget(widget.type, widget.title, widget.body),
          block: true,
        })
      );
      n = widget.to;
      continue;
    }
    const role = LINE_ATTRS[n];
    if (role) {
      builder.add(
        line.from,
        line.from,
        Decoration.line({ attributes: { "data-cornell-line": role } })
      );
    }
  }
  return builder.finish();
}

const params = new URLSearchParams(location.search);
const fix = params.get("fix");
if (fix === "margins") {
  const style = document.createElement("style");
  style.textContent = `
    .cornell-note .cm-embed-block.cm-callout[data-cornell-slot="summary"] {
      margin: 0 !important;
      padding-top: var(--cue-gap) !important;
    }
    .cornell-note .cm-embed-block.cm-callout[data-cornell-slot="title"] {
      margin: 0 0 0 calc(0px - var(--cue-column-offset)) !important;
      padding-bottom: var(--cornell-title-gap) !important;
    }
  `;
  document.head.appendChild(style);
} else if (fix === "nogap") {
  const style = document.createElement("style");
  style.textContent = `
    .cornell-note .cm-line[data-cornell-line="gap"] {
      height: auto !important;
      min-height: 1em !important;
      line-height: 1.5 !important;
      overflow: visible;
    }
  `;
  document.head.appendChild(style);
}

const host = document.getElementById("host");
const state = EditorState.create({
  doc: LINES.join("\n"),
  extensions: [
    EditorView.decorations.compute(["doc"], (s) => buildDecorations(s)),
    EditorView.editable.of(true),
  ],
});
const view = new EditorView({ state, parent: host });

function probe() {
  const results = [];
  for (const n of BODY_LINES) {
    const line = view.state.doc.line(n);
    const startRect = view.coordsAtPos(line.from, 1);
    const endRect = view.coordsAtPos(line.to, -1);
    if (!startRect || !endRect) {
      results.push({ line: n, error: "no coords" });
      continue;
    }
    const y = (startRect.top + startRect.bottom) / 2;
    const probes = {
      textMiddle: { x: (startRect.left + endRect.right) / 2, y },
      pastLineEnd: { x: endRect.right + 60, y },
    };
    const entry = { line: n, text: line.text.slice(0, 20) };
    for (const [name, pt] of Object.entries(probes)) {
      const pos = view.posAtCoords(pt, false);
      const got = view.state.doc.lineAt(pos).number;
      entry[name] = { x: Math.round(pt.x), y: Math.round(pt.y), got, ok: got === n };
    }
    results.push(entry);
  }
  const pass = results.every(
    (r) => !r.error && r.textMiddle.ok && r.pastLineEnd.ok
  );
  const payload = { fix: fix ?? "none", pass, results };
  const out = document.getElementById("out");
  out.textContent = JSON.stringify(payload, null, 2);
  document.title = pass ? "PASS" : "FAIL";
  // Report back to the runner when served over localhost.
  if (location.protocol.startsWith("http")) {
    fetch("/result", { method: "POST", body: JSON.stringify(payload) }).catch(
      () => {}
    );
  }
}

// Let CM finish its initial measure cycles before probing.
requestAnimationFrame(() =>
  requestAnimationFrame(() => setTimeout(probe, 50))
);
