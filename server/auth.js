// ---------------------------------------------------------------------------
//  AUTH
//  - Verifies Google ID tokens (the JWT credential GIS hands the frontend)
//    against our GOOGLE_CLIENT_ID using google-auth-library. We NEVER trust the
//    token client-side.
//  - Issues our OWN session as a signed JWT stored in an httpOnly, Secure,
//    SameSite cookie.
//  - Exposes requireAuth middleware that reads the cookie and attaches req.user.
// ---------------------------------------------------------------------------
import { Router } from "express";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { findOrCreateUser, getUserById, exportUserData, deleteUserAccount } from "./db.js";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;
const IS_PROD = process.env.NODE_ENV === "production";

const COOKIE_NAME = "session";
const SESSION_TTL_DAYS = 30;

if (!GOOGLE_CLIENT_ID) {
  console.warn("[auth] GOOGLE_CLIENT_ID is not set — /auth/google will fail. See README.");
}
if (!SESSION_SECRET) {
  console.warn("[auth] SESSION_SECRET is not set — using an insecure dev fallback. Set it in .env!");
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const secret = SESSION_SECRET || "dev-insecure-secret-change-me";

function setSessionCookie(res, userId) {
  const token = jwt.sign({ uid: userId }, secret, {
    expiresIn: `${SESSION_TTL_DAYS}d`,
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PROD,          // Secure only over HTTPS (prod). Dev is http://localhost.
    sameSite: "lax",          // first-party app, so lax is enough and lets links work
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: IS_PROD, sameSite: "lax", path: "/" });
}

// Middleware: require a valid session. Attaches req.user (public shape) or 401s.
export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "not authenticated" });
  try {
    const { uid } = jwt.verify(token, secret);
    const user = getUserById(uid);
    if (!user) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "user no longer exists" });
    }
    req.user = user;
    next();
  } catch {
    clearSessionCookie(res);
    return res.status(401).json({ error: "invalid session" });
  }
}

export const authRouter = Router();

// POST /auth/google — verify the GIS ID token, find-or-create the user, set cookie.
authRouter.post("/google", async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: "missing credential" });
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: "server missing GOOGLE_CLIENT_ID" });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload(); // { sub, email, name, picture, ... }
    if (!payload?.sub) return res.status(401).json({ error: "invalid token" });

    const user = findOrCreateUser({
      sub: payload.sub,
      email: payload.email || null,
      name: payload.name || payload.email || "Athlete",
      picture: payload.picture || null,
    });

    setSessionCookie(res, user.id);
    res.json({ user });
  } catch (err) {
    console.error("[auth] verifyIdToken failed:", err.message);
    res.status(401).json({ error: "token verification failed" });
  }
});

// POST /auth/logout — clear the session cookie.
authRouter.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /auth/me — current user or 401.
authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// GET /auth/export — download everything we hold for the signed-in user.
authRouter.get("/export", requireAuth, (req, res) => {
  res.json({ app: "IRONLOG", version: 1, exportedAt: new Date().toISOString(), ...exportUserData(req.user.id) });
});

// DELETE /auth/account — permanently delete the account + all data, clear session.
authRouter.delete("/account", requireAuth, (req, res) => {
  deleteUserAccount(req.user.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});
