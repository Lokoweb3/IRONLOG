// ---------------------------------------------------------------------------
//  WORKOUT ROUTES  (all require auth — mounted behind requireAuth in index.js)
// ---------------------------------------------------------------------------
import { Router } from "express";
import {
  listWorkouts,
  listWorkoutsPage,
  countWorkouts,
  upsertWorkout,
  deleteWorkout,
  importWorkouts,
} from "./db.js";
import { workoutSessionSchema, zodMessage } from "./validation.js";

export const workoutsRouter = Router();

// GET /workouts — the user's workouts, newest first.
// Optional ?limit=1..500&offset=0.. returns one page; without a limit the full
// list is returned (the shape the current frontend expects). X-Total-Count
// always carries the user's total so clients can page.
workoutsRouter.get("/", (req, res) => {
  const { limit, offset } = req.query;
  res.set("X-Total-Count", String(countWorkouts(req.user.id)));

  if (limit === undefined) return res.json(listWorkouts(req.user.id));

  const lim = Number(limit);
  if (!Number.isInteger(lim) || lim < 1 || lim > 500) {
    return res.status(400).json({ error: "limit must be an integer between 1 and 500" });
  }
  const off = offset === undefined ? 0 : Number(offset);
  if (!Number.isInteger(off) || off < 0) {
    return res.status(400).json({ error: "offset must be a non-negative integer" });
  }
  res.json(listWorkoutsPage(req.user.id, lim, off));
});

// POST /workouts — create (or update) a finished workout from the request body.
// Body is a session object: { id, dayKey, dayName, focus, tag, startedAt, finishedAt, note, exercises }
workoutsRouter.post("/", (req, res) => {
  const parsed = workoutSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid workout payload — ${zodMessage(parsed.error)}` });
  }
  try {
    const saved = upsertWorkout(req.user.id, parsed.data);
    res.status(201).json({ workout: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /workouts/:id — delete one of the user's workouts (by client id).
workoutsRouter.delete("/:id", (req, res) => {
  const ok = deleteWorkout(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

// POST /workouts/import — bulk upsert for backup restore. Merges, never wipes.
// Accepts either a raw array or { sessions: [...] }. Invalid rows are skipped
// (a half-corrupt backup still restores everything salvageable) rather than
// failing the whole request.
workoutsRouter.post("/import", (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : req.body?.sessions;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: "expected an array of sessions" });
  }
  const valid = [];
  let skipped = 0;
  for (const row of incoming) {
    const parsed = workoutSessionSchema.safeParse(row);
    if (parsed.success) valid.push(parsed.data);
    else skipped++;
  }
  const added = importWorkouts(req.user.id, valid);
  res.json({ added, skipped, total: countWorkouts(req.user.id) });
});
