// ---------------------------------------------------------------------------
//  DATA LAYER
//  Every piece of SQL lives in this file. The rest of the server only calls the
//  exported functions below, so migrating to Postgres later means rewriting just
//  this module (swap better-sqlite3 for `pg`, adjust the SQL dialect, keep the
//  same function signatures + return shapes).
// ---------------------------------------------------------------------------
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, "..", "data", "app.db");

// make sure the containing directory exists before opening the file
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub  TEXT    NOT NULL UNIQUE,
    email       TEXT,
    name        TEXT,
    picture     TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workouts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id   TEXT    NOT NULL,         -- the id the frontend generates (uid())
    day_key     TEXT,
    day_name    TEXT,
    focus       TEXT,
    tag         TEXT,
    started_at  INTEGER,
    finished_at INTEGER,
    exercises   TEXT    NOT NULL,         -- JSON blob (array of exercises)
    created_at  INTEGER NOT NULL,
    UNIQUE (user_id, client_id)           -- enables upsert-by-client-id
  );

  CREATE INDEX IF NOT EXISTS idx_workouts_user
    ON workouts (user_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS programs (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    days       TEXT    NOT NULL,        -- JSON array of day objects
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profiles (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data       TEXT    NOT NULL,        -- JSON: { sex, age, heightIn, weightLbs, activity, goal, targets }
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day        TEXT    NOT NULL,        -- local date 'YYYY-MM-DD'
    name       TEXT    NOT NULL,
    brand      TEXT,
    amount     TEXT,                    -- human label, e.g. "150 g"
    calories   REAL    NOT NULL DEFAULT 0,
    protein    REAL    NOT NULL DEFAULT 0,
    carbs      REAL    NOT NULL DEFAULT 0,
    fat        REAL    NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_meals_user_day ON meals (user_id, day);

  CREATE TABLE IF NOT EXISTS favorites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    brand      TEXT,
    amount     TEXT,
    calories   REAL    NOT NULL DEFAULT 0,
    protein    REAL    NOT NULL DEFAULT 0,
    carbs      REAL    NOT NULL DEFAULT 0,
    fat        REAL    NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, name, amount)
  );

  CREATE TABLE IF NOT EXISTS weights (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day        TEXT    NOT NULL,         -- local date 'YYYY-MM-DD'
    weight_lbs REAL    NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, day)
  );

  CREATE TABLE IF NOT EXISTS recipes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    items      TEXT    NOT NULL,           -- JSON array of food entries
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day        TEXT    NOT NULL,           -- local date 'YYYY-MM-DD'
    calories   REAL    NOT NULL DEFAULT 0, -- active calories burned that day
    source     TEXT,                       -- 'manual' | 'estimate'
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, day)
  );
`);

// --- lightweight migrations: add columns to existing meals tables ---
const mealCols = db.prepare("PRAGMA table_info(meals)").all().map((c) => c.name);
if (!mealCols.includes("slot")) db.exec("ALTER TABLE meals ADD COLUMN slot TEXT NOT NULL DEFAULT 'snacks'");
if (!mealCols.includes("grams")) db.exec("ALTER TABLE meals ADD COLUMN grams REAL");
if (!mealCols.includes("base")) db.exec("ALTER TABLE meals ADD COLUMN base TEXT"); // JSON { per100g, servingG }

/* ----------------------------- mapping helpers --------------------------- */

// Convert a DB row into the exact session shape the React frontend expects.
function rowToSession(row) {
  return {
    id: row.client_id,
    dayKey: row.day_key,
    dayName: row.day_name,
    focus: row.focus,
    tag: row.tag,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exercises: JSON.parse(row.exercises),
  };
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
  };
}

/* --------------------------------- users --------------------------------- */

const _getUserBySub = db.prepare("SELECT * FROM users WHERE google_sub = ?");
const _getUserById = db.prepare("SELECT * FROM users WHERE id = ?");
const _insertUser = db.prepare(`
  INSERT INTO users (google_sub, email, name, picture, created_at)
  VALUES (@google_sub, @email, @name, @picture, @created_at)
