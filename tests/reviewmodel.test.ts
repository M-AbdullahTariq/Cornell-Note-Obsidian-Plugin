// Review-model tests: the pure reveal-state semantics (reviewModel.ts) that
// drive review mode — on/off, per-file reveal memory, resets. External
// behaviour only, through the model's public interface.
import test from "node:test";
import assert from "node:assert/strict";
import { isRevealTrigger, ReviewState } from "../reviewModel";

test("a fresh session starts off and fully blurred", () => {
  const state = new ReviewState();
  assert.equal(state.isActive(), false);
  assert.equal(state.isRevealed("a.md", "cue:0"), false);
});

test("toggle flips the mode and reports the new state", () => {
  const state = new ReviewState();
  assert.equal(state.toggle(), true);
  assert.equal(state.isActive(), true);
  assert.equal(state.toggle(), false);
  assert.equal(state.isActive(), false);
});

test("reveals accumulate and toggle independently per group", () => {
  const state = new ReviewState();
  state.toggle();
  state.setRevealed("a.md", "cue:0", true);
  state.setRevealed("a.md", "summary:0", true);
  assert.equal(state.isRevealed("a.md", "cue:0"), true);
  assert.equal(state.isRevealed("a.md", "summary:0"), true);
  state.setRevealed("a.md", "cue:0", false);
  assert.equal(state.isRevealed("a.md", "cue:0"), false);
  assert.equal(state.isRevealed("a.md", "summary:0"), true);
});

test("files never share reveals", () => {
  const state = new ReviewState();
  state.toggle();
  state.setRevealed("a.md", "cue:0", true);
  assert.equal(state.isRevealed("b.md", "cue:0"), false);
});

test("turning the mode off wipes every reveal for a fresh next session", () => {
  const state = new ReviewState();
  state.toggle();
  state.setRevealed("a.md", "cue:0", true);
  state.setRevealed("b.md", "cue:1", true);
  state.toggle(); // off
  state.toggle(); // on again
  assert.equal(state.isRevealed("a.md", "cue:0"), false);
  assert.equal(state.isRevealed("b.md", "cue:1"), false);
});

test("reset re-blurs everything without leaving the mode", () => {
  const state = new ReviewState();
  state.toggle();
  state.setRevealed("a.md", "cue:0", true);
  state.reset();
  assert.equal(state.isActive(), true);
  assert.equal(state.isRevealed("a.md", "cue:0"), false);
});

test("only cues and summaries are reveal triggers", () => {
  assert.equal(isRevealTrigger("cue"), true);
  assert.equal(isRevealTrigger("summary"), true);
  assert.equal(isRevealTrigger("body"), false);
  assert.equal(isRevealTrigger("title"), false);
  assert.equal(isRevealTrigger("heading"), false);
  assert.equal(isRevealTrigger(null), false);
});
