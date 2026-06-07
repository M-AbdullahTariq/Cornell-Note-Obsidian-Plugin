import { App, MarkdownView, Notice } from "obsidian";

const REVIEW_CLASS = "cornell-review";

/** Owns the global review-mode on/off state and reflects it onto open Reading
 *  views. The gate is the `cornell-review` class on each `.markdown-preview-
 *  sizer`; the blur markers themselves are stamped unconditionally by the
 *  post-processor, so flipping review mode is a pure class toggle that needs no
 *  re-render. State is ephemeral — it lives here, not in settings, so it resets
 *  to off when the plugin reloads (a study session, not a saved preference).
 *
 *  Reading view only: in source / Live Preview there is no preview sizer, so
 *  toggling has no visible effect there. */
export class ReviewModeController {
  private active = false;
  /** Per-file set of currently-revealed group keys. Kept so reveals can be
   *  re-applied after a Reading-view re-render (wired in a later phase) and so
   *  a reset can clear them. Ephemeral — never persisted. */
  private readonly revealed = new Map<string, Set<string>>();

  constructor(private readonly app: App) {}

  isActive(): boolean {
    return this.active;
  }

  /** Flip review mode and apply it to every open Reading view immediately.
   *  Turning it OFF resets all reveals, so the next time it's turned on the
   *  note starts fully blurred (a fresh recall session). When turning it ON
   *  from a non-Reading view, the notice hints that review mode is only visible
   *  in Reading view. */
  toggle(): void {
    this.active = !this.active;
    if (!this.active) this.clearAllReveals();
    this.applyToAllSizers();
    if (!this.active) {
      new Notice("Review mode off");
    } else if (this.inReadingView()) {
      new Notice("Review mode on");
    } else {
      new Notice("Review mode on — switch to reading view to use it");
    }
  }

  private inReadingView(): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return !!view && view.getMode() === "preview";
  }

  /** Re-blur everything without leaving review mode (the "reset" command). */
  resetReveals(): void {
    this.clearAllReveals();
  }

  /** Re-apply a persisted reveal to a wrapper the post-processor just
   *  (re-)stamped, so revealed regions survive Reading-view re-renders (edits,
   *  returning to the note). Keyed by the wrapper's group: the attribute is
   *  added when that group is currently revealed for the file, removed
   *  otherwise. A no-op for wrappers with no group key. */
  restoreWrapper(wrapper: HTMLElement, filePath: string): void {
    const group = wrapper.getAttribute("data-cornell-cue-group");
    if (!group) return;
    const revealed = this.revealed.get(filePath)?.has(group) ?? false;
    if (revealed) wrapper.setAttribute("data-cornell-revealed", "");
    else wrapper.removeAttribute("data-cornell-revealed");
  }

  /** Handle a click anywhere in the workspace. When review mode is active and
   *  the click landed on a cue or summary inside a review sizer, toggle the
   *  reveal of that wrapper's group — for a cue that reveals/hides its whole
   *  notes region; for a summary, just itself. Reveals accumulate (each group
   *  toggles independently). A no-op otherwise, so normal clicks are untouched. */
  handleClick(evt: MouseEvent): void {
    if (!this.active || evt.button !== 0) return;
    const target = evt.target as HTMLElement | null;
    if (!target) return;
    const sizer = target.closest(".markdown-preview-sizer.cornell-review");
    if (!sizer) return;
    const wrapper = target.closest<HTMLElement>("[data-cornell-cue-group]");
    if (!wrapper || !sizer.contains(wrapper)) return;
    // Only cues and summaries are reveal triggers — clicking inside already-
    // revealed body text (e.g. a link) must behave normally, not re-blur.
    const role = wrapper.getAttribute("data-cornell-slot");
    if (role !== "cue" && role !== "summary") return;
    const group = wrapper.getAttribute("data-cornell-cue-group");
    if (!group) return;
    this.toggleGroup(sizer, group);
  }

  /** Reflect the current state onto a sizer the post-processor just rendered,
   *  so a freshly opened Cornell note matches review mode without a re-toggle.
   *  Idempotent across the per-block post-processor calls. */
  syncSizer(sizer: Element): void {
    sizer.classList.toggle(REVIEW_CLASS, this.active);
  }

  private applyToAllSizers(): void {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view as MarkdownView;
      view.containerEl
        .querySelectorAll(".markdown-preview-sizer")
        .forEach((sizer) => sizer.classList.toggle(REVIEW_CLASS, this.active));
    });
  }

  /** Reveal or hide every wrapper in `sizer` carrying `group`. The new state is
   *  the inverse of whether the group is currently revealed at all, so a single
   *  click flips the whole group together. The choice is mirrored into the
   *  per-file revealed set for later re-application. */
  private toggleGroup(sizer: Element, group: string): void {
    const selector = `[data-cornell-cue-group="${group}"]`;
    const willReveal = !sizer.querySelector(
      `${selector}[data-cornell-revealed]`
    );
    sizer.querySelectorAll<HTMLElement>(selector).forEach((w) => {
      if (willReveal) w.setAttribute("data-cornell-revealed", "");
      else w.removeAttribute("data-cornell-revealed");
    });

    const filePath = this.filePathForSizer(sizer);
    if (!filePath) return;
    const set = this.revealed.get(filePath) ?? new Set<string>();
    if (willReveal) set.add(group);
    else set.delete(group);
    this.revealed.set(filePath, set);
  }

  private filePathForSizer(sizer: Element): string | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view.containerEl.contains(sizer)) return view.file?.path ?? null;
    }
    return null;
  }

  private clearAllReveals(): void {
    this.revealed.clear();
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view as MarkdownView;
      view.containerEl
        .querySelectorAll("[data-cornell-revealed]")
        .forEach((el) => el.removeAttribute("data-cornell-revealed"));
    });
  }
}