`);
const _updateUserProfile = db.prepare(`
  UPDATE users SET email = @email, name = @name, picture = @picture WHERE id = @id
`);

// Find the user by their Google `sub`, creating the row on first sign-in and
// refreshing email/name/picture on subsequent ones. Returns the public user.
export function findOrCreateUser({ sub, email, name, picture }) {
  const existing = _getUserBySub.get(sub);
  if (existing) {
    _updateUserProfile.run({ id: existing.id, email, name, picture });
    return publicUser(_getUserById.get(existing.id));
  }
  const info = _insertUser.run({
    google_sub: sub,
    email,
    name,
    picture,
    created_at: Date.now(),
  });
  return publicUser(_getUserById.get(info.lastInsertRowid));
}

export function getUserById(id) {
  return publicUser(_getUserById.get(id));
}

const _deleteUser = db.prepare("DELETE FROM users WHERE id = ?");
// Delete the user; ON DELETE CASCADE removes their workouts, program, profile,
// meals, favorites and weights (foreign_keys pragma is ON).
export function deleteUserAccount(userId) {
  return _deleteUser.run(userId).changes > 0;
}

// Gather everything we hold for a user, for "download my data".
export function exportUserData(userId) {
  const allMeals = db.prepare("SELECT * FROM meals WHERE user_id = ? ORDER BY day ASC, created_at ASC").all(userId);
  return {
    user: getUserById(userId),
    profile: getProfile(userId),
    program: getProgram(userId),
    workouts: listWorkouts(userId),
    meals: allMeals.map(rowToMeal),
    weights: listWeights(userId),
    favorites: listFavorites(userId),
    activity: listActivity(userId),
  };
}

/* -------------------------------- workouts ------------------------------- */

const _listWorkouts = db.prepare(
  "SELECT * FROM workouts WHERE user_id = ? ORDER BY started_at DESC, id DESC"
);
const _deleteWorkout = db.prepare(
  "DELETE FROM workouts WHERE user_id = ? AND client_id = ?"
);
const _upsertWorkout = db.prepare(`
  INSERT INTO workouts
    (user_id, client_id, day_key, day_name, focus, tag, started_at, finished_at, exercises, created_at)
  VALUES
    (@user_id, @client_id, @day_key, @day_name, @focus, @tag, @started_at, @finished_at, @exercises, @created_at)
  ON CONFLICT (user_id, client_id) DO UPDATE SET
    day_key     = excluded.day_key,
    day_name    = excluded.day_name,
    focus       = excluded.focus,
    tag         = excluded.tag,
    started_at  = excluded.started_at,
    finished_at = excluded.finished_at,
    exercises   = excluded.exercises
`);
const _getWorkout = db.prepare(
  "SELECT * FROM workouts WHERE user_id = ? AND client_id = ?"
);

export function listWorkouts(userId) {
  return _listWorkouts.all(userId).map(rowToSession);
}

// Insert or update a single session (keyed by client id). Returns the session.
export function upsertWorkout(userId, session) {
  const clientId = String(session.id || "").trim();
  if (!clientId) throw new Error("workout is missing an id");
  _upsertWorkout.run({
    user_id: userId,
    client_id: clientId,
    day_key: session.dayKey ?? null,
    day_name: session.dayName ?? null,
    focus: session.focus ?? null,
    tag: session.tag ?? null,
    started_at: session.startedAt ?? null,
    finished_at: session.finishedAt ?? null,
    exercises: JSON.stringify(Array.isArray(session.exercises) ? session.exercises : []),
    created_at: Date.now(),
  });
  return rowToSession(_getWorkout.get(userId, clientId));
}

export function deleteWorkout(userId, clientId) {
  const info = _deleteWorkout.run(userId, clientId);
  return info.changes > 0;
}

// Bulk upsert for backup restore. MERGES (existing rows not in the payload are
// left untouched); returns how many were newly created. Wrapped in a single
// transaction for speed + atomicity.
export const importWorkouts = db.transaction((userId, sessions) => {
  let added = 0;
  for (const s of sessions) {
    if (!s || !s.id || !Array.isArray(s.exercises)) continue;
    const existed = _getWorkout.get(userId, String(s.id));
    upsertWorkout(userId, s);
    if (!existed) added++;
  }
  return added;
});

/* -------------------------------- programs ------------------------------- */

const _getProgram = db.prepare("SELECT days FROM programs WHERE user_id = ?");
const _upsertProgram = db.prepare(`
  INSERT INTO programs (user_id, days, updated_at)
  VALUES (@user_id, @days, @updated_at)
  ON CONFLICT (user_id) DO UPDATE SET
    days       = excluded.days,
    updated_at = excluded.updated_at
