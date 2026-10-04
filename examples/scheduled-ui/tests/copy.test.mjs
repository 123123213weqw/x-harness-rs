import test from "node:test";
import assert from "node:assert/strict";
import { copy, templates } from "../src/copy.mjs";
import { makeDraft, validateDraft } from "../src/model.mjs";

test("both languages cover the same labels and validation errors", () => {
  assert.deepEqual(Object.keys(copy.zh).sort(), Object.keys(copy.en).sort());
  assert.deepEqual(
    Object.keys(copy.zh.errors).sort(),
    Object.keys(copy.en.errors).sort(),
  );
  for (const t of Object.values(copy)) {
    assert.equal(t.weekdays.length, 7);
    for (const key of ["everyN", "worked", "deleteHelp"]) {
      assert.equal(typeof t[key], "function");
      assert.equal(typeof t[key]("sample"), "string");
    }
    for (const key of [
      "previewLabel",
      "confirmNote",
      "offlineNote",
      "resultNote",
    ]) {
      assert.ok(t[key].trim(), `Missing preview disclosure: ${key}`);
    }
  }
});

test("each localized template opens a valid illustrative draft", () => {
  for (const items of Object.values(templates)) {
    assert.equal(items.length, 6);
    assert.equal(new Set(items.map((item) => item.title)).size, items.length);
    for (const item of items) {
      assert.ok(item.description.trim());
      assert.equal(validateDraft(makeDraft(item)), null);
    }
  }
});

test("localized template pairs preserve scheduling and workspace defaults", () => {
  for (const [index, zh] of templates.zh.entries()) {
    const en = templates.en[index];
    for (const key of ["kind", "minutes", "workspace"]) {
      assert.equal(makeDraft(zh)[key], makeDraft(en)[key]);
    }
  }
});
