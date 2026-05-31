// ---------------------------------------------------------------------------
//  EXPRESS APP (importable — does NOT call listen, so tests can mount it).
//  server/index.js imports this and starts the listener.
// ---------------------------------------------------------------------------
import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { authRouter, requireAuth } from "./auth.js";
import { workoutsRouter } from "./workouts.js";
import { programsRouter } from "./programs.js";
import { profileRouter } from "./profile.js";
import { mealsRouter } from "./meals.js";
import { foodsRouter } from "./foods.js";
import { weightsRouter } from "./weights.js";
import { activityRouter } from "./activity.js";
import { exercisesRouter } from "./exercises.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_PROD = process.env.NODE_ENV === "production";

export const app = express();
app.set("trust proxy", 1); // we sit behind Fly's proxy — trust the first hop for real client IP

// Security headers. CSP / cross-origin isolation are left off here because they
// need careful tuning against Google Identity Services, fonts, and profile images
// (a follow-up); the rest (HSTS, no-sniff, frameguard, referrer policy, etc.) are
// safe wins.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
}));

app.use(express.json({ limit: "5mb" })); // backup imports can be largish
app.use(cookieParser());

// Rate limits (keyed on real client IP via trust proxy). Protect the token
// endpoint from abuse and the food proxy from burning the USDA/OFF quota.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many sign-in attempts — please wait a few minutes." },
});
const foodsLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: "Slow down a moment — too many searches." },
});

// --- API routes ---
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/auth/google", authLimiter);
app.use("/foods", foodsLimiter);
app.use("/auth", authRouter);
app.use("/workouts", requireAuth, workoutsRouter); // every workout route is protected
app.use("/program", requireAuth, programsRouter);  // per-user editable program
app.use("/profile", requireAuth, profileRouter);   // body stats, goal, targets
app.use("/meals", requireAuth, mealsRouter);       // per-day food log + recent/favorites
app.use("/foods", requireAuth, foodsRouter);       // external food search proxy
app.use("/weights", requireAuth, weightsRouter);   // body-weight log for the trend chart
app.use("/activity", requireAuth, activityRouter); // per-day active calories burned
app.use("/exercises", requireAuth, exercisesRouter); // in-app exercise form guides

// --- Static frontend (production only) ---
if (IS_PROD) {
  const distDir = path.join(__dirname, "..", "dist");
  if (!fs.existsSync(distDir)) {
    console.warn("[server] dist/ not found — run `npm run build` before `npm start`.");
  }

  // The hash of the currently-deployed frontend bundle. A new deploy = new
  // server process = new hash, which the client polls to detect updates.
  let bundleHash = null;
  try {
    const html = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
    bundleHash = (html.match(/index-([A-Za-z0-9_-]+)\.js/) || [])[1] || null;
  } catch { /* no dist yet */ }
  app.get("/api/version", (_req, res) => res.json({ bundle: bundleHash }));

  app.use(express.static(distDir));
  // SPA fallback: anything that isn't an API route returns index.html
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/auth") || req.path.startsWith("/workouts") ||
        req.path.startsWith("/program") || req.path.startsWith("/profile") ||
        req.path.startsWith("/meals") || req.path.startsWith("/foods") ||
        req.path.startsWith("/weights") || req.path.startsWith("/activity") ||
        req.path.startsWith("/exercises") || req.path.startsWith("/api")) {
      return next();
    }
    res.sendFile(path.join(distDir, "index.html"));
  });
}