`);

// Returns the user's program (array of days), or null if they don't have one yet.
export function getProgram(userId) {
  const row = _getProgram.get(userId);
  return row ? JSON.parse(row.days) : null;
}

export function saveProgram(userId, days) {
  _upsertProgram.run({
    user_id: userId,
    days: JSON.stringify(Array.isArray(days) ? days : []),
    updated_at: Date.now(),
  });
  return getProgram(userId);
}

// Remove the program row (sends the user back through onboarding). History +
// profile are untouched.
const _clearProgram = db.prepare("DELETE FROM programs WHERE user_id = ?");
export function clearProgram(userId) {
  return _clearProgram.run(userId).changes > 0;
}

/* -------------------------------- profile -------------------------------- */

const _getProfile = db.prepare("SELECT data FROM profiles WHERE user_id = ?");
const _upsertProfile = db.prepare(`
  INSERT INTO profiles (user_id, data, updated_at)
  VALUES (@user_id, @data, @updated_at)
  ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);

export function getProfile(userId) {
  const row = _getProfile.get(userId);
  return row ? JSON.parse(row.data) : null;
}

export function saveProfile(userId, data) {
  _upsertProfile.run({
    user_id: userId,
    data: JSON.stringify(data || {}),
    updated_at: Date.now(),
  });
  return getProfile(userId);
}

/* --------------------------------- meals --------------------------------- */

const SLOTS = new Set(["breakfast", "lunch", "dinner", "snacks"]);
const slotOf = (s) => (SLOTS.has(s) ? s : "snacks");
const mnum = (v) => Math.max(0, Math.round((Number(v) || 0) * 10) / 10);

const _listMeals = db.prepare(
  "SELECT * FROM meals WHERE user_id = ? AND day = ? ORDER BY created_at ASC, id ASC"
);
const _getMeal = db.prepare("SELECT * FROM meals WHERE id = ? AND user_id = ?");
const _insertMeal = db.prepare(`
  INSERT INTO meals (user_id, day, slot, name, brand, amount, grams, base, calories, protein, carbs, fat, created_at)
  VALUES (@user_id, @day, @slot, @name, @brand, @amount, @grams, @base, @calories, @protein, @carbs, @fat, @created_at)
`);
const _updateMeal = db.prepare(`
  UPDATE meals SET amount = @amount, grams = @grams,
    calories = @calories, protein = @protein, carbs = @carbs, fat = @fat
  WHERE id = @id AND user_id = @user_id
`);
const _deleteMeal = db.prepare("DELETE FROM meals WHERE id = ? AND user_id = ?");

function rowToMeal(r) {
  return {
    id: r.id, day: r.day, slot: r.slot || "snacks",
    name: r.name, brand: r.brand, amount: r.amount,
    grams: r.grams, base: r.base ? JSON.parse(r.base) : null,
    calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat,
  };
}

export function listMeals(userId, day) {
  return _listMeals.all(userId, day).map(rowToMeal);
}

