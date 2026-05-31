// ---------------------------------------------------------------------------
//  EXERCISE GUIDE (require auth) — in-app form instructions + demo images.
//  Data: free-exercise-db (public domain), slimmed into ./exercises.json.
//  Matching: curated overrides for the default program (guaranteed correct),
//  then a movement-class-guarded fuzzy match so a "row" never resolves to a
//  "press". Unmatched exercises return null (the client shows a video link).
// ---------------------------------------------------------------------------
import { Router } from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(readFileSync(path.join(__dirname, "exercises.json"), "utf8"));

const IMG_BASE = "https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/exercises/";

// movement classes — a query only matches a candidate sharing a class
const MOVE = {
  squat: ["squat"], deadlift: ["deadlift"], lunge: ["lunge"], thrust: ["thrust", "bridge"],
  row: ["row"], pulldown: ["pulldown"], pullup: ["pullup", "chin"], shrug: ["shrug"],
  press: ["press", "pushup"], fly: ["fly", "flye"], curl: ["curl"], pushdown: ["pushdown"],
  extension: ["extension"], raise: ["raise"], calf: ["calf"], abduct: ["abduct"],
  adduct: ["adduct"], dip: ["dip"], crunch: ["crunch", "situp"], pullover: ["pullover"],
};
const ALIAS = { rdl: "romanian deadlift", ohp: "overhead press", db: "dumbbell" };
const STOP = new Set("the a an of to for and with each standard conventional seated machine".split(" "));

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const expand = (s) => {
  let x = norm(s);
  for (const [k, v] of Object.entries(ALIAS)) x = x.replace(new RegExp(`\\b${k}\\b`, "g"), v);
  return x;
};
const stem = (t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);
const toks = (s) => expand(s).split(" ").filter((t) => t && !STOP.has(t)).map(stem);
const classesOf = (s) => {
  const x = " " + expand(s) + " ";
  const set = new Set();
  for (const [c, kw] of Object.entries(MOVE)) for (const k of kw) if (x.includes(k)) { set.add(c); break; }
  return set;
};

const INDEX = DATA.map((e) => ({ e, cl: classesOf(e.name), t: new Set(toks(e.name)) }));
const byId = new Map(DATA.map((e) => [e.id, e]));

// hand-curated for the default program (keyed by normalized IRONLOG name)
const CURATED = {
  "standard squats": "Barbell_Squat",
  "rdl": "Romanian_Deadlift",
  "flat press": "Dumbbell_Bench_Press",
  "lat pulldown narrow grip": "Close-Grip_Front_Lat_Pulldown",
  "lat pulldown wide grip": "Wide-Grip_Lat_Pulldown",
  "close grip row": "Seated_Cable_Rows",
  "overhand wide grip row": "Bent_Over_Barbell_Row",
  "wide grip row": "Seated_Cable_Rows",
  "lateral raises": "Side_Lateral_Raise",
  "abductor adductor machine": "Thigh_Abductor",
  "calf raise": "Standing_Calf_Raises",
  "cable cross triceps extension": "Cable_Lying_Triceps_Extension",
  "hip thrust": "Barbell_Hip_Thrust",
};

function shape(e) {
  return {
    id: e.id,
    name: e.name,
    primaryMuscles: e.primaryMuscles || [],
    instructions: e.instructions || [],
    images: (e.images || []).map((p) => IMG_BASE + p),
  };
}

function lookup(name, variation = "") {
  const curated = CURATED[norm(name)];
  if (curated && byId.has(curated)) return shape(byId.get(curated));

  const qc = classesOf(name);
  const qt = toks(`${name} ${variation}`);
  if (!qt.length) return null;

  let best = null, bestScore = 0, bestShared = 0;
  for (const { e, cl, t } of INDEX) {
    if (qc.size) {
      let ok = false;
      for (const c of qc) if (cl.has(c)) { ok = true; break; }
      if (!ok) continue; // movement class must match
    }
    let shared = 0;
    for (const x of qt) if (t.has(x)) shared++;
    const score = shared - t.size * 0.1; // prefer concise, on-topic names
    if (shared >= 1 && score > bestScore) { bestScore = score; best = e; bestShared = shared; }
  }
  // with a known movement, 1 strong shared token is enough; without one (unusual
  // custom names) require 2+ shared tokens to avoid spurious matches.
  const ok = qc.size ? bestScore >= 0.7 : bestShared >= 2;
  return best && ok ? shape(best) : null;
}

export { lookup }; // exported for tests

export const exercisesRouter = Router();

// GET /exercises/lookup?name=...&variation=... -> { match: <guide|null> }
exercisesRouter.get("/lookup", (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  res.json({ match: lookup(name, String(req.query.variation || "")) });
});
