// Data-layer unit tests. Run with: npm test
// Uses an in-memory SQLite DB (set before importing db.js).
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";

const db = await import("./db.js");
const { DEFAULT_PROGRAM_DAYS } = await import("./defaultProgram.js");

const mkUser = (n) => db.findOrCreateUser({ sub: `sub-${n}`, email: `${n}@t`, name: `U${n}`, picture: null });

describe("users", () => {
  test("findOrCreateUser is idempotent by google sub and refreshes profile", () => {
    const a = db.findOrCreateUser({ sub: "x", email: "old@t", name: "Old", picture: null });
    const b = db.findOrCreateUser({ sub: "x", email: "new@t", name: "New", picture: "p" });
    assert.equal(a.id, b.id);            // same row
    assert.equal(b.email, "new@t");      // refreshed
    assert.equal(db.getUserById(a.id).name, "New");
  });
});

describe("workouts", () => {
  test("upsert by client id, list newest-first, delete only your own", () => {
    const u = mkUser("w");
    db.upsertWorkout(u.id, { id: "a", dayKey: "d", dayName: "A", tag: "A", startedAt: 100, exercises: [] });
    db.upsertWorkout(u.id, { id: "b", dayKey: "d", dayName: "B", tag: "B", startedAt: 200, exercises: [] });
    db.upsertWorkout(u.id, { id: "a", dayKey: "d", dayName: "A2", tag: "A", startedAt: 100, exercises: [] }); // update, not dup
    const list = db.listWorkouts(u.id);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "b");        // newest first
    assert.equal(list[1].dayName, "A2");  // upserted

    const other = mkUser("w2");
    assert.equal(db.deleteWorkout(other.id, "a"), false); // not theirs
    assert.equal(db.deleteWorkout(u.id, "a"), true);
    assert.equal(db.listWorkouts(u.id).length, 1);
  });

  test("importWorkouts merges (does not wipe) and counts new", () => {
    const u = mkUser("imp");
    db.upsertWorkout(u.id, { id: "keep", dayKey: "d", dayName: "Keep", tag: "K", startedAt: 1, exercises: [] });
    const added = db.importWorkouts(u.id, [
      { id: "keep", dayKey: "d", dayName: "Keep!", tag: "K", startedAt: 1, exercises: [] }, // existing
      { id: "fresh", dayKey: "d", dayName: "Fresh", tag: "F", startedAt: 2, exercises: [] }, // new
    ]);
    assert.equal(added, 1);
    assert.equal(db.listWorkouts(u.id).length, 2);
  });
});

describe("program", () => {
  test("null until set; save/seed default", () => {
    const u = mkUser("p");
    assert.equal(db.getProgram(u.id), null);
    db.saveProgram(u.id, DEFAULT_PROGRAM_DAYS);
    assert.equal(db.getProgram(u.id).length, DEFAULT_PROGRAM_DAYS.length);
  });
});

describe("meals + favorites + weights", () => {
  test("recentFoods dedupes by name+amount", () => {
    const u = mkUser("m");
    db.addMeal(u.id, { day: "2026-05-29", name: "Eggs", amount: "2", calories: 155, protein: 13, carbs: 1, fat: 11 });
    db.addMeal(u.id, { day: "2026-05-30", name: "Eggs", amount: "2", calories: 155, protein: 13, carbs: 1, fat: 11 });
    db.addMeal(u.id, { day: "2026-05-30", name: "Oats", amount: "50 g", calories: 190, protein: 7, carbs: 33, fat: 3 });
    assert.equal(db.listMeals(u.id, "2026-05-30").length, 2);
    assert.equal(db.recentFoods(u.id).length, 2); // Eggs deduped
  });

  test("favorites collapse duplicates (name+amount)", () => {
    const u = mkUser("f");
    db.addFavorite(u.id, { name: "Shake", amount: "1", calories: 120, protein: 24, carbs: 3, fat: 1 });
    db.addFavorite(u.id, { name: "Shake", amount: "1", calories: 130, protein: 25, carbs: 3, fat: 1 }); // upsert
    const favs = db.listFavorites(u.id);
    assert.equal(favs.length, 1);
    assert.equal(favs[0].calories, 130);
  });

  test("weights upsert per day, sorted ascending", () => {
    const u = mkUser("wt");
    db.upsertWeight(u.id, "2026-05-30", 200);
    db.upsertWeight(u.id, "2026-05-28", 202);
    db.upsertWeight(u.id, "2026-05-30", 199); // same day -> update
    const w = db.listWeights(u.id);
    assert.deepEqual(w.map((x) => x.day), ["2026-05-28", "2026-05-30"]);
    assert.equal(w[1].weightLbs, 199);
  });
});

describe("account", () => {
  test("export gathers all; delete cascades", () => {
    const u = mkUser("del");
    db.saveProfile(u.id, { sex: "male", weightLbs: 200, targets: { calories: 2000 } });
    db.saveProgram(u.id, DEFAULT_PROGRAM_DAYS);
    db.upsertWorkout(u.id, { id: "w", dayKey: "d", dayName: "D", tag: "D", startedAt: 1, exercises: [] });
    db.addMeal(u.id, { day: "2026-05-30", name: "X", calories: 1, protein: 0, carbs: 0, fat: 0 });
    db.upsertWeight(u.id, "2026-05-30", 200);
    db.addFavorite(u.id, { name: "F", amount: "1", calories: 1, protein: 0, carbs: 0, fat: 0 });

    const ex = db.exportUserData(u.id);
    assert.ok(ex.profile && ex.program.length && ex.workouts.length && ex.meals.length && ex.weights.length && ex.favorites.length);

    db.deleteUserAccount(u.id);
    assert.equal(db.getUserById(u.id), null);
    assert.equal(db.listWorkouts(u.id).length, 0);
    assert.equal(db.listMeals(u.id, "2026-05-30").length, 0);
    assert.equal(db.listWeights(u.id).length, 0);
    assert.equal(db.listFavorites(u.id).length, 0);
    assert.equal(db.getProgram(u.id), null);
  });
});
