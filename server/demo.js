// ---------------------------------------------------------------------------
//  DEMO ACCOUNTS
//  POST /auth/demo creates a throwaway account (google_sub = "demo:<uuid>") and
//  seeds it so the app looks lived-in from the first paint: the default
//  program, a profile with computed targets, ~4 weeks of progressing workout
//  history, a month of body-weight entries, and today's meals. Accounts are
//  purged opportunistically after 24h on the next demo sign-in (CASCADE takes
//  the data with them). No SQL here — everything goes through db.js.
// ---------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import db, {
  findOrCreateUser,
  purgeDemoUsersBefore,
  saveProgram,
  saveProfile,
  upsertWorkout,
  upsertWeight,
  addMeal,
} from "./db.js";
import { DEFAULT_PROGRAM_DAYS } from "./defaultProgram.js";

export const DEMO_TTL_MS = 24 * 60 * 60 * 1000;

/* ------------------------------ tiny helpers ----------------------------- */

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
const roundTo = (n, step) => Math.round(n / step) * step;
const uid = () => Math.random().toString(36).slice(2, 10);
const pad2 = (n) => String(n).padStart(2, "0");
const localDayStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const daysAgoStr = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDayStr(d);
};

// Mifflin–St Jeor -> TDEE -> goal calories -> macro split. Mirrors
// computeTargets() in the frontend (src/workout-tracker.jsx) so the seeded
// profile looks exactly like one produced by onboarding.
function computeTargets({ sex, age, heightIn, weightLbs, activityMult, goalFactor, proteinPerLb }) {
  const kg = weightLbs / 2.2046226, cm = heightIn * 2.54;
  const bmr = 10 * kg + 6.25 * cm - 5 * age + (sex === "female" ? -161 : 5);
  const calories = Math.round((bmr * activityMult * goalFactor) / 10) * 10;
  const protein = Math.round(proteinPerLb * weightLbs);
  const fat = Math.round((calories * 0.27) / 9);
  const carbs = Math.max(0, Math.round((calories - protein * 4 - fat * 9) / 4));
  return { calories, protein, carbs, fat };
}

/* ------------------------------ workout seed ----------------------------- */

// Sensible working weights (lbs) for the default program's exercises.
const BASE_WEIGHTS = {
  "Standard Squats": 185, "RDL": 165, "Seated Leg Extension": 120,
  "Abductor & Adductor Machine": 110, "Calf Raise": 90,
  "Incline Press": 60, "Flat Press": 65,
  "Lat Pulldown — Narrow Grip": 140, "Lat Pulldown — Wide Grip": 130,
  "Close Grip Row": 140, "Overhand Wide Grip Row": 120, "Wide Grip Row": 120,
  "Preacher Curls": 30, "Hammer Curls": 30, "Rear Delt Fly": 100,
  "Hip Thrust": 225, "Leg Extensions": 120, "Leg Curl": 110,
  "Overhead Triceps Extension": 45, "Triceps Pushdown (Cable)": 55,
  "Cable Cross Triceps Extension": 35, "Lateral Raises": 20,
};

// 4 sessions/week for 4 weeks, oldest -> newest, most recent one yesterday.
// Cycling LB1/UB1/LB2/UB2 like a real week: train, train, rest, train, train.
const SESSION_DAYS_AGO = [27, 25, 24, 22, 20, 18, 17, 15, 13, 11, 10, 8, 6, 4, 3, 1];

function buildDemoWorkout(day, daysAgo, weekIdx, seq) {
  const start = new Date();
  start.setDate(start.getDate() - daysAgo);
  start.setHours(17, randInt(15, 45), 0, 0); // evening lifter
  const startedAt = start.getTime();
  const finishedAt = startedAt + randInt(52, 72) * 60000;

  let clock = startedAt + randInt(3, 6) * 60000;
  const exercises = day.exercises.map((ex) => {
    // ~2.5%/week progression with a little day-to-day jitter, loads rounded
    // like a human would (nearest 2.5 lb). Reps also climb one per week so the
    // estimated 1RM strictly trends and the newest sessions register as PRs.
    const base = BASE_WEIGHTS[ex.name] || 80;
    const w = roundTo(base * (1 + 0.025 * weekIdx) * rand(0.99, 1.01), 2.5);
    const reps = 8 + weekIdx;
    const sets = Array.from({ length: Math.max(1, ex.sets) }, (_, si) => {
      const rest = randInt(80, 150);
      clock += rest * 1000 + randInt(35, 55) * 1000;
      return {
        w: String(w), r: String(Math.max(6, reps - si)), // strings, like the UI inputs
        done: true, doneAt: clock,
        ...(si > 0 ? { restBefore: rest } : {}),
      };
    });
    return {
      key: uid(), name: ex.name,
      variations: ex.variations || [],
      variation: (ex.variations && ex.variations[0]) || null,
      note: "", sets,
    };
  });

  return {
    id: `demo-${seq}-${uid()}`,
    dayKey: day.key, dayName: day.name, focus: day.focus, tag: day.tag,
    startedAt, finishedAt, note: "", exercises,
  };
}

