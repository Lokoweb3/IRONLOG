// Validation + pagination tests for the workout routes. Run with: npm test
// Hermetic like api.test.js: in-memory DB, known session secret.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.SESSION_SECRET = "test-secret";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.NODE_ENV = "test";

const { app } = await import("./app.js");
const db = await import("./db.js");
const jwt = (await import("jsonwebtoken")).default;
const request = (await import("supertest")).default;

const cookieFor = (uid) => `session=${jwt.sign({ uid }, "test-secret")}`;
const newUser = (n) => db.findOrCreateUser({ sub: `wk-${n}`, email: `${n}@t`, name: `U${n}`, picture: null });

const session = (id, extra = {}) => ({
  id,
  dayKey: "lower1", dayName: "Lower Body — Day 1", focus: "Glutes & Quads", tag: "LB1",
  startedAt: 1000, finishedAt: 2000, note: "",
  exercises: [{ key: "k1", name: "Squat", variation: "Barbell", variations: ["Barbell"], note: "",
    sets: [{ w: "225", r: "5", done: true, doneAt: 1500, restBefore: 90 }] }],
  ...extra,
});

describe("POST /workouts validation", () => {
  test("accepts the exact frontend shape (strings for w/r)", async () => {
    const c = cookieFor(newUser("v1").id);
    const r = await request(app).post("/workouts").set("Cookie", c).send(session("s1")).expect(201);
    assert.equal(r.body.workout.exercises[0].sets[0].w, "225");
    assert.equal(r.body.workout.exercises[0].sets[0].restBefore, 90);
  });
  test("accepts numbers for w/r and a numeric id (coerced to string)", async () => {
    const c = cookieFor(newUser("v2").id);
    const s = session(123, { exercises: [{ name: "Bench", sets: [{ w: 135, r: 8 }] }] });
    const r = await request(app).post("/workouts").set("Cookie", c).send(s).expect(201);
    assert.equal(r.body.workout.id, "123");
    assert.equal(r.body.workout.exercises[0].sets[0].w, 135);
  });
  test("strips unknown keys from the stored payload", async () => {
    const c = cookieFor(newUser("v3").id);
    const s = session("s3", { evil: "x" });
    s.exercises[0].injected = "y";
    s.exercises[0].sets[0].payload = "z";
    await request(app).post("/workouts").set("Cookie", c).send(s).expect(201);
    const got = (await request(app).get("/workouts").set("Cookie", c)).body[0];
    assert.equal(got.evil, undefined);
    assert.equal(got.exercises[0].injected, undefined);
    assert.equal(got.exercises[0].sets[0].payload, undefined);
  });
  test("rejects garbage with a useful message", async () => {
    const c = cookieFor(newUser("v4").id);
    const r1 = await request(app).post("/workouts").set("Cookie", c).send({ nope: true }).expect(400);
    assert.match(r1.body.error, /invalid workout payload/);
    assert.match(r1.body.error, /id/); // names the failing field
    const r2 = await request(app).post("/workouts").set("Cookie", c)
      .send(session("s4", { exercises: [{ name: "X", sets: "not-an-array" }] })).expect(400);
    assert.match(r2.body.error, /exercises\.0\.sets/);
  });
  test("rejects a missing/empty id and out-of-bound sizes", async () => {
    const c = cookieFor(newUser("v5").id);
    await request(app).post("/workouts").set("Cookie", c).send(session("  ")).expect(400);
    await request(app).post("/workouts").set("Cookie", c)
      .send(session("s5", { note: "x".repeat(1001) })).expect(400);
    const tooMany = session("s6", {
      exercises: Array.from({ length: 51 }, (_, i) => ({ name: `E${i}`, sets: [] })),
    });
    await request(app).post("/workouts").set("Cookie", c).send(tooMany).expect(400);
  });
});

describe("POST /workouts/import validation", () => {
  test("skips invalid rows instead of failing; reports added/skipped/total", async () => {
    const c = cookieFor(newUser("i1").id);
    const rows = [
      session("ok1"),
      { garbage: true },                                   // no id/exercises -> skipped
      session("ok2", { exercises: [] }),
      { id: "bad", exercises: "nope" },                    // exercises not an array -> skipped
    ];
    const r = await request(app).post("/workouts/import").set("Cookie", c).send({ sessions: rows }).expect(200);
    assert.equal(r.body.added, 2);
    assert.equal(r.body.skipped, 2);
    assert.equal(r.body.total, 2);
  });
  test("re-import merges by id (no duplicates), still counts skips", async () => {
    const c = cookieFor(newUser("i2").id);
    await request(app).post("/workouts/import").set("Cookie", c).send([session("a")]).expect(200);
    const r = await request(app).post("/workouts/import").set("Cookie", c)
      .send([session("a"), session("b"), 42]).expect(200);
    assert.equal(r.body.added, 1);   // only "b" is new
    assert.equal(r.body.skipped, 1); // 42 is not a session
    assert.equal(r.body.total, 2);
  });
  test("non-array body -> 400", async () => {
    const c = cookieFor(newUser("i3").id);
    await request(app).post("/workouts/import").set("Cookie", c).send({ sessions: "x" }).expect(400);
  });
});

describe("GET /workouts pagination", () => {
  const seed = async (c, n) => {
    for (let i = 1; i <= n; i++) {
      await request(app).post("/workouts").set("Cookie", c)
        .send(session(`w${i}`, { startedAt: i * 1000 })).expect(201);
    }
  };
  test("limit/offset page newest-first with X-Total-Count", async () => {
    const c = cookieFor(newUser("p1").id);
    await seed(c, 5);
    const page = await request(app).get("/workouts?limit=2").set("Cookie", c).expect(200);
    assert.equal(page.headers["x-total-count"], "5");
    assert.deepEqual(page.body.map((s) => s.id), ["w5", "w4"]);
    const page2 = await request(app).get("/workouts?limit=2&offset=2").set("Cookie", c).expect(200);
    assert.deepEqual(page2.body.map((s) => s.id), ["w3", "w2"]);
    const tail = await request(app).get("/workouts?limit=500&offset=4").set("Cookie", c).expect(200);
    assert.deepEqual(tail.body.map((s) => s.id), ["w1"]);
  });
  test("no limit -> the full list exactly as before (plus the count header)", async () => {
    const c = cookieFor(newUser("p2").id);
    await seed(c, 3);
    const r = await request(app).get("/workouts").set("Cookie", c).expect(200);
    assert.equal(r.body.length, 3);
    assert.equal(r.headers["x-total-count"], "3");
    assert.deepEqual(r.body.map((s) => s.id), ["w3", "w2", "w1"]);
  });
  test("bad limit/offset -> 400", async () => {
    const c = cookieFor(newUser("p3").id);
    for (const q of ["limit=0", "limit=501", "limit=abc", "limit=2.5", "limit=10&offset=-1", "limit=10&offset=x"]) {
      await request(app).get(`/workouts?${q}`).set("Cookie", c).expect(400);
    }
  });
});
