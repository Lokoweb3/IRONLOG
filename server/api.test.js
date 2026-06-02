// API route tests via supertest. Run with: npm test
// Hermetic: in-memory DB, known session secret, no external network (food
// search routes hit external APIs, so they're intentionally not tested here).
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
const newUser = (n) => db.findOrCreateUser({ sub: `api-${n}`, email: `${n}@t`, name: `U${n}`, picture: null });

describe("health + auth", () => {
  test("GET /api/health -> ok", async () => {
    const r = await request(app).get("/api/health").expect(200);
    assert.equal(r.body.ok, true);
  });
  test("GET /auth/me without cookie -> 401", async () => {
    await request(app).get("/auth/me").expect(401);
  });
  test("GET /auth/me with invalid cookie -> 401", async () => {
    await request(app).get("/auth/me").set("Cookie", "session=garbage").expect(401);
  });
  test("GET /auth/me with valid session -> user", async () => {
    const u = newUser("me");
    const r = await request(app).get("/auth/me").set("Cookie", cookieFor(u.id)).expect(200);
    assert.equal(r.body.user.email, "me@t");
  });
});

describe("protected routes reject anonymous", () => {
  for (const path of ["/workouts", "/program", "/profile", "/meals?date=2026-05-30", "/weights"]) {
    test(`GET ${path} -> 401`, async () => {
      await request(app).get(path).expect(401);
    });
  }
});

describe("workouts", () => {
  test("create -> list -> delete", async () => {
    const c = cookieFor(newUser("wo").id);
    const session = { id: "w1", dayKey: "d", dayName: "Day", focus: "", tag: "D", startedAt: 1, finishedAt: 2, exercises: [] };
    await request(app).post("/workouts").set("Cookie", c).send(session).expect(201);
    const list = await request(app).get("/workouts").set("Cookie", c).expect(200);
    assert.equal(list.body.length, 1);
    await request(app).delete("/workouts/w1").set("Cookie", c).expect(200);
    assert.equal((await request(app).get("/workouts").set("Cookie", c)).body.length, 0);
  });
  test("invalid payload -> 400", async () => {
    const c = cookieFor(newUser("wo2").id);
    await request(app).post("/workouts").set("Cookie", c).send({ nope: true }).expect(400);
  });
  test("re-saving an edited workout updates in place (no duplicate)", async () => {
    const c = cookieFor(newUser("wo3").id);
    const base = { id: "e1", dayKey: "d", dayName: "Push", tag: "P", startedAt: 1, finishedAt: 2, exercises: [{ key: "k", name: "Bench", sets: [{ w: "100", r: "5", done: true }] }] };
    await request(app).post("/workouts").set("Cookie", c).send(base).expect(201);
    // edit: fix the weight, keep the same id
    const edited = { ...base, exercises: [{ key: "k", name: "Bench", sets: [{ w: "135", r: "5", done: true }] }] };
    await request(app).post("/workouts").set("Cookie", c).send(edited).expect(201);
    const list = (await request(app).get("/workouts").set("Cookie", c)).body;
    assert.equal(list.length, 1); // still one row
    assert.equal(list[0].exercises[0].sets[0].w, "135"); // updated value
  });
  test("cannot delete another user's workout", async () => {
    const a = cookieFor(newUser("wa").id);
    const b = cookieFor(newUser("wb").id);
    await request(app).post("/workouts").set("Cookie", a).send({ id: "x", dayKey: "d", exercises: [] }).expect(201);
    await request(app).delete("/workouts/x").set("Cookie", b).expect(404);
  });
});

