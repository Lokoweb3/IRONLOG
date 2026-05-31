// ---------------------------------------------------------------------------
//  ACTIVITY ROUTES (require auth) — per-day active calories burned.
//  Manually entered (read off a watch) or estimated from a logged workout.
//  Feeds the "net calories" budget on the Meals view.
// ---------------------------------------------------------------------------
import { Router } from "express";
import { getActivity, upsertActivity, deleteActivity } from "./db.js";

export const activityRouter = Router();

const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// GET /activity?date=YYYY-MM-DD -> { activity } (null if nothing logged)
activityRouter.get("/", (req, res) => {
  const day = req.query.date;
  if (!isDay(day)) return res.status(400).json({ error: "date=YYYY-MM-DD required" });
  res.json({ activity: getActivity(req.user.id, day) });
});

// POST /activity -> upsert a day's burned calories. Body: { day, calories, source? }
activityRouter.post("/", (req, res) => {
  const { day, calories, source } = req.body || {};
  if (!isDay(day)) return res.status(400).json({ error: "day=YYYY-MM-DD required" });
  const c = Number(calories);
  if (!Number.isFinite(c) || c < 0) return res.status(400).json({ error: "calories must be a non-negative number" });
  res.status(201).json({ activity: upsertActivity(req.user.id, day, c, source) });
});

// DELETE /activity?date=YYYY-MM-DD -> clear that day's entry
activityRouter.delete("/", (req, res) => {
  const day = req.query.date;
  if (!isDay(day)) return res.status(400).json({ error: "date=YYYY-MM-DD required" });
  deleteActivity(req.user.id, day);
  res.json({ ok: true });
});
