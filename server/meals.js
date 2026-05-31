// ---------------------------------------------------------------------------
//  MEAL ROUTES (require auth) — per-day food log.
// ---------------------------------------------------------------------------
import { Router } from "express";
import {
  listMeals, addMeal, updateMeal, deleteMeal, bulkAddMeals, copyDayMeals, recentFoods,
  listFavorites, addFavorite, deleteFavorite,
  listRecipes, addRecipe, deleteRecipe,
} from "./db.js";

export const mealsRouter = Router();

const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// GET /meals?date=YYYY-MM-DD -> array of entries for that day
mealsRouter.get("/", (req, res) => {
  const day = req.query.date;
  if (!isDay(day)) return res.status(400).json({ error: "date=YYYY-MM-DD required" });
  res.json(listMeals(req.user.id, day));
});

// POST /meals/bulk -> add many entries at once { day, items:[...] }
mealsRouter.post("/bulk", (req, res) => {
  const { day, items } = req.body || {};
  if (!isDay(day)) return res.status(400).json({ error: "day=YYYY-MM-DD required" });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "items required" });
  bulkAddMeals(req.user.id, items.map((it) => ({ ...it, day })));
  res.status(201).json(listMeals(req.user.id, day));
});

// POST /meals/copy -> copy all of one day's entries to another { from, to }
mealsRouter.post("/copy", (req, res) => {
  const { from, to } = req.body || {};
  if (!isDay(from) || !isDay(to)) return res.status(400).json({ error: "from & to (YYYY-MM-DD) required" });
  const copied = copyDayMeals(req.user.id, from, to);
  res.json({ copied, meals: listMeals(req.user.id, to) });
});

/* ----- saved meals (recipes) ----- */
mealsRouter.get("/recipes", (req, res) => res.json(listRecipes(req.user.id)));
mealsRouter.post("/recipes", (req, res) => {
  const { name, items } = req.body || {};
  if (!name || !Array.isArray(items) || !items.length) return res.status(400).json({ error: "name + items required" });
  res.status(201).json({ recipes: addRecipe(req.user.id, name, items) });
});
mealsRouter.delete("/recipes/:id", (req, res) => {
  const ok = deleteRecipe(req.user.id, Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
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

// PUT /meals/:id -> edit an entry's amount/macros. Body: { amount?, grams?, calories, protein, carbs, fat }
mealsRouter.put("/:id", (req, res) => {
  const updated = updateMeal(req.user.id, Number(req.params.id), req.body || {});
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json({ meal: updated });
});

// DELETE /meals/:id -> remove one of the user's entries
mealsRouter.delete("/:id", (req, res) => {
  const ok = deleteMeal(req.user.id, Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});