export function addMeal(userId, m) {
  const info = _insertMeal.run({
    user_id: userId,
    day: String(m.day),
    slot: slotOf(m.slot),
    name: String(m.name || "Food").slice(0, 120),
    brand: m.brand ? String(m.brand).slice(0, 80) : null,
    amount: m.amount ? String(m.amount).slice(0, 60) : null,
    grams: m.grams != null ? Number(m.grams) || null : null,
    base: m.base ? JSON.stringify(m.base) : null,
    calories: mnum(m.calories), protein: mnum(m.protein), carbs: mnum(m.carbs), fat: mnum(m.fat),
    created_at: Date.now(),
  });
  return rowToMeal(_getMeal.get(info.lastInsertRowid, userId));
}

// Add many entries in one transaction (used by recipes + copy-day).
export const bulkAddMeals = db.transaction((userId, items) => {
  for (const m of items) addMeal(userId, m);
  return true;
});

export function updateMeal(userId, id, fields) {
  const ok = _updateMeal.run({
    id, user_id: userId,
    amount: fields.amount ? String(fields.amount).slice(0, 60) : null,
    grams: fields.grams != null ? Number(fields.grams) || null : null,
    calories: mnum(fields.calories), protein: mnum(fields.protein), carbs: mnum(fields.carbs), fat: mnum(fields.fat),
  }).changes > 0;
  return ok ? rowToMeal(_getMeal.get(id, userId)) : null;
}

export function deleteMeal(userId, id) {
  return _deleteMeal.run(id, userId).changes > 0;
}

// Copy every entry from one day to another (new rows, same slots).
export const copyDayMeals = db.transaction((userId, from, to) => {
  const src = listMeals(userId, from);
  for (const m of src) addMeal(userId, { ...m, day: to });
  return src.length;
});

// Recently-logged distinct foods (for one-tap re-logging), carrying grams/base
// so re-logged items can still be rescaled when edited.
const _recentFoods = db.prepare(`
  SELECT name, brand, amount, grams, base, calories, protein, carbs, fat, MAX(created_at) AS last
  FROM meals WHERE user_id = ?
  GROUP BY name, brand, amount
  ORDER BY last DESC
  LIMIT 16
`);
export function recentFoods(userId) {
  return _recentFoods.all(userId).map((r) => ({
    name: r.name, brand: r.brand, amount: r.amount,
    grams: r.grams, base: r.base ? JSON.parse(r.base) : null,
    calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat,
  }));
}

/* -------------------------------- recipes -------------------------------- */

const _listRecipes = db.prepare("SELECT * FROM recipes WHERE user_id = ? ORDER BY created_at DESC");
const _insertRecipe = db.prepare(
  "INSERT INTO recipes (user_id, name, items, created_at) VALUES (@user_id, @name, @items, @created_at)"
);
const _deleteRecipe = db.prepare("DELETE FROM recipes WHERE id = ? AND user_id = ?");

function rowToRecipe(r) {
  return { id: r.id, name: r.name, items: JSON.parse(r.items) };
}
export function listRecipes(userId) {
  return _listRecipes.all(userId).map(rowToRecipe);
}
export function addRecipe(userId, name, items) {
  const clean = (Array.isArray(items) ? items : []).map((m) => ({
    name: String(m.name || "Food").slice(0, 120),
    brand: m.brand ? String(m.brand).slice(0, 80) : null,
    amount: m.amount ? String(m.amount).slice(0, 60) : null,
    grams: m.grams != null ? Number(m.grams) || null : null,
    base: m.base || null,
    calories: mnum(m.calories), protein: mnum(m.protein), carbs: mnum(m.carbs), fat: mnum(m.fat),
  }));
  _insertRecipe.run({
    user_id: userId, name: String(name || "Meal").slice(0, 80),
    items: JSON.stringify(clean), created_at: Date.now(),
  });
  return listRecipes(userId);
}
export function deleteRecipe(userId, id) {
  return _deleteRecipe.run(id, userId).changes > 0;
}

/* ------------------------------- favorites ------------------------------- */

