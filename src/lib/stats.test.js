// Unit tests for the pure training-math library. Run with: npm test
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { e1rm, bestSetE1rm, historicalBestE1rm, calcPlates } from "./stats.js";

describe("e1rm (Epley)", () => {
  test("computes W * (1 + R/30)", () => {
    assert.equal(e1rm(100, 0), 0);        // no reps -> no estimate
    assert.equal(e1rm(100, 30), 200);
    assert.equal(e1rm(200, 5), 200 * (1 + 5 / 30));
  });
  test("accepts the string values the inputs produce", () => {
    assert.equal(e1rm("135", "10"), 135 * (1 + 10 / 30));
    assert.equal(e1rm("", ""), 0);
    assert.equal(e1rm("abc", "5"), 0);
  });
});

describe("bestSetE1rm", () => {
  test("picks the strongest set", () => {
    const sets = [
      { w: "100", r: "10" },   // 133.3
      { w: "120", r: "3" },    // 132
      { w: "", r: "" },        // 0
    ];
    assert.equal(Math.round(bestSetE1rm(sets)), 133);
  });
  test("empty sets -> 0", () => {
    assert.equal(bestSetE1rm([]), 0);
  });
});

describe("historicalBestE1rm", () => {
  const sessions = [
    { id: "a", exercises: [{ name: "Bench", variation: "Barbell", sets: [{ w: 100, r: 5 }] }] },      // 116.7
    { id: "b", exercises: [{ name: "Bench", variation: "Dumbbell", sets: [{ w: 90, r: 12 }] }] },     // 126
    { id: "c", exercises: [{ name: "Squat", variation: null, sets: [{ w: 225, r: 5 }] }] },
  ];
  test("filters by exercise name", () => {
    assert.equal(historicalBestE1rm(sessions, "Deadlift"), 0);
    assert.equal(Math.round(historicalBestE1rm(sessions, "Squat")), 263);
  });
  test("variation-specific when a variation is given, across all when null", () => {
    assert.equal(Math.round(historicalBestE1rm(sessions, "Bench", "Barbell")), 117);
    assert.equal(Math.round(historicalBestE1rm(sessions, "Bench", null)), 126); // both variations
  });
  test("excludes the session being edited", () => {
    assert.equal(historicalBestE1rm(sessions, "Bench", "Dumbbell", "b"), 0);
  });
});

describe("calcPlates", () => {
  test("exact load: 225 = 45 bar + 2x90", () => {
    const r = calcPlates(225);
    assert.deepEqual(r.perSide, [45, 45]);
    assert.equal(r.loaded, 225);
    assert.equal(r.remainder, 0);
  });
  test("mixed plates: 190 = 45 bar + 2x(45+25+2.5)", () => {
    const r = calcPlates(190);
    assert.deepEqual(r.perSide, [45, 25, 2.5]);
    assert.equal(r.loaded, 190);
    assert.equal(r.remainder, 0);
  });
  test("half-loadable target lands on the closest weight below", () => {
    const r = calcPlates(187.5); // per side 71.25 -> 45+25, leaves 1.25 unloadable
    assert.deepEqual(r.perSide, [45, 25]);
    assert.equal(r.loaded, 185);
    assert.equal(r.remainder, 2.5);
  });
  test("empty bar", () => {
    const r = calcPlates(45);
    assert.deepEqual(r.perSide, []);
    assert.equal(r.loaded, 45);
    assert.equal(r.remainder, 0);
  });
  test("target below the bar reports a negative remainder", () => {
    const r = calcPlates(30);
    assert.deepEqual(r.perSide, []);
    assert.equal(r.loaded, 45);
    assert.equal(r.remainder, -15);
  });
  test("unreachable target reports the remainder", () => {
    const r = calcPlates(226); // closest is 225 (smallest step is 2x2.5 = 5)
    assert.deepEqual(r.perSide, [45, 45]);
    assert.equal(r.loaded, 225);
    assert.equal(r.remainder, 1);
  });
  test("custom bar weight", () => {
    const r = calcPlates(95, 35);
    assert.deepEqual(r.perSide, [25, 5]);
    assert.equal(r.loaded, 95);
    assert.equal(r.remainder, 0);
  });
  test("custom plate set", () => {
    const r = calcPlates(105, 45, [20, 10, 5]);
    assert.deepEqual(r.perSide, [20, 10]);
    assert.equal(r.loaded, 105);
    assert.equal(r.remainder, 0);
  });
  test("zero / garbage target", () => {
    assert.deepEqual(calcPlates(0).perSide, []);
    assert.deepEqual(calcPlates("abc").perSide, []);
  });
});
