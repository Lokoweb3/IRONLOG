// ---------------------------------------------------------------------------
//  WORKOUT ROUTES  (all require auth — mounted behind requireAuth in index.js)
// ---------------------------------------------------------------------------
import { Router } from "express";
import {
  listWorkouts,
  upsertWorkout,
  deleteWorkout,
  importWorkouts,
} from "./db.js";

export const workoutsRouter = Router();

// GET /workouts — all of the user's workouts, newest first.
workoutsRouter.get("/", (req, res) => {
  res.json(listWorkouts(req.user.id));
});

// POST /workouts — create (or update) a finished workout from the request body.
// Body is a session object: { id, dayKey, dayName, focus, tag, startedAt, finishedAt, exercises }
workoutsRouter.post("/", (req, res) => {
  const session = req.body;
  if (!session || !session.id || !Array.isArray(session.exercises)) {
    return res.status(400).json({ error: "invalid workout payload" });
  }
  try {
    const saved = upsertWorkout(req.user.id, session);
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
// Accepts either a raw array or { sessions: [...] }.
workoutsRouter.post("/import", (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : req.body?.sessions;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: "expected an array of sessions" });
  }
  const added = importWorkouts(req.user.id, incoming);
  res.json({ added, total: listWorkouts(req.user.id).length });
});