const _listFavorites = db.prepare("SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at DESC");
const _insertFavorite = db.prepare(`
  INSERT INTO favorites (user_id, name, brand, amount, calories, protein, carbs, fat, created_at)
  VALUES (@user_id, @name, @brand, @amount, @calories, @protein, @carbs, @fat, @created_at)
  ON CONFLICT (user_id, name, amount) DO UPDATE SET
    brand = excluded.brand, calories = excluded.calories, protein = excluded.protein,
    carbs = excluded.carbs, fat = excluded.fat
`);
const _deleteFavorite = db.prepare("DELETE FROM favorites WHERE id = ? AND user_id = ?");

function rowToFood(r) {
  return {
    id: r.id, name: r.name, brand: r.brand, amount: r.amount,
    calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat,
  };
}

export function listFavorites(userId) {
  return _listFavorites.all(userId).map(rowToFood);
}
export function addFavorite(userId, f) {
  const num = (v) => Math.max(0, Math.round((Number(v) || 0) * 10) / 10);
  _insertFavorite.run({
    user_id: userId,
    name: String(f.name || "Food").slice(0, 120),
    brand: f.brand ? String(f.brand).slice(0, 80) : null,
    amount: f.amount ? String(f.amount).slice(0, 40) : null,
    calories: num(f.calories), protein: num(f.protein), carbs: num(f.carbs), fat: num(f.fat),
    created_at: Date.now(),
  });
  return listFavorites(userId);
}
export function deleteFavorite(userId, id) {
  return _deleteFavorite.run(id, userId).changes > 0;
}

/* -------------------------------- weights -------------------------------- */

const _listWeights = db.prepare("SELECT id, day, weight_lbs FROM weights WHERE user_id = ? ORDER BY day ASC");
const _upsertWeight = db.prepare(`
  INSERT INTO weights (user_id, day, weight_lbs, created_at)
  VALUES (@user_id, @day, @weight_lbs, @created_at)
  ON CONFLICT (user_id, day) DO UPDATE SET weight_lbs = excluded.weight_lbs
`);
const _deleteWeight = db.prepare("DELETE FROM weights WHERE id = ? AND user_id = ?");

export function listWeights(userId) {
  return _listWeights.all(userId).map((r) => ({ id: r.id, day: r.day, weightLbs: r.weight_lbs }));
}
export function upsertWeight(userId, day, weightLbs) {
  _upsertWeight.run({ user_id: userId, day: String(day), weight_lbs: Number(weightLbs) || 0, created_at: Date.now() });
  return listWeights(userId);
}
export function deleteWeight(userId, id) {
  return _deleteWeight.run(id, userId).changes > 0;
}

/* -------------------------- activity (cals burned) ----------------------- */

const _getActivity = db.prepare("SELECT day, calories, source FROM activity WHERE user_id = ? AND day = ?");
const _listActivity = db.prepare("SELECT day, calories, source FROM activity WHERE user_id = ? ORDER BY day ASC");
const _upsertActivity = db.prepare(`
  INSERT INTO activity (user_id, day, calories, source, created_at)
  VALUES (@user_id, @day, @calories, @source, @created_at)
  ON CONFLICT (user_id, day) DO UPDATE SET calories = excluded.calories, source = excluded.source
`);
const _deleteActivity = db.prepare("DELETE FROM activity WHERE user_id = ? AND day = ?");

function rowToActivity(r) {
  return r ? { day: r.day, calories: r.calories, source: r.source || null } : null;
}

// One day's active-calorie entry, or null if nothing logged for that day.
export function getActivity(userId, day) {
  return rowToActivity(_getActivity.get(userId, String(day)));
}
export function listActivity(userId) {
  return _listActivity.all(userId).map(rowToActivity);
}
// Upsert a day's burned calories. Returns the saved entry.
export function upsertActivity(userId, day, calories, source) {
  _upsertActivity.run({
    user_id: userId, day: String(day),
    calories: Math.max(0, Math.round(Number(calories) || 0)),
    source: source === "estimate" ? "estimate" : "manual",
    created_at: Date.now(),
  });
  return getActivity(userId, day);
}
export function deleteActivity(userId, day) {
  return _deleteActivity.run(userId, String(day)).changes > 0;
}

export default db;
