// Demo-mode tests: POST /auth/demo creates a seeded throwaway account.
// Hermetic like api.test.js: in-memory DB, known session secret.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.SESSION_SECRET = "test-secret";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.NODE_ENV = "test";

const { app } = await import("./app.js");
const db = await import("./db.js");
const request = (await import("supertest")).default;

// Sign into a fresh demo account; returns { user, cookie }.
async function demoLogin() {
  const r = await request(app).post("/auth/demo").expect(200);
  const cookie = r.headers["set-cookie"].find((c) => c.startsWith("session="));
  assert.ok(cookie, "sets the session cookie");
  return { user: r.body.user, cookie };
}

describe("POST /auth/demo", () => {
  test("creates a signed-in demo user with the demo flag", async () => {
    const { user, cookie } = await demoLogin();
    assert.equal(user.demo, true);
    assert.equal(user.name, "Demo Athlete");
    const me = await request(app).get("/auth/me").set("Cookie", cookie).expect(200);
    assert.equal(me.body.user.demo, true);
  });

  test("google-style users do NOT carry the demo flag", () => {
    const u = db.findOrCreateUser({ sub: "real-google-sub", email: "x@t", name: "X", picture: null });
    assert.equal(u.demo, false);
  });

  test("each call creates a distinct account", async () => {
    const a = await demoLogin();
    const b = await demoLogin();
    assert.notEqual(a.user.id, b.user.id);
  });

  test("skips onboarding: program + profile with targets are seeded", async () => {
    const { cookie } = await demoLogin();
    const prog = await request(app).get("/program").set("Cookie", cookie).expect(200);
    assert.equal(prog.body.onboarded, true);
    assert.equal(prog.body.days.length, 4); // the default 4-day split
    const prof = await request(app).get("/profile").set("Cookie", cookie).expect(200);
    assert.ok(prof.body.profile.targets.calories > 1000);
    assert.ok(prof.body.profile.targets.protein > 0);
  });

  test("seeds ~4 weeks of progressing workout history", async () => {
    const { cookie } = await demoLogin();
    const w = (await request(app).get("/workouts").set("Cookie", cookie).expect(200)).body;
    assert.equal(w.length, 16); // 4/week x 4 weeks
    // newest first, all in the past, and the latest is recent (~yesterday)
    for (let i = 1; i < w.length; i++) assert.ok(w[i - 1].startedAt >= w[i].startedAt);
    assert.ok(w[0].startedAt < Date.now());
    assert.ok(w[0].startedAt > Date.now() - 3 * 86400000);
    // sets look like real UI data: string w/r, done, with rest logged
    const set = w[0].exercises[0].sets[0];
    assert.equal(typeof set.w, "string");
    assert.equal(typeof set.r, "string");
    assert.equal(set.done, true);
    // weights trend up over the month — compare the same program day's
    // first lift between the oldest and newest occurrence
    const sameDay = w.filter((s) => s.dayKey === w[0].dayKey);
    assert.ok(sameDay.length >= 3, "each program day recurs weekly");
    const oldest = Number(sameDay[sameDay.length - 1].exercises[0].sets[0].w);
    const newest = Number(sameDay[0].exercises[0].sets[0].w);
    assert.ok(newest > oldest, `expected progression, got ${oldest} -> ${newest}`);
  });

  test("seeds a month of body weight trending down and meals for today", async () => {
    const { cookie } = await demoLogin();
    const weights = (await request(app).get("/weights").set("Cookie", cookie).expect(200)).body.weights
      ?? (await request(app).get("/weights").set("Cookie", cookie)).body;
    assert.ok(weights.length >= 20, `expected ~a month of entries, got ${weights.length}`);
    assert.ok(weights[weights.length - 1].weightLbs < weights[0].weightLbs, "trend is downward");

    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const meals = (await request(app).get(`/meals?date=${day}`).set("Cookie", cookie).expect(200)).body;
    assert.ok(meals.length >= 3, "today looks logged");
  });

  test("demo sign-in purges demo accounts older than 24h (CASCADE takes their data)", async () => {
    const { user: old } = await demoLogin();
    // backdate the account past the TTL (test-only poke at the raw DB)
    db.default.prepare("UPDATE users SET created_at = ? WHERE id = ?")
      .run(Date.now() - 25 * 60 * 60 * 1000, old.id);

    await demoLogin(); // any demo sign-in triggers the purge
    assert.equal(db.getUserById(old.id), null);
    const orphans = db.default.prepare("SELECT COUNT(*) AS n FROM workouts WHERE user_id = ?").get(old.id);
    assert.equal(orphans.n, 0);
  });

  test("fresh demo accounts survive the purge", async () => {
    const { user } = await demoLogin();
    await demoLogin();
    assert.ok(db.getUserById(user.id), "not purged before 24h");
  });
});
