// ---------------------------------------------------------------------------
//  WEIGHT ROUTES (require auth) — body-weight log for the trend chart.
// ---------------------------------------------------------------------------
import { Router } from "express";
import { listWeights, upsertWeight, deleteWeight } from "./db.js";

export const weightsRouter = Router();

const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// GET /weights -> all logged weights (oldest first), e.g. [{ id, day, weightLbs }]
weightsRouter.get("/", (req, res) => {
  res.json(listWeights(req.user.id));
});

// POST /weights -> upsert one day's weight. Body: { day, weightLbs }
weightsRouter.post("/", (req, res) => {
  const { day, weightLbs } = req.body || {};
  if (!isDay(day)) return res.status(400).json({ error: "day=YYYY-MM-DD required" });
  const w = Number(weightLbs);
  if (!w || w <= 0) return res.status(400).json({ error: "weightLbs must be a positive number" });
  res.status(201).json({ weights: upsertWeight(req.user.id, day, w) });
});

// DELETE /weights/:id -> remove one entry
weightsRouter.delete("/:id", (req, res) => {
  const ok = deleteWeight(req.user.id, Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});
