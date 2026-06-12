// Pure review-mode state — no Obsidian, no DOM (the same discipline as
// classifier.ts and exportMap.ts, and it bundles for the Node test runner the
// same way).
//
// Owns the decisions of review mode: whether the mode is on, and which reveal
// groups are revealed per file. ReviewModeController (reviewMode.ts) is the
// thin adapter that reflects these decisions onto sizers and wrappers.

/** Only cues and the summary are reveal triggers — clicking inside already-
 *  revealed body text (e.g. a link) must behave normally, not re-blur. */
export function isRevealTrigger(role: string | null): boolean {
  return role === "cue" || role === "summary";
}

/** The global on/off flag plus the per-file reveal memory. Ephemeral by
 *  design: it lives in the plugin instance, never in settings, so a reload
 *  starts a fresh study session (off, fully blurred). */
export class ReviewState {
  private active = false;
  /** Per-file set of currently-revealed group keys, kept so reveals survive
   *  Reading-view re-renders (the controller re-applies them per wrapper). */
  private readonly revealed = new Map<string, Set<string>>();

  isActive(): boolean {
    return this.active;
  }

  /** Flip review mode and return the new state. Turning OFF clears every
   *  reveal, so the next time the mode turns on the note starts fully
   *  blurred — a fresh recall session. */
  toggle(): boolean {
    this.active = !this.active;
    if (!this.active) this.revealed.clear();
    return this.active;
  }

  /** Re-blur everything without leaving review mode (the "reset" command). */
  reset(): void {
    this.revealed.clear();
  }

  isRevealed(filePath: string, group: string): boolean {
    return this.revealed.get(filePath)?.has(group) ?? false;
  }

  /** Record a reveal (or re-hide) of one group in one file. Groups toggle
   *  independently; files never share reveals. */
  setRevealed(filePath: string, group: string, revealed: boolean): void {
    const set = this.revealed.get(filePath) ?? new Set<string>();
    if (revealed) set.add(group);
    else set.delete(group);
    this.revealed.set(filePath, set);
  }
}
