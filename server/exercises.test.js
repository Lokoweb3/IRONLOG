// Exercise-guide matcher tests. Run with: npm test
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { lookup } = await import("./exercises.js");

describe("exercise guide lookup", () => {
  test("curated default exercises resolve to the right guide", () => {
    assert.equal(lookup("Standard Squats").name, "Barbell Squat");
    assert.equal(lookup("RDL").name, "Romanian Deadlift");
    assert.equal(lookup("Close Grip Row").name, "Seated Cable Rows");
    assert.equal(lookup("Flat Press", "Dumbbell").name, "Dumbbell Bench Press");
  });

  test("a row never resolves to a press (movement guard)", () => {
    const m = lookup("Overhand Wide Grip Row");
    assert.ok(m && /row/i.test(m.name), `expected a row, got ${m && m.name}`);
  });

  test("returns step instructions and https image urls", () => {
    const m = lookup("Hammer Curls");
    assert.ok(m.instructions.length > 0);
    assert.ok(m.images.length > 0 && m.images.every((u) => u.startsWith("https://")));
  });

  test("nonsense / unmatched names return null (client falls back to video)", () => {
    assert.equal(lookup("Banana Smoothie Lift"), null);
    assert.equal(lookup(""), null);
  });
});
