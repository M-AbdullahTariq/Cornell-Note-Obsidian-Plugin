import { App, MarkdownView, Notice } from "obsidian";
import { ATTR_CUE_GROUP, ATTR_REVEALED, ATTR_SLOT } from "./classifier";
import { isRevealTrigger, ReviewState } from "./reviewModel";

const REVIEW_CLASS = "cornell-review";

/** Thin DOM adapter over the pure `ReviewState` model (reviewModel.ts), which
 *  owns the on/off flag and the per-file reveal memory. This controller
 *  reflects the model onto open Reading views: the gate is the
 *  `cornell-review` class on each `.markdown-preview-sizer`; the blur markers
 *  themselves are stamped unconditionally by the post-processor, so flipping
 *  review mode is a pure class toggle that needs no re-render.
 *
 *  Reading view only: in source / Live Preview there is no preview sizer, so
 *  toggling has no visible effect there. */
export class ReviewModeController {
  private readonly state = new ReviewState();

  constructor(private readonly app: App) {}

  isActive(): boolean {
    return this.state.isActive();
  }

  /** Flip review mode and apply it to every open Reading view immediately.
   *  Turning it OFF resets all reveals (the model clears its memory; the
   *  stamped attributes are cleared here), so the next time it's turned on the
   *  note starts fully blurred. When turning it ON from a non-Reading view,
   *  the notice hints that review mode is only visible in Reading view. */
  toggle(): void {
    const active = this.state.toggle();
    if (!active) this.clearRevealAttributes();
    this.applyToAllSizers();
    if (!active) {
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
    this.state.reset();
    this.clearRevealAttributes();
  }

  /** Re-apply a persisted reveal to a wrapper the post-processor just
   *  (re-)stamped, so revealed regions survive Reading-view re-renders (edits,
   *  returning to the note). Keyed by the wrapper's group: the attribute is
   *  added when the model has that group revealed for the file, removed
   *  otherwise. A no-op for wrappers with no group key. */
  restoreWrapper(wrapper: HTMLElement, filePath: string): void {
    const group = wrapper.getAttribute(ATTR_CUE_GROUP);
    if (!group) return;
    if (this.state.isRevealed(filePath, group)) {
      wrapper.setAttribute(ATTR_REVEALED, "");
    } else {
      wrapper.removeAttribute(ATTR_REVEALED);
    }
  }

  /** Handle a click anywhere in the workspace. When review mode is active and
   *  the click landed on a cue or summary inside a review sizer, toggle the
   *  reveal of that wrapper's group — for a cue that reveals/hides its whole
   *  notes region; for a summary, just itself. Reveals accumulate (each group
   *  toggles independently). A no-op otherwise, so normal clicks are untouched. */
  handleClick(evt: MouseEvent): void {
    if (!this.state.isActive() || evt.button !== 0) return;
    const target = evt.target as HTMLElement | null;
    if (!target) return;
    const sizer = target.closest(`.markdown-preview-sizer.${REVIEW_CLASS}`);
    if (!sizer) return;
    const wrapper = target.closest<HTMLElement>(`[${ATTR_CUE_GROUP}]`);
    if (!wrapper || !sizer.contains(wrapper)) return;
    if (!isRevealTrigger(wrapper.getAttribute(ATTR_SLOT))) return;
    const group = wrapper.getAttribute(ATTR_CUE_GROUP);
    if (!group) return;
    this.toggleGroup(sizer, group);
  }

  /** Reflect the current state onto a sizer the post-processor just rendered,
   *  so a freshly opened Cornell note matches review mode without a re-toggle.
   *  Idempotent across the per-block post-processor calls. */
  syncSizer(sizer: Element): void {
    sizer.classList.toggle(REVIEW_CLASS, this.state.isActive());
  }

  private applyToAllSizers(): void {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view as MarkdownView;
      view.containerEl
        .querySelectorAll(".markdown-preview-sizer")
        .forEach((sizer) =>
          sizer.classList.toggle(REVIEW_CLASS, this.state.isActive())
        );
    });
  }

  /** Reveal or hide every wrapper in `sizer` carrying `group`. The new state is
   *  the inverse of whether the group is currently revealed in THIS view (read
   *  from the DOM, so a single click flips the whole group together), and the
   *  choice is recorded in the model for later re-application. */
  private toggleGroup(sizer: Element, group: string): void {
    const selector = `[${ATTR_CUE_GROUP}="${group}"]`;
    const willReveal = !sizer.querySelector(`${selector}[${ATTR_REVEALED}]`);
    sizer.querySelectorAll<HTMLElement>(selector).forEach((w) => {
      if (willReveal) w.setAttribute(ATTR_REVEALED, "");
      else w.removeAttribute(ATTR_REVEALED);
    });

    const filePath = this.filePathForSizer(sizer);
    if (!filePath) return;
    this.state.setRevealed(filePath, group, willReveal);
  }

  private filePathForSizer(sizer: Element): string | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view.containerEl.contains(sizer)) return view.file?.path ?? null;
    }
    return null;
  }

  /** Strip the revealed attribute from every open view — the DOM half of a
   *  reveal reset; the model half is `state.reset()` / the off-toggle clear. */
  private clearRevealAttributes(): void {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view as MarkdownView;
      view.containerEl
        .querySelectorAll(`[${ATTR_REVEALED}]`)
        .forEach((el) => el.removeAttribute(ATTR_REVEALED));
    });
  }
}
