// ---------------------------------------------------------------------------
//  PROFILE ROUTES (require auth) — body stats, goal, and macro targets.
//  Targets are computed on the client (pure formula) and stored here so every
//  device sees the same numbers and manual overrides persist.
// ---------------------------------------------------------------------------
import { Router } from "express";
import { getProfile, saveProfile } from "./db.js";

export const profileRouter = Router();

// GET /profile -> { profile } (null if not set up yet)
profileRouter.get("/", (req, res) => {
  res.json({ profile: getProfile(req.user.id) });
});

// PUT /profile -> save the profile object, returns { profile }
profileRouter.put("/", (req, res) => {
  const p = req.body && typeof req.body === "object" ? req.body : null;
  if (!p) return res.status(400).json({ error: "expected a profile object" });
  res.json({ profile: saveProfile(req.user.id, p) });
});
