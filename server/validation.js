// ---------------------------------------------------------------------------
//  REQUEST VALIDATION (zod)
//  Schema for the workout-session payload the frontend sends. Weights and reps
//  come straight from text inputs, so they arrive as strings ("135", "") —
//  accept string|number everywhere the UI does. z.object() strips unknown keys
//  by default, which doubles as our defense against payload stuffing; array
//  sizes and string lengths are bounded so a hostile payload can't balloon the
//  exercises JSON blob.
// ---------------------------------------------------------------------------
import { z } from "zod";

const numish = z.union([z.string().max(12), z.number()]); // "135", "", 135, 12.5
const ts = z.number().int().safe().nullish();             // epoch millis

const setSchema = z.object({
  w: numish.optional(),
  r: numish.optional(),
  done: z.boolean().optional(),
  doneAt: ts.optional(),
  restBefore: z.number().nullish(),
});

const exerciseSchema = z.object({
  key: z.string().max(64).optional(),
  name: z.string().max(120),
  variation: z.string().max(80).nullish(),
  variations: z.array(z.string().max(80)).max(20).optional(),
  note: z.string().max(500).optional(),
  sets: z.array(setSchema).max(100),
});

export const workoutSessionSchema = z.object({
  id: z.union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => v.length > 0 && v.length <= 100, "id must be 1–100 characters"),
  dayKey: z.string().max(64).nullish(),
  dayName: z.string().max(120).nullish(),
  focus: z.string().max(120).nullish(),
  tag: z.string().max(24).nullish(),
  startedAt: ts,
  finishedAt: ts,
  note: z.string().max(1000).nullish(),
  exercises: z.array(exerciseSchema).max(50),
});

// Human-readable one-liner from a zod error, e.g.
// "exercises.0.sets: expected array; id: id must be 1–100 characters"
export function zodMessage(error) {
  const seen = new Set();
  const parts = [];
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "payload";
    const msg = `${path}: ${issue.message}`;
    if (!seen.has(msg)) { seen.add(msg); parts.push(msg); }
    if (parts.length >= 5) break; // enough to debug, not a wall of text
  }
  return parts.join("; ");
}
