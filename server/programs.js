// ---------------------------------------------------------------------------
//  PROGRAM ROUTES  (require auth) — each user's editable training program.
//  A new user is seeded with the default 4-day split on first GET.
// ---------------------------------------------------------------------------
import { Router } from "express";
import { getProgram, saveProgram, clearProgram } from "./db.js";
import { DEFAULT_PROGRAM_DAYS } from "./defaultProgram.js";

export const programsRouter = Router();

// GET /program -> { days, onboarded }. Does NOT auto-seed: a brand-new user has
// no program yet (onboarded:false) so the client can show the choice screen.
programsRouter.get("/", (req, res) => {
  const days = getProgram(req.user.id);
  res.json({ days: days || [], onboarded: days !== null });
});

// PUT /program -> save the user's program. Body: { days } or a raw array.
programsRouter.put("/", (req, res) => {
  const days = Array.isArray(req.body) ? req.body : req.body?.days;
  if (!Array.isArray(days)) {
    return res.status(400).json({ error: "expected { days: [...] }" });
  }
  res.json({ days: saveProgram(req.user.id, days) });
});

// POST /program/reset -> restore the default program.
programsRouter.post("/reset", (req, res) => {
  res.json({ days: saveProgram(req.user.id, DEFAULT_PROGRAM_DAYS) });
});

// DELETE /program -> clear the program so the user re-runs onboarding.
programsRouter.delete("/", (req, res) => {
  clearProgram(req.user.id);
  res.json({ ok: true });
});