/* --------------------------------- meals --------------------------------- */

const DEMO_MEALS = [
  { slot: "breakfast", name: "Oatmeal with Blueberries", amount: "1 bowl", calories: 320, protein: 12, carbs: 58, fat: 6 },
  { slot: "breakfast", name: "Scrambled Eggs", amount: "2 eggs", calories: 180, protein: 12, carbs: 2, fat: 13 },
  { slot: "lunch", name: "Chicken Breast & Rice", amount: "1 plate", calories: 520, protein: 45, carbs: 62, fat: 9 },
  { slot: "snacks", name: "Whey Protein Shake", amount: "1 scoop", calories: 130, protein: 25, carbs: 4, fat: 2 },
];
const DEMO_MEALS_YESTERDAY = [
  { slot: "breakfast", name: "Greek Yogurt & Granola", amount: "1 bowl", calories: 290, protein: 20, carbs: 38, fat: 7 },
  { slot: "lunch", name: "Turkey Sandwich", amount: "1 sandwich", calories: 450, protein: 32, carbs: 48, fat: 14 },
  { slot: "dinner", name: "Salmon, Potatoes & Greens", amount: "1 plate", calories: 610, protein: 42, carbs: 48, fat: 24 },
  { slot: "snacks", name: "Whey Protein Shake", amount: "1 scoop", calories: 130, protein: 25, carbs: 4, fat: 2 },
];

/* ------------------------------ the seeder ------------------------------- */

const seedDemoData = db.transaction((userId) => {
  // program — skips onboarding (a program row means onboarded:true)
  saveProgram(userId, DEFAULT_PROGRAM_DAYS);

  // ~a month of body weight, trending slightly down with day-to-day noise
  const startWeight = 187;
  let lastWeight = startWeight;
  for (let d = 30; d >= 0; d--) {
    if (d !== 0 && Math.random() < 0.15) continue; // humans skip days
    lastWeight = Math.round((startWeight - 0.08 * (30 - d) + rand(-0.4, 0.4)) * 10) / 10;
    upsertWeight(userId, daysAgoStr(d), lastWeight);
  }

  // profile with computed targets (matches what onboarding would store)
  const stats = { sex: "male", age: 28, heightIn: 70, weightLbs: Math.round(lastWeight) };
  saveProfile(userId, {
    ...stats,
    activity: "moderate", goal: "lose_fat", custom: false,
    targets: computeTargets({ ...stats, activityMult: 1.55, goalFactor: 0.8, proteinPerLb: 1.0 }),
  });

  // ~4 weeks of workouts cycling the program, oldest first so weights progress
  SESSION_DAYS_AGO.forEach((daysAgo, i) => {
    const day = DEFAULT_PROGRAM_DAYS[i % DEFAULT_PROGRAM_DAYS.length];
    const weekIdx = Math.floor(i / 4); // 0..3 -> +2.5%/week
    upsertWorkout(userId, buildDemoWorkout(day, daysAgo, weekIdx, i));
  });

  // meals for today + yesterday so the Meals tab is populated in any timezone
  for (const m of DEMO_MEALS) addMeal(userId, { ...m, day: daysAgoStr(0) });
  for (const m of DEMO_MEALS_YESTERDAY) addMeal(userId, { ...m, day: daysAgoStr(1) });
});

// Create a fresh, fully-seeded demo account and return its public user object.
// Also purges demo accounts older than 24h (single DELETE, CASCADE does the rest).
export function createDemoUser() {
  purgeDemoUsersBefore(Date.now() - DEMO_TTL_MS);
  const user = findOrCreateUser({
    sub: `demo:${randomUUID()}`,
    email: null,
    name: "Demo Athlete",
    picture: null,
  });
  seedDemoData(user.id);
  return user;
}
