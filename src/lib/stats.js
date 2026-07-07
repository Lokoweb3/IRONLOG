// ---------------------------------------------------------------------------
//  TRAINING MATH — pure functions, no React, no DOM.
//  Extracted from workout-tracker.jsx so it can be unit-tested with node --test
//  and reused (e.g. the plate calculator). Keep this file dependency-free.
// ---------------------------------------------------------------------------

// estimated 1-rep max (Epley formula)
export const e1rm = (w, r) => {
  const W = parseFloat(w) || 0, R = parseFloat(r) || 0;
  if (!W || !R) return 0;
  return W * (1 + R / 30);
};

// best estimated 1RM across a list of sets ({ w, r })
export const bestSetE1rm = (sets) => sets.reduce((m, s) => Math.max(m, e1rm(s.w, s.r)), 0);

// best-ever e1rm for an exercise across past sessions (optionally same variation
// only, optionally excluding one session — e.g. the one being edited)
export function historicalBestE1rm(sessions, name, variation, excludeId) {
  let best = 0;
  for (const s of sessions) {
    if (s.id === excludeId) continue;
    for (const ex of s.exercises) {
      if (ex.name !== name) continue;
      if (variation != null && ex.variation !== variation) continue;
      best = Math.max(best, bestSetE1rm(ex.sets));
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
//  PLATE CALCULATOR
//  Greedy per-side breakdown for a barbell load. Standard plate sets are
//  "greedy-safe" (each plate ≥ the sum of everything smaller), so greedy finds
//  the closest loadable weight ≤ target.
//
//  Returns {
//    perSide:   [45, 45, 2.5, ...]  plates for ONE side, heaviest first
//    loaded:    the exact weight on the bar (bar + 2 × per-side sum)
//    remainder: target − loaded (0 when the target is exactly loadable;
//               negative when the target is below the empty bar)
//  }
// ---------------------------------------------------------------------------
export function calcPlates(target, barWeight = 45, plates = [45, 35, 25, 10, 5, 2.5]) {
  const t = Number(target) || 0;
  const bar = Number(barWeight) || 0;

  if (t <= bar) {
    // nothing to load — an empty bar already weighs bar lbs
    return { perSide: [], loaded: bar, remainder: round2(t - bar) };
  }

  const sorted = [...plates].filter((p) => Number(p) > 0).sort((a, b) => b - a);
  let perSideLeft = (t - bar) / 2;
  const perSide = [];
  for (const p of sorted) {
    while (perSideLeft >= p - 1e-9) {
      perSide.push(p);
      perSideLeft -= p;
    }
  }
  const loaded = round2(bar + 2 * perSide.reduce((a, b) => a + b, 0));
  return { perSide, loaded, remainder: round2(t - loaded) };
}

const round2 = (n) => Math.round(n * 100) / 100;