describe("program onboarding", () => {
  test("new user not onboarded; reset seeds default; then onboarded", async () => {
    const c = cookieFor(newUser("pr").id);
    const g = await request(app).get("/program").set("Cookie", c).expect(200);
    assert.equal(g.body.onboarded, false);
    assert.equal(g.body.days.length, 0);
    const r = await request(app).post("/program/reset").set("Cookie", c).expect(200);
    assert.ok(r.body.days.length >= 1);
    const g2 = await request(app).get("/program").set("Cookie", c).expect(200);
    assert.equal(g2.body.onboarded, true);
  });
  test("PUT saves a custom program", async () => {
    const c = cookieFor(newUser("pr2").id);
    const days = [{ key: "k", name: "Leg Day", focus: "", tag: "LEG", color: "#fff", exercises: [] }];
    const r = await request(app).put("/program").set("Cookie", c).send({ days }).expect(200);
    assert.equal(r.body.days[0].name, "Leg Day");
  });
  test("DELETE /program restarts onboarding (onboarded back to false)", async () => {
    const c = cookieFor(newUser("pr3").id);
    await request(app).post("/program/reset").set("Cookie", c).expect(200);
    assert.equal((await request(app).get("/program").set("Cookie", c)).body.onboarded, true);
    await request(app).delete("/program").set("Cookie", c).expect(200);
    assert.equal((await request(app).get("/program").set("Cookie", c)).body.onboarded, false);
  });
});

describe("profile + weights", () => {
  test("profile null then saved", async () => {
    const c = cookieFor(newUser("pf").id);
    assert.equal((await request(app).get("/profile").set("Cookie", c)).body.profile, null);
    const r = await request(app).put("/profile").set("Cookie", c)
      .send({ sex: "male", weightLbs: 200, targets: { calories: 2000 } }).expect(200);
    assert.equal(r.body.profile.weightLbs, 200);
  });
  test("weights upsert + validation", async () => {
    const c = cookieFor(newUser("wt").id);
    await request(app).post("/weights").set("Cookie", c).send({ day: "2026-05-30", weightLbs: 200 }).expect(201);
    const r = await request(app).post("/weights").set("Cookie", c).send({ day: "2026-05-30", weightLbs: 199 }).expect(201);
    assert.equal(r.body.weights.length, 1);
    assert.equal(r.body.weights[0].weightLbs, 199);
    await request(app).post("/weights").set("Cookie", c).send({ day: "bad", weightLbs: 1 }).expect(400);
    await request(app).post("/weights").set("Cookie", c).send({ day: "2026-05-30", weightLbs: 0 }).expect(400);
  });
});

describe("meals + favorites", () => {
  test("add/list/delete + recent + favorite", async () => {
    const c = cookieFor(newUser("ml").id);
    const day = "2026-05-30";
    const post = await request(app).post("/meals").set("Cookie", c)
      .send({ day, name: "Eggs", calories: 155, protein: 13, carbs: 1, fat: 11 }).expect(201);
    assert.equal((await request(app).get(`/meals?date=${day}`).set("Cookie", c)).body.length, 1);
    assert.equal((await request(app).get("/meals/recent").set("Cookie", c)).body.length, 1);

    await request(app).post("/meals/favorites").set("Cookie", c)
      .send({ name: "Eggs", amount: "2", calories: 155, protein: 13, carbs: 1, fat: 11 }).expect(201);
    const favs = await request(app).get("/meals/favorites").set("Cookie", c).expect(200);
    assert.equal(favs.body.length, 1);

    await request(app).delete(`/meals/${post.body.meal.id}`).set("Cookie", c).expect(200);
    assert.equal((await request(app).get(`/meals?date=${day}`).set("Cookie", c)).body.length, 0);
  });
  test("missing date -> 400", async () => {
    const c = cookieFor(newUser("ml2").id);
    await request(app).get("/meals").set("Cookie", c).expect(400);
  });
});

