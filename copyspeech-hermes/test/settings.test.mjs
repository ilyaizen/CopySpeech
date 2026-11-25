import assert from "node:assert/strict";
import { SAVED, applyEdit, draftView, pendingEdits, test } from "./harness.mjs";

test("pendingEdits keeps only draft fields that differ from saved", () => {
  assert.deepEqual(pendingEdits(SAVED, { excerpt: false, captions: true }), { excerpt: false });
});

test("pendingEdits drops a draft edit that matches saved again", () => {
  assert.deepEqual(pendingEdits(SAVED, { autoRead: false }), {});
});

test("pendingEdits keeps an unsaved edit when a palette toggle changes another field", () => {
  const draft = { excerpt: false };
  const afterPalette = { ...SAVED, autoRead: true };
  assert.deepEqual(pendingEdits(afterPalette, draft), { excerpt: false });
});

test("pendingEdits drops a draft edit that an outside change made equal", () => {
  assert.deepEqual(pendingEdits({ ...SAVED, autoRead: true }, { autoRead: true }), {});
});

test("draftView shows unsaved edits and saved values for the rest", () => {
  const view = draftView({ ...SAVED, autoRead: true }, { excerpt: false });
  assert.equal(view.excerpt, false);
  assert.equal(view.autoRead, true);
  assert.equal(view.excerptTop, 2);
});

test("regression: edit then revert leaves no draft", () => {
  let draft = applyEdit(SAVED, {}, { autoRead: true });
  draft = applyEdit(SAVED, draft, { autoRead: false });
  assert.deepEqual(draft, {});
});

test("regression: reverted edit does not return after a palette toggle", () => {
  let draft = applyEdit(SAVED, {}, { autoRead: true });
  draft = applyEdit(SAVED, draft, { autoRead: false });
  assert.deepEqual(pendingEdits({ ...SAVED, autoRead: true }, draft), {});
});

test("regression: edit made equal by a saved change is pruned and never returns", () => {
  let draft = applyEdit(SAVED, {}, { autoRead: true });
  draft = pendingEdits({ ...SAVED, autoRead: true }, draft);
  assert.deepEqual(draft, {});
  assert.deepEqual(pendingEdits({ ...SAVED, autoRead: false }, draft), {});
});

test("regression: unsaved edit survives a palette toggle of another field", () => {
  const draft = applyEdit(SAVED, {}, { excerpt: false });
  assert.deepEqual(pendingEdits({ ...SAVED, autoRead: true }, draft), { excerpt: false });
});

test("regression: Save compares with stored settings, so another window's value is not overwritten by an untouched field", () => {
  const stored = { ...SAVED, autoRead: true };
  assert.deepEqual(pendingEdits(stored, { excerpt: false }), { excerpt: false });
});

test("regression: Save writes an edit whose value differs from stored settings", () => {
  const stored = { ...SAVED, excerpt: false };
  assert.deepEqual(pendingEdits(stored, { excerpt: true }), { excerpt: true });
});

test("regression: Save skips an edit already equal to stored settings", () => {
  const stored = { ...SAVED, autoRead: true };
  assert.deepEqual(pendingEdits(stored, { autoRead: true }), {});
});
