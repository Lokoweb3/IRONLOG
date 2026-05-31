// ---------------------------------------------------------------------------
//  MEAL ROUTES (require auth) — per-day food log.
// ---------------------------------------------------------------------------
import { Router } from "express";
import {
  listMeals, addMeal, deleteMeal, recentFoods,
  listFavorites, addFavorite, deleteFavorite,
} from "./db.js";

export const mealsRouter = Router();

const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// GET /meals?date=YYYY-MM-DD -> array of entries for that day
mealsRouter.get("/", (req, res) => {
  const day = req.query.date;
  if (!isDay(day)) return res.status(400).json({ error: "date=YYYY-MM-DD required" });
  res.json(listMeals(req.user.id, day));
});

// GET /meals/recent -> recently logged distinct foods (one-tap re-log)
mealsRouter.get("/recent", (req, res) => {
  res.json(recentFoods(req.user.id));
});

// GET /meals/favorites -> the user's saved/starred foods
mealsRouter.get("/favorites", (req, res) => {
  res.json(listFavorites(req.user.id));
});

// POST /meals/favorites -> save a food as a favorite
mealsRouter.post("/favorites", (req, res) => {
  const f = req.body || {};
  if (!f.name) return res.status(400).json({ error: "name required" });
  res.status(201).json({ favorites: addFavorite(req.user.id, f) });
});

// DELETE /meals/favorites/:id -> remove a favorite
mealsRouter.delete("/favorites/:id", (req, res) => {
  const ok = deleteFavorite(req.user.id, Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

// POST /meals -> add a food entry. Body: { day, name, brand?, amount?, calories, protein, carbs, fat }
mealsRouter.post("/", (req, res) => {
  const m = req.body || {};
  if (!isDay(m.day)) return res.status(400).json({ error: "day=YYYY-MM-DD required" });
  if (!m.name) return res.status(400).json({ error: "name required" });
  res.status(201).json({ meal: addMeal(req.user.id, m) });
});

// DELETE /meals/:id -> remove one of the user's entries
mealsRouter.delete("/:id", (req, res) => {
  const ok = deleteMeal(req.user.id, Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});