describe("meal slots, edit, copy, recipes", () => {
  test("slot stored; edit updates macros", async () => {
    const c = cookieFor(newUser("ms").id);
    const day = "2026-05-30";
    const post = await request(app).post("/meals").set("Cookie", c)
      .send({ day, slot: "breakfast", name: "Oats", grams: 50, amount: "50 g", calories: 190, protein: 6, carbs: 33, fat: 3 }).expect(201);
    assert.equal(post.body.meal.slot, "breakfast");
    const upd = await request(app).put(`/meals/${post.body.meal.id}`).set("Cookie", c)
      .send({ amount: "100 g", grams: 100, calories: 380, protein: 13, carbs: 67, fat: 7 }).expect(200);
    assert.equal(upd.body.meal.calories, 380);
    assert.equal(upd.body.meal.slot, "breakfast"); // unchanged
  });
  test("copy a day's entries to another day", async () => {
    const c = cookieFor(newUser("cp").id);
    await request(app).post("/meals").set("Cookie", c).send({ day: "2026-05-01", slot: "lunch", name: "X", calories: 100 }).expect(201);
    const r = await request(app).post("/meals/copy").set("Cookie", c).send({ from: "2026-05-01", to: "2026-05-02" }).expect(200);
    assert.equal(r.body.copied, 1);
    const tgt = (await request(app).get("/meals?date=2026-05-02").set("Cookie", c)).body;
    assert.equal(tgt.length, 1);
    assert.equal(tgt[0].slot, "lunch");
  });
  test("save a recipe and bulk-log it", async () => {
    const c = cookieFor(newUser("rc").id);
    const rec = await request(app).post("/meals/recipes").set("Cookie", c)
      .send({ name: "My Breakfast", items: [{ name: "Eggs", calories: 155, protein: 13, carbs: 1, fat: 11 }, { name: "Oats", calories: 190, protein: 7, carbs: 33, fat: 3 }] }).expect(201);
    assert.equal(rec.body.recipes[0].items.length, 2);
    const bulk = await request(app).post("/meals/bulk").set("Cookie", c)
      .send({ day: "2026-06-01", items: rec.body.recipes[0].items.map((it) => ({ ...it, slot: "breakfast" })) }).expect(201);
    assert.equal(bulk.body.length, 2);
    assert.equal(bulk.body[0].slot, "breakfast");
  });
});

describe("activity (calories burned)", () => {
  test("null until logged; upsert overwrites; clear removes; validation", async () => {
    const c = cookieFor(newUser("act").id);
    const day = "2026-05-30";
    assert.equal((await request(app).get(`/activity?date=${day}`).set("Cookie", c)).body.activity, null);

    const p = await request(app).post("/activity").set("Cookie", c).send({ day, calories: 450, source: "manual" }).expect(201);
    assert.equal(p.body.activity.calories, 450);
    assert.equal(p.body.activity.source, "manual");

    const p2 = await request(app).post("/activity").set("Cookie", c).send({ day, calories: 500, source: "estimate" }).expect(201);
    assert.equal(p2.body.activity.calories, 500);
    assert.equal((await request(app).get(`/activity?date=${day}`).set("Cookie", c)).body.activity.calories, 500);

    await request(app).delete(`/activity?date=${day}`).set("Cookie", c).expect(200);
    assert.equal((await request(app).get(`/activity?date=${day}`).set("Cookie", c)).body.activity, null);

    await request(app).post("/activity").set("Cookie", c).send({ day: "bad", calories: 1 }).expect(400);
    await request(app).post("/activity").set("Cookie", c).send({ day, calories: -5 }).expect(400);
    await request(app).get("/activity").set("Cookie", c).expect(400); // missing date
  });
  test("requires auth", async () => {
    await request(app).get("/activity?date=2026-05-30").expect(401);
  });
});

describe("account export + delete", () => {
  test("export returns bundle; delete cascades and kills session", async () => {
    const u = newUser("acc");
    const c = cookieFor(u.id);
    await request(app).post("/weights").set("Cookie", c).send({ day: "2026-05-30", weightLbs: 200 }).expect(201);
    await request(app).post("/activity").set("Cookie", c).send({ day: "2026-05-30", calories: 300 }).expect(201);
    const ex = await request(app).get("/auth/export").set("Cookie", c).expect(200);
    assert.equal(ex.body.app, "IRONLOG");
    assert.equal(ex.body.weights.length, 1);
    assert.equal(ex.body.activity.length, 1);
    await request(app).delete("/auth/account").set("Cookie", c).expect(200);
    await request(app).get("/auth/me").set("Cookie", c).expect(401); // user is gone
  });
});
