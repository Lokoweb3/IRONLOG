import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import {
  Dumbbell, History, TrendingUp, Plus, Check, X, Timer,
  ChevronLeft, Trash2, Flame, ChevronDown, ChevronRight, ChevronUp, Play, Pause, RotateCcw,
  CalendarDays, Volume2, VolumeX, Trophy, Download, Upload,
  LogOut, ListChecks, Pencil, UtensilsCrossed, Search, Target, Scale, ScanLine, Camera, Flashlight, Star, PlayCircle,
  Copy, Save, BookOpen, Share2, Disc, WifiOff
} from "lucide-react";
import { api } from "./api.js";
import { e1rm, bestSetE1rm, historicalBestE1rm } from "./lib/stats.js";
import { loadOutbox, queueWorkout, removeFromOutbox, flushOutbox } from "./lib/outbox.js";
import PlateCalc from "./PlateCalc.jsx";

// recharts is heavy and only used on Progress/Profile — load it as a separate
// chunk on demand so it stays out of the initial bundle.
const TrendChart = lazy(() => import("./TrendChart.jsx"));
const ChartFallback = () => <p className="chart-hint" style={{ padding: 40 }}>Loading chart…</p>;

/* ------------------------------------------------------------------ */
/*  PROGRAM COLORS                                                     */
/*  The training program itself is now per-user data loaded from the    */
/*  API (the old hardcoded WORKOUTS lives server-side as the default    */
/*  seed). Days carry their own `color`; these helpers pick/derive one. */
/* ------------------------------------------------------------------ */
const DAY_PALETTE = [
  "#d8ff36", "#46d9ff", "#ffb13e", "#ff6fd0",
  "#7c9cff", "#9cff6f", "#ff8f6f", "#c46fff",
];
// colors of the original 4-day split, so pre-existing history stays consistent
const LEGACY_DAY_COLOR = { lower1: "#d8ff36", upper1: "#46d9ff", lower2: "#ffb13e", upper2: "#ff6fd0" };

function hashColor(key) {
  let h = 0;
  for (let i = 0; i < (key || "").length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return DAY_PALETTE[h % DAY_PALETTE.length];
}
// Resolve a calendar color for a session's dayKey: prefer the live program day's
// color, fall back to the legacy split, then a stable hash. (Sessions are
// snapshots, so editing/deleting a program day never breaks history.)
function colorForDayKey(dayKey, program) {
  const d = (program || []).find((x) => x.key === dayKey);
  return d?.color || LEGACY_DAY_COLOR[dayKey] || hashColor(dayKey);
}

/* ------------------------------------------------------------------ */
/*  ACTIVE-DRAFT PERSISTENCE                                            */
/*  Finished workouts live on the server (see ./api.js). The ONE thing  */
/*  we still keep on-device is the in-progress session draft, so a mid- */
/*  workout refresh or accidental nav doesn't lose unsaved sets. Keyed  */
/*  per user id; cleared on finish/cancel/logout.                       */
/* ------------------------------------------------------------------ */
const activeDraftKey = (userId) => `wt:u:${userId}:active`;

function loadActiveDraft(userId) {
  try {
    const raw = localStorage.getItem(activeDraftKey(userId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveActiveDraft(userId, value) {
  try { localStorage.setItem(activeDraftKey(userId), JSON.stringify(value)); } catch {}
}
function clearActiveDraft(userId) {
  try { localStorage.removeItem(activeDraftKey(userId)); } catch {}
}

/* ------------------------------------------------------------------ */
/*  HELPERS                                                            */
/* ------------------------------------------------------------------ */
const uid = () => Math.random().toString(36).slice(2, 10);
const fmtDate = (ts) =>
  new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const fmtShort = (ts) =>
  new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });

// timestamp <-> <input type="datetime-local"> value (local timezone)
function tsToLocalInput(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const localInputToTs = (str) => new Date(str).getTime();
const fmtRest = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

const fmtDateTime = (ts) =>
  new Date(ts).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Build a live session from a program `day` object (from the user's program).
function buildSession(day, startedAt = Date.now()) {
  return {
    id: uid(),
    dayKey: day.key,
    dayName: day.name,
    focus: day.focus,
    tag: day.tag,
    startedAt,
    note: "",
    exercises: day.exercises.map((ex) => ({
      key: uid(),
      name: ex.name,
      variations: ex.variations || [],
      variation: (ex.variations && ex.variations[0]) || null,
      note: "",
      sets: Array.from({ length: Math.max(1, Number(ex.sets) || 1) }, () => ({ w: "", r: "", done: false })),
    })),
  };
}

// most recent prior logged performance of an exercise (prefer same variation)
function lastPerformance(sessions, name, variation, excludeId) {
  const sorted = [...sessions].sort((a, b) => b.startedAt - a.startedAt);
  let fallback = null;
  for (const s of sorted) {
    if (s.id === excludeId) continue;
    for (const ex of s.exercises) {
      if (ex.name !== name) continue;
      const sets = ex.sets.filter((st) => st.w !== "" || st.r !== "");
      if (!sets.length) continue;
      if (ex.variation === variation) return { date: s.startedAt, variation: ex.variation, sets };
      if (!fallback) fallback = { date: s.startedAt, variation: ex.variation, sets };
    }
  }
  return fallback;
}

const isLogged = (st) => st.w !== "" || st.r !== "";

// A proper-form tutorial search for any exercise (+ its variation). Works for
// custom exercises too since it's just a search query.
function tutorialUrl(name, variation) {
  const q = `how to ${name}${variation ? " " + variation : ""} proper form technique`;
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
}
const openTutorial = (name, variation) =>
  window.open(tutorialUrl(name, variation), "_blank", "noopener,noreferrer");

/* ----------------------- SHAREABLE WORKOUT CARD ------------------------- */
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function wrapText(ctx, text, x, y, maxW, lh) {
  const words = String(text).split(" ");
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, x, y); line = w; y += lh; }
    else line = test;
  }
  if (line) ctx.fillText(line, x, y);
  return y;
}

// Render a 1080×1080 summary image for a finished workout and share/download it.
async function shareWorkoutCard(session, stats) {
  try { await document.fonts?.ready; } catch { /* fonts optional */ }
  const S = 1080, P = 84;
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const ctx = cv.getContext("2d");

  ctx.fillStyle = "#0a0b0d"; ctx.fillRect(0, 0, S, S);
  const glow = ctx.createRadialGradient(S * 0.95, S * 0.05, 0, S * 0.95, S * 0.05, S * 0.85);
  glow.addColorStop(0, "rgba(216,255,54,0.13)"); glow.addColorStop(1, "rgba(216,255,54,0)");
  ctx.fillStyle = glow; ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = "#d8ff36"; ctx.fillRect(0, 0, 12, S);

  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#d8ff36"; ctx.font = "700 42px Oswald, sans-serif"; ctx.fillText("▚", P, P + 36);
  ctx.fillStyle = "#f2f4f5"; ctx.font = "700 42px Oswald, sans-serif"; ctx.fillText("IRONLOG", P + 60, P + 36);

  let y = P + 160;
  const tag = session.tag || "DAY";
  ctx.font = "700 26px 'Space Mono', monospace";
  const tw = ctx.measureText(tag).width;
  ctx.fillStyle = "#d8ff36"; rrect(ctx, P, y - 36, tw + 40, 50, 10); ctx.fill();
  ctx.fillStyle = "#101200"; ctx.fillText(tag, P + 20, y);
  ctx.fillStyle = "#8b9199"; ctx.font = "400 28px Archivo, sans-serif";
  ctx.fillText(fmtDate(session.startedAt), P + tw + 62, y);

  y += 96;
  ctx.fillStyle = "#f2f4f5"; ctx.font = "600 66px Oswald, sans-serif";
  y = wrapText(ctx, session.dayName, P, y, S - P * 2, 74);

  y += 70;
  const cells = [
    { n: Math.round(stats.volume).toLocaleString(), l: "lbs volume" },
    { n: stats.setCount, l: "sets" },
    { n: stats.exCount, l: "exercises" },
    { n: stats.prCount, l: stats.prCount === 1 ? "PR" : "PRs" },
  ];
  const cw = (S - P * 2 - 24) / 2, ch = 150;
  cells.forEach((c, i) => {
    const cx = P + (i % 2) * (cw + 24);
    const cy = y + Math.floor(i / 2) * (ch + 20);
    ctx.fillStyle = "#15171b"; ctx.strokeStyle = "#2a2e36"; ctx.lineWidth = 2;
    rrect(ctx, cx, cy, cw, ch, 16); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#d8ff36"; ctx.font = "700 60px 'Space Mono', monospace";
    ctx.fillText(String(c.n), cx + 28, cy + 82);
    ctx.fillStyle = "#8b9199"; ctx.font = "400 25px Archivo, sans-serif";
    ctx.fillText(c.l, cx + 28, cy + 120);
  });
  y += 2 * ch + 20;

  if (stats.topLift) {
    y += 50;
    ctx.fillStyle = "#8b9199"; ctx.font = "700 22px 'Space Mono', monospace"; ctx.fillText("TOP LIFT", P, y);
    ctx.fillStyle = "#f2f4f5"; ctx.font = "600 40px Oswald, sans-serif";
    wrapText(ctx, `${stats.topLift.name} · ${stats.topLift.e1rm} est 1RM`, P, y + 52, S - P * 2, 46);
  }

  ctx.fillStyle = "#8b9199"; ctx.font = "700 26px 'Space Mono', monospace";
  ctx.fillText("lokoto-ironlog.fly.dev", P, S - P + 10);

  const blob = await new Promise((r) => cv.toBlob(r, "image/png", 0.95));
  const file = new File([blob], "ironlog-workout.png", { type: "image/png" });
  const text = `${session.dayName} — logged on IRONLOG 💪`;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text, title: "IRONLOG" }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "ironlog-workout.png"; a.click();
  URL.revokeObjectURL(url);
}

/* ================================================================== */
/*  ROOT                                                               */
/* ================================================================== */
export default function App() {
  const [view, setView] = useState("train"); // train | calendar | history | progress
  const [user, setUser] = useState(null);          // signed-in Google user (or null)
  const [sessions, setSessions] = useState([]);
  const [program, setProgram] = useState([]);      // the user's editable program (days)
  const [onboarded, setOnboarded] = useState(true); // has the user chosen a program?
  const [profile, setProfile] = useState(null);     // body stats / goal / macro targets
  const [active, setActive] = useState(null);
  const [booting, setBooting] = useState(true);    // resolving the current session
  const [dataLoading, setDataLoading] = useState(false); // loading workouts from API
  const [syncError, setSyncError] = useState("");
  const [pendingSync, setPendingSync] = useState(0);   // workouts queued offline, waiting to upload
  const [updateReady, setUpdateReady] = useState(false); // a newer build has deployed

  // boot: ask the server who we are (reads the session cookie)
  useEffect(() => {
    (async () => {
      try {
        const u = await api.me();
        setUser(u);
      } catch {
        setUser(null);
      }
      setBooting(false);
    })();
  }, []);

  // detect new deploys: poll the server's bundle hash vs the one we're running
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    let stop = false;
    const check = async () => {
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        if (!r.ok) return;
        const { bundle } = await r.json();
        if (bundle && window.__BUILD__ && window.__BUILD__ !== "dev" && bundle !== window.__BUILD__ && !stop) {
          setUpdateReady(true);
        }
      } catch { /* offline — ignore */ }
    };
    check();
    const id = setInterval(check, 90000);
    const onVis = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop = true; clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // load the signed-in user's workouts + program whenever the user changes
  useEffect(() => {
    if (!user) { setSessions([]); setProgram([]); setProfile(null); setActive(null); setPendingSync(0); return; }
    setDataLoading(true);
    (async () => {
      try {
        // push anything logged offline last time FIRST, so the fetch below
        // already includes it; whatever still fails stays queued
        await flushOutbox(user.id, (sess) => api.createWorkout(sess));
        const [s, prog, prof] = await Promise.all([api.getWorkouts(), api.getProgram(), api.getProfile()]);
        const list = Array.isArray(s) ? s : [];
        const box = loadOutbox(user.id); // still-unsynced sessions belong in history too
        setSessions(box.length ? [...list.filter((x) => !box.some((b) => b.id === x.id)), ...box] : list);
        setPendingSync(box.length);
        setProgram(Array.isArray(prog?.days) ? prog.days : []);
        setOnboarded(!!prog?.onboarded);
        setProfile(prof || null);
      } catch {
        // fully offline: at least surface what's queued on this device
        const box = loadOutbox(user.id);
        setSessions(box);
        setPendingSync(box.length);
        setProgram([]);
        setOnboarded(true); // don't trap the user on the choice screen if the load failed
      }
      // resume any in-progress draft saved on this device for this user
      setActive(loadActiveDraft(user.id));
      setDataLoading(false);
    })();
  }, [user]);

  // retry queued workouts the moment the connection comes back (or on tap)
  const syncOutbox = useCallback(async () => {
    if (!user) return;
    const { sent, pending } = await flushOutbox(user.id, (sess) => api.createWorkout(sess));
    setPendingSync(pending);
    if (sent > 0) setSyncError("");
  }, [user]);
  useEffect(() => {
    if (!user) return;
    window.addEventListener("online", syncOutbox);
    return () => window.removeEventListener("online", syncOutbox);
  }, [user, syncOutbox]);

  // debounced persistence of the in-progress draft (local only, per user)
  const activeTimer = useRef(null);
  useEffect(() => {
    if (!user || dataLoading) return;
    if (activeTimer.current) clearTimeout(activeTimer.current);
    activeTimer.current = setTimeout(() => {
      if (active) saveActiveDraft(user.id, active);
      else clearActiveDraft(user.id);
    }, 600);
    return () => activeTimer.current && clearTimeout(activeTimer.current);
  }, [active, dataLoading, user]);

  /* ---- auth actions ---- */
  const onLogin = (u) => setUser(u);
  const logout = async () => {
    try { await api.logout(); } catch {}
    if (user) clearActiveDraft(user.id);
    setActive(null);
    setSessions([]);
    setProgram([]);
    setProfile(null);
    setOnboarded(true);
    setUser(null);
    setView("train");
  };

  const saveProfile = async (p) => {
    setProfile(p);                       // optimistic
    try { setProfile(await api.saveProfile(p)); }
    catch { setSyncError("Couldn't save your profile — please try again."); }
  };

  const restartOnboarding = async () => {
    try {
      await api.restartOnboarding();     // clears the program row -> onboarded:false
      setProgram([]);
      setActive(null);
      setOnboarded(false);               // re-shows the setup wizard
      setView("train");
    } catch {
      setSyncError("Couldn't restart onboarding — please try again.");
    }
  };

  /* ---- onboarding: new user picks a starting program ---- */
  const chooseDefaultProgram = async () => {
    const days = await api.resetProgram();        // seeds the default 4-day split
    setProgram(Array.isArray(days) ? days : []);
    setOnboarded(true);
    setView("train");
  };
  const chooseBuildOwn = async () => {
    const starter = [{ key: uid(), name: "Day 1", focus: "", tag: "D1", color: DAY_PALETTE[0], exercises: [] }];
    const days = await api.saveProgram(starter);  // create a program row -> onboarded
    setProgram(Array.isArray(days) ? days : starter);
    setOnboarded(true);
    setView("program");                            // drop them straight into the editor
  };

  /* ---- program editing (debounced save to the server) ---- */
  const programTimer = useRef(null);
  const updateProgram = useCallback((days) => {
    setProgram(days);
    if (programTimer.current) clearTimeout(programTimer.current);
    programTimer.current = setTimeout(() => {
      api.saveProgram(days).catch(() => setSyncError("Couldn't save program changes — they'll retry on next edit."));
    }, 700);
  }, []);
  const resetProgram = async () => {
    try {
      const days = await api.resetProgram();
      setProgram(Array.isArray(days) ? days : []);
      setSyncError("");
    } catch {
      setSyncError("Couldn't reset the program — please try again.");
    }
  };

  const startWorkout = (day, startedAt) => setActive(buildSession(day, startedAt));
  const cancelWorkout = () => { setActive(null); if (user) clearActiveDraft(user.id); };
  // Re-open a finished workout in the editor to fix sets/reps/weights/date.
  const editWorkout = (session) => { setActive({ ...structuredClone(session), _editing: true }); };

  const finishWorkout = async () => {
    const editing = !!active._editing;
    const cleaned = {
      ...active,
      // keep the original finish time when editing; for a backdated (missed)
      // session finish ~45 min after the start; otherwise stamp it now
      finishedAt: active.finishedAt ||
        (active.startedAt && active.startedAt < Date.now() - 6 * 3600000
          ? active.startedAt + 45 * 60000
          : Date.now()),
      exercises: active.exercises
        .map((ex) => ({ ...ex, sets: ex.sets.filter(isLogged) }))
        .filter((ex) => ex.sets.length > 0),
    };
    delete cleaned._editing;
    if (cleaned.exercises.length === 0) { cancelWorkout(); return; }
    // optimistic: update in place if editing, else append; clear draft, then sync
    const exists = sessions.some((s) => s.id === cleaned.id);
    setSessions((prev) => (editing || exists)
      ? prev.map((s) => (s.id === cleaned.id ? cleaned : s))
      : [...prev, cleaned]);
    if (user) clearActiveDraft(user.id);
    setActive(null);
    setView("history");
    setSyncError("");
    try {
      await api.createWorkout(cleaned); // server upserts by client id (edit or new)
      syncOutbox();                     // let any older queued workouts ride along
    } catch {
      // offline / server hiccup: queue it durably and upload later — nothing is lost
      if (user) setPendingSync(queueWorkout(user.id, cleaned));
      else setSyncError("Couldn't save to the server — it'll stay until you retry or reload.");
    }
  };

  const deleteSession = async (id) => {
    const prev = sessions;
    setSessions(prev.filter((s) => s.id !== id)); // optimistic
    if (user) setPendingSync(removeFromOutbox(user.id, id)); // if it was queued, forget it
    try {
      await api.deleteWorkout(id);
    } catch (e) {
      if (e?.status === 404) return; // it never reached the server — nothing to delete there
      setSessions(prev); // roll back on failure
      setSyncError("Couldn't delete that workout — please try again.");
    }
  };

  const importSessions = async (incoming) => {
    if (!Array.isArray(incoming)) throw new Error("bad file");
    const added = await api.importWorkouts(incoming);   // server merges by client id
    const fresh = await api.getWorkouts();              // re-pull the merged result
    setSessions(Array.isArray(fresh) ? fresh : []);
    return added;
  };

  if (booting) {
    return (
      <div className="wt-root">
        <FontsAndStyles /><div className="grain" />
        <div className="loader"><Dumbbell size={28} /><span>Loading…</span></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="wt-root">
        <FontsAndStyles /><div className="grain" />
        <Landing onLogin={onLogin} />
      </div>
    );
  }

  if (!dataLoading && !onboarded) {
    return (
      <div className="wt-root">
        <FontsAndStyles /><div className="grain" />
        <Onboarding user={user} profile={profile} onSaveProfile={saveProfile} onUseDefault={chooseDefaultProgram} onBuildOwn={chooseBuildOwn} />
      </div>
    );
  }

  return (
    <div className="wt-root">
      <FontsAndStyles />
      <div className="grain" />

      {updateReady && (
        <button className="update-banner" onClick={() => window.location.reload()}>
          <RotateCcw size={14} /> New version available — tap to update
        </button>
      )}

      {user.demo && (
        <div className="demo-banner">
          You're in a demo account with sample data — it resets after 24 hours.
        </div>
      )}

      {dataLoading ? (
        <div className="loader"><Dumbbell size={28} /><span>Loading your log…</span></div>
      ) : active ? (
        <ActiveSession
          active={active}
          setActive={setActive}
          sessions={sessions}
          onFinish={finishWorkout}
          onCancel={cancelWorkout}
        />
      ) : (
        <>
          <header className="topbar">
            <div className="brand">
              <span className="brand-mark">▚</span>
              <div>
                <h1>IRONLOG</h1>
                <p>4-Day Push / Pull · Failure Protocol</p>
              </div>
            </div>
            <button className="profile-chip" onClick={() => setView("profile")} title="Profile & goals">
              {user.picture
                ? <img className="avatar avatar-img" src={user.picture} alt="" referrerPolicy="no-referrer" />
                : <span className="avatar">{(user.name || "?").slice(0, 1).toUpperCase()}</span>}
              <span className="profile-name">{user.name}</span>
              <ChevronRight size={15} />
            </button>
          </header>

          {syncError && <div className="sync-error" onClick={() => setSyncError("")}>{syncError}</div>}
          {pendingSync > 0 && (
            <div className="sync-pending" onClick={syncOutbox} role="button" title="Tap to retry now">
              <WifiOff size={13} /> {pendingSync} workout{pendingSync > 1 ? "s" : ""} saved on this device — will
              upload when you're back online. Tap to retry.
            </div>
          )}

          <main className="content">
            {view === "train" && <TrainView sessions={sessions} program={program} onStart={startWorkout} onEditProgram={() => setView("program")} />}
            {view === "meal" && <MealView profile={profile} sessions={sessions} onGoProfile={() => setView("profile")} />}
            {view === "calendar" && <CalendarView sessions={sessions} program={program} />}
            {view === "history" && <HistoryView sessions={sessions} onDelete={deleteSession} onEdit={editWorkout} onImport={importSessions} />}
            {view === "progress" && <ProgressView sessions={sessions} />}
            {view === "program" && <ProgramView program={program} onChange={updateProgram} onReset={resetProgram} />}
            {view === "profile" && <ProfileView profile={profile} onSave={saveProfile} onBack={() => setView("train")} onLogout={logout} onRestartOnboarding={restartOnboarding} />}
          </main>

          <nav className="tabbar">
            <TabBtn active={view === "train"} onClick={() => setView("train")} icon={<Dumbbell size={20} />} label="Train" />
            <TabBtn active={view === "meal"} onClick={() => setView("meal")} icon={<UtensilsCrossed size={20} />} label="Meals" />
            <TabBtn active={view === "program"} onClick={() => setView("program")} icon={<ListChecks size={20} />} label="Program" />
            <TabBtn active={view === "calendar"} onClick={() => setView("calendar")} icon={<CalendarDays size={20} />} label="Calendar" />
            <TabBtn active={view === "history"} onClick={() => setView("history")} icon={<History size={20} />} label="History" />
            <TabBtn active={view === "progress"} onClick={() => setView("progress")} icon={<TrendingUp size={20} />} label="Progress" />
          </nav>
        </>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, icon, label }) {
  return (
    <button className={`tab ${active ? "tab-on" : ""}`} onClick={onClick}>
      {icon}<span>{label}</span>
    </button>
  );
}

/* ================================================================== */
/*  GOOGLE SIGN-IN  (GIS — accounts.google.com/gsi/client)             */
/* ================================================================== */
function GoogleSignIn({ onLogin }) {
  const btnRef = useRef(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

  useEffect(() => {
    if (!clientId) {
      setErr("Missing VITE_GOOGLE_CLIENT_ID — add it to your .env (see README).");
      return;
    }

    let cancelled = false;

    const handleCredential = async (response) => {
      setBusy(true);
      setErr("");
      try {
        const user = await api.googleLogin(response.credential);
        if (!cancelled) onLogin(user);
      } catch {
        if (!cancelled) { setErr("Sign-in failed. Please try again."); setBusy(false); }
      }
    };

    // The GIS script loads async (see index.html); poll briefly until it's ready.
    let tries = 0;
    const init = () => {
      if (cancelled) return;
      const gid = window.google?.accounts?.id;
      if (!gid) {
        if (tries++ > 60) { setErr("Couldn't load Google sign-in. Check your connection."); return; }
        setTimeout(init, 100);
        return;
      }
      gid.initialize({
        client_id: clientId,
        callback: handleCredential,
        use_fedcm_for_prompt: true, // FedCM is mandatory in 2026
        auto_select: false,
      });
      if (btnRef.current) {
        gid.renderButton(btnRef.current, {
          type: "standard",
          theme: "filled_black",
          size: "large",
          shape: "pill",
          text: "continue_with",
          logo_alignment: "left",
          width: 280,
        });
      }
      gid.prompt(); // also surface the One Tap / FedCM prompt
    };
    init();

    return () => { cancelled = true; };
  }, [clientId, onLogin]);

  return (
    <div className="signin">
      <div ref={btnRef} className="gbtn-wrap" />
      {busy && <div className="login-note" style={{ marginTop: 4 }}>Signing you in…</div>}
      {err && <div className="login-err">{err}</div>}
    </div>
  );
}

// "Try the demo" — creates a throwaway, pre-seeded account (no Google needed).
function DemoButton({ onLogin }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    setBusy(true); setErr("");
    try {
      onLogin(await api.demoLogin());
    } catch {
      setErr("Couldn't start the demo — please try again.");
      setBusy(false);
    }
  };
  return (
    <div className="demo-cta">
      <button className="demo-btn" onClick={go} disabled={busy}>
        <Play size={14} /> {busy ? "Setting up your demo…" : "Try the demo — no sign-in"}
      </button>
      {err && <div className="login-err">{err}</div>}
    </div>
  );
}

/* ================================================================== */
/*  LANDING  (marketing page for logged-out visitors)                  */
/* ================================================================== */
const LANDING_FEATURES = [
  { icon: <Dumbbell size={22} />, title: "Train smarter", text: "Editable programs, set logging, a rest timer, PRs and estimated 1RM — plus in-app form guides for every lift." },
  { icon: <UtensilsCrossed size={22} />, title: "Track macros", text: "Search a huge food database or scan a barcode. Calories & macros vs your goal, organized by breakfast / lunch / dinner." },
  { icon: <TrendingUp size={22} />, title: "See progress", text: "Strength trends per lift, a body-weight chart, a training calendar, and streaks that keep you coming back." },
  { icon: <Target size={22} />, title: "Hit your goal", text: "Tell it your stats and goal — lose fat, bulk or maintain — and it sets your daily calorie & macro targets automatically." },
];

function Landing({ onLogin }) {
  return (
    <div className="landing fade-in">
      <header className="lp-hero">
        <span className="brand-mark big">▚</span>
        <h1>IRONLOG</h1>
        <p className="lp-tag">Your gym and your kitchen, in one app.</p>
        <p className="lp-sub">Log workouts, track macros, and watch your strength and weight trend — free, on every device.</p>
        <div className="lp-cta"><GoogleSignIn onLogin={onLogin} /></div>
        <DemoButton onLogin={onLogin} />
        <p className="login-note" style={{ maxWidth: 320 }}>Sign in with Google — we only use it to identify your account. Your data is private and synced across your devices.</p>
      </header>

      <div className="lp-features">
        {LANDING_FEATURES.map((f) => (
          <div className="lp-card" key={f.title}>
            <span className="lp-ico">{f.icon}</span>
            <h3>{f.title}</h3>
            <p>{f.text}</p>
          </div>
        ))}
      </div>

      <div className="lp-strip">
        <span><ScanLine size={14} /> Barcode scanning</span>
        <span><BookOpen size={14} /> Saved meals</span>
        <span><Trophy size={14} /> PRs & 1RM</span>
        <span><CalendarDays size={14} /> Streaks</span>
      </div>

      <p className="lp-foot">Install it to your home screen for a full-screen, offline-ready app.</p>
    </div>
  );
}

/* ================================================================== */
/*  ONBOARDING  (new user picks a starting program)                   */
/* ================================================================== */
function Onboarding({ user, profile, onSaveProfile, onUseDefault, onBuildOwn }) {
  const init = profile || {};
  const profileDone = !!(init.heightIn && init.weightLbs && init.targets);
  const [step, setStep] = useState(profileDone ? "program" : "stats");
  const [p, setP] = useState({
    sex: init.sex || "male",
    age: init.age ?? "",
    heightFt: init.heightIn != null ? Math.floor(init.heightIn / 12) : "",
    heightIn: init.heightIn != null ? init.heightIn % 12 : "",
    weightLbs: init.weightLbs ?? "",
    activity: init.activity || "moderate",
    goal: init.goal || "lose_fat",
  });
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState("");

  const firstName = (user?.name || "").split(" ")[0];
  const heightIn = (Number(p.heightFt) || 0) * 12 + (Number(p.heightIn) || 0);
  const computed = computeTargets({ ...p, heightIn });
  const ready = p.sex && Number(p.age) > 0 && heightIn > 0 && Number(p.weightLbs) > 0 && p.goal;
  const set = (k, v) => { setP((o) => ({ ...o, [k]: v })); setErr(""); };

  const continueToProgram = async () => {
    if (!ready) { setErr("Please fill in your age, height, weight and goal."); return; }
    setSaving(true); setErr("");
    try {
      await onSaveProfile({
        sex: p.sex, age: Number(p.age), heightIn, weightLbs: Number(p.weightLbs),
        activity: p.activity, goal: p.goal, custom: false, targets: computed,
      });
      api.logWeight(localDayStr(), Number(p.weightLbs)).catch(() => {}); // start the trend
      setStep("program");
    } catch {
      setErr("Couldn't save — please try again.");
    }
    setSaving(false);
  };

  const pick = async (which, fn) => {
    setBusy(which); setErr("");
    try { await fn(); }
    catch { setErr("Something went wrong — please try again."); setBusy(null); }
  };

  if (step === "stats") {
    return (
      <div className="login fade-in">
        <div className="login-brand">
          <span className="brand-mark big">▚</span>
          <h1>IRONLOG</h1>
          <p>{firstName ? `Welcome, ${firstName}` : "Welcome"} — tell us about you</p>
        </div>

        <div className="login-form">
          <div className="seg">
            {["male", "female"].map((s) => (
              <button key={s} className={p.sex === s ? "seg-on" : ""} onClick={() => set("sex", s)}>{s === "male" ? "Male" : "Female"}</button>
            ))}
          </div>

          <div className="prof-grid">
            <div>
              <label className="field-label">Age</label>
              <input className="login-input" inputMode="numeric" value={p.age} onChange={(e) => set("age", e.target.value.replace(/[^\d]/g, ""))} />
            </div>
            <div>
              <label className="field-label">Weight (lbs)</label>
              <input className="login-input" inputMode="decimal" value={p.weightLbs} onChange={(e) => set("weightLbs", e.target.value.replace(/[^\d.]/g, ""))} />
            </div>
            <div>
              <label className="field-label">Height (ft)</label>
              <input className="login-input" inputMode="numeric" value={p.heightFt} onChange={(e) => set("heightFt", e.target.value.replace(/[^\d]/g, ""))} />
            </div>
            <div>
              <label className="field-label">Height (in)</label>
              <input className="login-input" inputMode="numeric" value={p.heightIn} onChange={(e) => set("heightIn", e.target.value.replace(/[^\d]/g, ""))} />
            </div>
          </div>

          <label className="field-label" style={{ marginTop: 4 }}>Activity level</label>
          <select className="ex-select" value={p.activity} onChange={(e) => set("activity", e.target.value)} style={{ marginBottom: 0 }}>
            {Object.entries(ACTIVITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>

          <label className="field-label" style={{ marginTop: 4 }}>Your goal</label>
          <div className="goal-grid">
            {Object.entries(GOALS).map(([k, v]) => (
              <button key={k} className={`goal-pill ${p.goal === k ? "goal-on" : ""}`} onClick={() => set("goal", k)}>{v.label}</button>
            ))}
          </div>

          {computed && (
            <div className="onb-targets">
              <span>Daily target</span>
              <strong>{computed.calories} kcal</strong>
              <em>P {computed.protein} · C {computed.carbs} · F {computed.fat}</em>
            </div>
          )}

          {err && <div className="login-err">{err}</div>}
          <button className="login-go" onClick={continueToProgram} disabled={saving}>{saving ? "Saving…" : "Continue →"}</button>
          <p className="login-note">This sets your daily calorie &amp; macro targets. You can change it anytime in your profile.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="login fade-in">
      <div className="login-brand">
        <span className="brand-mark big">▚</span>
        <h1>IRONLOG</h1>
        <p>Now pick your program</p>
      </div>

      <div className="onb-cards">
        <button className="onb-card" disabled={!!busy} onClick={() => pick("default", onUseDefault)}>
          <span className="onb-tag">Recommended</span>
          <Dumbbell size={26} />
          <h3>Use the default program</h3>
          <p>Start with the ready-made 4-day Push / Pull split. You can tweak it anytime.</p>
          <span className="onb-go">{busy === "default" ? "Setting up…" : "Use default →"}</span>
        </button>

        <button className="onb-card" disabled={!!busy} onClick={() => pick("own", onBuildOwn)}>
          <ListChecks size={26} />
          <h3>Build my own program</h3>
          <p>Start from a blank day and add your own exercises, sets, and variations.</p>
          <span className="onb-go">{busy === "own" ? "Creating…" : "Build my own →"}</span>
        </button>
      </div>

      <button className="login-back" style={{ width: "100%", marginTop: 12 }} onClick={() => setStep("stats")}>← Back to your details</button>
      {err && <div className="login-err" style={{ marginTop: 14 }}>{err}</div>}
      <p className="login-note">You can switch to the default or rebuild your program later from the Program tab.</p>
    </div>
  );
}

/* ================================================================== */
/*  TRAIN VIEW                                                         */
/* ================================================================== */
function TrainView({ sessions, program, onStart, onEditProgram }) {
  const [pastOpen, setPastOpen] = useState(false);
  const [pastDate, setPastDate] = useState(() => localDayStr());
  const [pastDayKey, setPastDayKey] = useState("");

  const lastByDay = {};
  for (const s of sessions) {
    if (!lastByDay[s.dayKey] || s.startedAt > lastByDay[s.dayKey]) lastByDay[s.dayKey] = s.startedAt;
  }
  const days = program || [];

  // Start logging a session for a past date (a workout you forgot to log).
  const startPast = () => {
    const day = days.find((d) => d.key === pastDayKey) || days[0];
    if (!day) return;
    const [y, m, d] = pastDate.split("-").map(Number);
    const ts = new Date(y, m - 1, d, 12, 0, 0).getTime();
    setPastOpen(false);
    onStart(day, ts);
  };

  if (!days.length) {
    return (
      <div className="fade-in">
        <div className="empty">
          <ListChecks size={40} />
          <h3>No workout days yet</h3>
          <p>Build your program — add days and exercises — then come back here to train.</p>
          <button className="login-go" style={{ marginTop: 18, padding: "12px 20px" }} onClick={onEditProgram}>
            <Pencil size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} /> Edit program
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div className="train-head">
        <div className="section-label" style={{ margin: 0 }}>Choose today's session</div>
        <button className="edit-prog-btn" onClick={onEditProgram}><Pencil size={13} /> Edit</button>
      </div>
      <div className="day-grid">
        {days.map((day, i) => (
          <button
            key={day.key}
            className="day-card"
            style={{ animationDelay: `${i * 60}ms`, ["--day-accent"]: day.color || "var(--accent)" }}
            onClick={() => onStart(day)}
          >
            <div className="day-card-top">
              <span className="day-tag" style={{ background: day.color || "var(--accent)" }}>{day.tag || "DAY"}</span>
              {lastByDay[day.key] && <span className="day-last">last {fmtShort(lastByDay[day.key])}</span>}
            </div>
            <h2 className="day-name">{day.name}</h2>
            {day.focus && <p className="day-focus"><Flame size={13} /> {day.focus}</p>}
            <div className="day-meta">{day.exercises.length} exercise{day.exercises.length === 1 ? "" : "s"}</div>
            <div className="day-go"><Play size={15} fill="currentColor" /> Start</div>
          </button>
        ))}
      </div>

      <button className="log-past-btn" onClick={() => { setPastDayKey(days[0]?.key || ""); setPastOpen(true); }}>
        <CalendarDays size={15} /> Log a past workout
      </button>

      <p className="footnote">
        Your program and history sync to your account. Pick your equipment variation while logging each lift.
      </p>

      {pastOpen && (
        <div className="modal-bg" onClick={() => setPastOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Log a past workout</h3>
            <p style={{ margin: "8px 0 14px" }}>Pick the day it happened and which session, then fill in your sets.</p>
            <label className="field-label">Date</label>
            <input className="login-input" type="date" max={localDayStr()} value={pastDate}
              onChange={(e) => setPastDate(e.target.value)} />
            <label className="field-label" style={{ marginTop: 12 }}>Session</label>
            <select className="login-input" value={pastDayKey} onChange={(e) => setPastDayKey(e.target.value)}>
              {days.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
            </select>
            <div className="modal-btns" style={{ marginTop: 18 }}>
              <button className="btn-ghost" onClick={() => setPastOpen(false)}>Cancel</button>
              <button className="login-go" style={{ flex: 1, margin: 0 }} onClick={startPast}>Start logging</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/*  CALENDAR VIEW                                                      */
/* ================================================================== */
const dateKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const todayKey = () => dateKey(Date.now());

function CalendarView({ sessions, program }) {
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [picked, setPicked] = useState(null);

  // map dateKey -> array of sessions that day
  const byDate = {};
  for (const s of sessions) {
    const k = dateKey(s.startedAt);
    (byDate[k] = byDate[k] || []).push(s);
  }

  const firstDow = new Date(cursor.y, cursor.m, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const monthName = new Date(cursor.y, cursor.m, 1)
    .toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const monthSessions = sessions.filter((s) => {
    const d = new Date(s.startedAt);
    return d.getFullYear() === cursor.y && d.getMonth() === cursor.m;
  });

  // current training streak (consecutive days with a workout, counting back from today)
  let streak = 0;
  const cur = new Date(); cur.setHours(0, 0, 0, 0);
  if (!byDate[dateKey(cur.getTime())]) cur.setDate(cur.getDate() - 1); // allow "yesterday" start
  while (byDate[dateKey(cur.getTime())]) { streak++; cur.setDate(cur.getDate() - 1); }

  const go = (delta) => {
    setPicked(null);
    setCursor((c) => {
      const m = c.m + delta;
      return { y: c.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 };
    });
  };

  const pickedSessions = picked ? byDate[picked] || [] : [];

  return (
    <div className="fade-in">
      <div className="cal-stats">
        <div className="stat"><span className="stat-n">{sessions.length}</span><span className="stat-l">total</span></div>
        <div className="stat"><span className="stat-n">{monthSessions.length}</span><span className="stat-l">this month</span></div>
        <div className="stat"><span className="stat-n">{streak}</span><span className="stat-l">day streak</span></div>
      </div>

      <div className="cal-card">
        <div className="cal-nav">
          <button className="icon-btn sm" onClick={() => go(-1)}><ChevronLeft size={18} /></button>
          <h3>{monthName}</h3>
          <button className="icon-btn sm" onClick={() => go(1)}><ChevronRight size={18} /></button>
        </div>

        <div className="cal-grid cal-dow">
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <span key={i}>{d}</span>)}
        </div>

        <div className="cal-grid">
          {cells.map((d, i) => {
            if (d === null) return <span key={i} className="cal-cell empty-cell" />;
            const k = `${cursor.y}-${cursor.m}-${d}`;
            const ss = byDate[k];
            const isToday = k === todayKey();
            return (
              <button
                key={i}
                className={`cal-cell ${ss ? "has" : ""} ${isToday ? "today" : ""} ${picked === k ? "sel" : ""}`}
                onClick={() => ss && setPicked(picked === k ? null : k)}
              >
                <span className="cal-num">{d}</span>
                {ss && (
                  <span className="cal-dots">
                    {ss.slice(0, 3).map((s, j) => (
                      <i key={j} style={{ background: colorForDayKey(s.dayKey, program) }} />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="cal-legend">
        {(program || []).map((day) => (
          <span key={day.key} className="leg-item">
            <i style={{ background: day.color || "var(--accent)" }} />{day.tag || "DAY"}
          </span>
        ))}
      </div>

      {picked && pickedSessions.length > 0 && (
        <div className="cal-detail fade-in">
          <div className="section-label" style={{ margin: "4px 4px 10px" }}>{fmtDate(pickedSessions[0].startedAt)}</div>
          {pickedSessions.map((s) => {
            const setCount = s.exercises.reduce((n, e) => n + e.sets.length, 0);
            return (
              <div className="cal-detail-row" key={s.id}>
                <span className="day-tag sm" style={{ background: colorForDayKey(s.dayKey, program), color: "#101200" }}>{s.tag}</span>
                <div>
                  <strong>{s.dayName}</strong>
                  <p>{s.exercises.length} exercises · {setCount} sets</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!sessions.length && (
        <p className="footnote">Your training days will light up here once you finish a workout.</p>
      )}
    </div>
  );
}

/* ================================================================== */
/*  ACTIVE SESSION                                                     */
/* ================================================================== */
function ActiveSession({ active, setActive, sessions, onFinish, onCancel }) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [restSignal, setRestSignal] = useState(0);
  const [help, setHelp] = useState(null); // { name, variation } for the form-guide modal
  const [plateTarget, setPlateTarget] = useState(null); // pre-fill weight for the plate calc sheet
  const editing = !!active._editing; // re-opened from History to fix a past workout

  // Keep the screen awake during a workout — phones otherwise lock mid-set.
  // Re-acquire when the tab becomes visible again (the OS silently releases
  // the lock on background); no-op where the API isn't supported.
  useEffect(() => {
    let lock = null, alive = true;
    const acquire = async () => {
      try {
        if (alive && navigator.wakeLock && document.visibilityState === "visible") {
          lock = await navigator.wakeLock.request("screen");
        }
      } catch { /* low battery / unsupported — not worth surfacing */ }
    };
    const onVisible = () => { if (document.visibilityState === "visible") acquire(); };
    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      try { lock?.release(); } catch {}
    };
  }, []);

  const update = (mut) => setActive((prev) => {
    const copy = structuredClone(prev);
    mut(copy);
    return copy;
  });

  const setVariation = (exKey, v) => update((s) => {
    const ex = s.exercises.find((e) => e.key === exKey); ex.variation = v;
  });
  const setField = (exKey, idx, field, val) => update((s) => {
    const ex = s.exercises.find((e) => e.key === exKey); ex.sets[idx][field] = val;
  });
  const toggleDone = (exKey, idx) => {
    const ex = active.exercises.find((e) => e.key === exKey);
    const willBeDone = !ex.sets[idx].done;
    update((s) => {
      const e2 = s.exercises.find((e) => e.key === exKey);
      const set = e2.sets[idx];
      set.done = willBeDone;
      if (willBeDone) {
        set.doneAt = Date.now();
        // rest taken = time since the previous completed set in this exercise
        const prev = e2.sets[idx - 1];
        if (prev && prev.doneAt) set.restBefore = Math.round((set.doneAt - prev.doneAt) / 1000);
      } else {
        delete set.doneAt; delete set.restBefore;
      }
    });
    if (willBeDone) setRestSignal((n) => n + 1); // fires the auto rest timer
  };
  const addSet = (exKey) => update((s) => {
    const ex = s.exercises.find((e) => e.key === exKey);
    const last = ex.sets[ex.sets.length - 1];
    ex.sets.push({ w: last ? last.w : "", r: "", done: false });
  });
  const removeSet = (exKey, idx) => update((s) => {
    const ex = s.exercises.find((e) => e.key === exKey); ex.sets.splice(idx, 1);
  });
  const setDate = (val) => update((s) => { if (val) s.startedAt = localInputToTs(val); });
  const setNote = (val) => update((s) => { s.note = val; });
  const setExNote = (exKey, val) => update((s) => { const ex = s.exercises.find((e) => e.key === exKey); ex.note = val; });

  const totalSets = active.exercises.reduce((n, e) => n + e.sets.length, 0);
  const doneSets = active.exercises.reduce((n, e) => n + e.sets.filter((x) => x.done).length, 0);
  const pct = totalSets ? Math.round((doneSets / totalSets) * 100) : 0;

  return (
    <div className="session">
      <header className="session-head">
        <button className="icon-btn" onClick={() => setConfirmCancel(true)}><ChevronLeft size={22} /></button>
        <div className="session-title">
          <span className="day-tag sm">{active.tag}</span>
          <div>
            <h2>{active.dayName}</h2>
            <p>{active.focus}</p>
          </div>
        </div>
        <RestTimer autoSignal={restSignal} />
      </header>

      <div className="progress-wrap">
        <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
        <span className="progress-txt">{doneSets}/{totalSets} sets</span>
      </div>

      <div className="date-row">
        <label className="date-field">
          <CalendarDays size={16} />
          <span className="date-text">{fmtDateTime(active.startedAt)}</span>
          <input
            type="datetime-local"
            className="date-input"
            value={tsToLocalInput(active.startedAt)}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      </div>

      <div className="note-row">
        <textarea
          className="session-note" rows={2}
          placeholder="Session notes — how it felt, energy, injuries…"
          value={active.note || ""}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <main className="session-body">
        {active.exercises.map((ex, ei) => {
          const last = lastPerformance(sessions, ex.name, ex.variation, active.id);
          const curBest = bestSetE1rm(ex.sets);
          const histBest = historicalBestE1rm(sessions, ex.name, ex.variation, active.id);
          const isPR = curBest > 0 && curBest > histBest;
          return (
            <div className="ex-card fade-in" key={ex.key} style={{ animationDelay: `${ei * 30}ms` }}>
              <div className="ex-head">
                <span className="ex-num">{String(ei + 1).padStart(2, "0")}</span>
                <h3>{ex.name}</h3>
                {isPR && <span className="pr-badge"><Trophy size={11} /> PR</span>}
                <button className="howto-btn" onClick={() => setHelp({ name: ex.name, variation: ex.variation })} title="How to perform this exercise">
                  <PlayCircle size={13} /> How-to
                </button>
                <button
                  className="howto-btn"
                  title="Plate loading for this weight"
                  onClick={() => {
                    // pre-fill from the working weight: last set with one entered,
                    // else what was lifted last time
                    const cur = [...ex.sets].reverse().find((st) => st.w !== "")?.w;
                    const prev = last && [...last.sets].reverse().find((st) => st.w !== "")?.w;
                    setPlateTarget({ value: cur ?? prev ?? "" });
                  }}
                >
                  <Disc size={13} /> Plates
                </button>
              </div>

              {ex.variations.length > 0 && (
                <div className="var-row">
                  {ex.variations.map((v) => (
                    <button
                      key={v}
                      className={`var-pill ${ex.variation === v ? "var-on" : ""}`}
                      onClick={() => setVariation(ex.key, v)}
                    >{v}</button>
                  ))}
                </div>
              )}

              {last && (
                <div className="last-ref">
                  <span className="last-label">Last · {fmtShort(last.date)}{last.variation && last.variation !== ex.variation ? ` (${last.variation})` : ""}</span>
                  <span className="last-sets">
                    {last.sets.map((st, i) => (
                      <span key={i} className="last-chip">{st.w || "–"}<i>×</i>{st.r || "–"}</span>
                    ))}
                  </span>
                </div>
              )}

              <div className="sets">
                <div className="set-row set-header">
                  <span>Set</span><span>Weight</span><span>Reps</span><span></span>
                </div>
                {ex.sets.map((st, si) => (
                  <React.Fragment key={si}>
                    {st.restBefore != null && (
                      <div className="rest-log"><Timer size={11} /> rested {fmtRest(st.restBefore)}</div>
                    )}
                    <div className={`set-row ${st.done ? "set-done" : ""}`}>
                      <span className="set-idx">{si + 1}</span>
                      <input
                        className="set-input" inputMode="decimal" placeholder="lbs" enterKeyHint="done"
                        value={st.w} onChange={(e) => setField(ex.key, si, "w", e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                      />
                      <input
                        className="set-input" inputMode="numeric" placeholder="reps" enterKeyHint="done"
                        value={st.r} onChange={(e) => setField(ex.key, si, "r", e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                      />
                      <div className="set-actions">
                        <button
                          className={`check ${st.done ? "check-on" : ""}`}
                          onClick={() => toggleDone(ex.key, si)}
                          aria-label="mark set done"
                        ><Check size={16} /></button>
                        {ex.sets.length > 1 && (
                          <button className="del-set" onClick={() => removeSet(ex.key, si)} aria-label="remove set">
                            <X size={15} />
                          </button>
                        )}
                      </div>
                    </div>
                  </React.Fragment>
                ))}
              </div>

              <button className="add-set" onClick={() => addSet(ex.key)}>
                <Plus size={15} /> Add set
              </button>

              <input
                className="ex-note"
                placeholder="＋ note (form cue, pain, tempo…)"
                value={ex.note || ""}
                onChange={(e) => setExNote(ex.key, e.target.value)}
              />
            </div>
          );
        })}
        <div style={{ height: 96 }} />
      </main>

      <div className="finish-bar">
        <button className="finish-btn" onClick={onFinish}>
          {editing ? "Save Changes" : "Finish & Save Workout"}
        </button>
      </div>

      {confirmCancel && (
        <div className="modal-bg" onClick={() => setConfirmCancel(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editing ? "Discard changes?" : "Leave this workout?"}</h3>
            <p>{editing ? "Your edits won't be saved — the workout stays as it was." : "Your progress so far won't be saved to history."}</p>
            <div className="modal-btns">
              <button className="btn-ghost" onClick={() => setConfirmCancel(false)}>{editing ? "Keep editing" : "Keep training"}</button>
              <button className="btn-danger" onClick={onCancel}>Discard</button>
            </div>
          </div>
        </div>
      )}

      {help && <ExerciseHelp name={help.name} variation={help.variation} onClose={() => setHelp(null)} />}
      {plateTarget && <PlateCalc initialTarget={plateTarget.value} onClose={() => setPlateTarget(null)} />}
    </div>
  );
}

/* --------------------------- EXERCISE GUIDE ----------------------- */
// Alternates the two demo photos (start/end position) to mimic the movement.
function ExerciseImages({ images }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!images || images.length < 2) return;
    const id = setInterval(() => setI((v) => (v + 1) % images.length), 1100);
    return () => clearInterval(id);
  }, [images]);
  if (!images || !images.length) return null;
  return (
    <div className="help-img-wrap">
      <img className="help-img" src={images[i]} alt="" loading="lazy" referrerPolicy="no-referrer" />
    </div>
  );
}

function ExerciseHelp({ name, variation, onClose }) {
  const [loading, setLoading] = useState(true);
  const [match, setMatch] = useState(null);

  useEffect(() => {
    let on = true;
    setLoading(true);
    api.lookupExercise(name, variation)
      .then((m) => { if (on) { setMatch(m); setLoading(false); } })
      .catch(() => { if (on) { setMatch(null); setLoading(false); } });
    return () => { on = false; };
  }, [name, variation]);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="food-head">
          <h3>{name}{variation ? ` · ${variation}` : ""}</h3>
          <button className="icon-btn sm" onClick={onClose}><X size={18} /></button>
        </div>

        {loading ? (
          <p className="chart-hint" style={{ padding: 36 }}>Loading guide…</p>
        ) : match ? (
          <div className="help-body">
            <ExerciseImages images={match.images} />
            {match.primaryMuscles?.length > 0 && (
              <p className="help-muscles"><Flame size={12} /> Targets: {match.primaryMuscles.join(", ")}</p>
            )}
            <ol className="help-steps">
              {match.instructions.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            {match.name.toLowerCase() !== name.toLowerCase() && (
              <p className="help-note">Form guide shown for <strong>{match.name}</strong> — the closest match.</p>
            )}
          </div>
        ) : (
          <p className="help-empty">No in-app guide for this exercise yet — use the video search below.</p>
        )}

        <a className="howto-video" href={tutorialUrl(name, variation)} target="_blank" rel="noopener noreferrer">
          <PlayCircle size={15} /> Watch form videos on YouTube
        </a>
      </div>
    </div>
  );
}

/* ------------------------------- REST TIMER ----------------------- */
const REST_PREFS_KEY = "ironlog.restPrefs";
const loadRestPrefs = () => { try { return JSON.parse(localStorage.getItem(REST_PREFS_KEY)) || {}; } catch { return {}; } };
const clampRest = (s) => Math.min(3600, Math.max(5, Math.round(s) || 0));

function RestTimer({ autoSignal = 0 }) {
  const prefs = useRef(loadRestPrefs());
  const [open, setOpen] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [running, setRunning] = useState(false);
  const [auto, setAuto] = useState(prefs.current.auto ?? true);
  const [muted, setMuted] = useState(prefs.current.muted ?? false);
  const [duration, setDuration] = useState(prefs.current.duration || 90);
  const [customStr, setCustomStr] = useState("");
  const [overlay, setOverlay] = useState("hidden"); // 'hidden' | 'running' | 'done' — the on-screen popup

  // remember the chosen rest length + auto/mute across workouts (this device)
  useEffect(() => {
    try { localStorage.setItem(REST_PREFS_KEY, JSON.stringify({ duration, auto, muted })); } catch {}
  }, [duration, auto, muted]);
  const endRef = useRef(0);       // wall-clock ms when the current countdown ends
  const tick = useRef(null);
  const audioRef = useRef(null);
  const firedRef = useRef(false); // guard so the end alert fires exactly once
  const initial = useRef(autoSignal);

  const fireAlert = () => {
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([180, 90, 180]);
    if (muted) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioRef.current) audioRef.current = new AC();
      const ctx = audioRef.current;
      if (ctx.state === "suspended") ctx.resume();
      // two short beeps
      [0, 0.22].forEach((t) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + t);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.16);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(ctx.currentTime + t);
        osc.stop(ctx.currentTime + t + 0.18);
      });
    } catch {}
  };

  // Drive the countdown from a target timestamp instead of decrementing a
  // counter. Mobile browsers throttle/suspend JS timers when the screen locks or
  // the app is backgrounded between sets, which made the old timer drift; reading
  // Date.now() each tick keeps it correct and lets it "catch up" on resume.
  const settle = () => {
    const left = Math.max(0, Math.round((endRef.current - Date.now()) / 1000));
    setRemaining(left);
    if (left <= 0) {
      setRunning(false);
      if (!firedRef.current) { firedRef.current = true; fireAlert(); }
      setOverlay((o) => (o === "running" ? "done" : o)); // popup switches to "rest complete"
    }
    return left;
  };

  useEffect(() => {
    if (!running) return;
    settle();
    tick.current = setInterval(settle, 250);
    return () => clearInterval(tick.current);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  // Recompute the moment we come back to the tab, so a rest that ended while the
  // phone was locked alerts immediately rather than waiting for the next tick.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible" && running) settle(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const begin = (secs) => {
    firedRef.current = false;
    endRef.current = Date.now() + secs * 1000;
    setRemaining(secs);
    setRunning(true);
    setOverlay("running"); // show the on-screen popup
  };
  const start = (s) => { setDuration(s); begin(s); setOpen(false); };
  // apply a typed custom rest length: becomes the new default + starts now
  const applyCustom = () => {
    const s = clampRest(parseInt(customStr, 10));
    if (!s) return;
    setCustomStr("");
    start(s);
  };

  // auto-dismiss the "rest complete" popup a few seconds after it ends
  useEffect(() => {
    if (overlay !== "done") return;
    const t = setTimeout(() => setOverlay("hidden"), 4000);
    return () => clearTimeout(t);
  }, [overlay]);

  // auto-start whenever a set is checked done
  useEffect(() => {
    if (autoSignal === initial.current) return; // skip first mount
    if (!auto) return;
    begin(duration);
  }, [autoSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePause = () => {
    if (running) { settle(); setRunning(false); }            // freeze at current remaining
    else if (remaining > 0) { firedRef.current = false; endRef.current = Date.now() + remaining * 1000; setRunning(true); }
  };
  // add/subtract time on the fly (e.g. need a few more seconds)
  const adjust = (delta) => {
    const base = running ? Math.max(0, Math.round((endRef.current - Date.now()) / 1000)) : remaining;
    const next = Math.max(0, base + delta);
    setRemaining(next);
    if (running) { endRef.current = Date.now() + next * 1000; if (next > 0) firedRef.current = false; }
  };
  const skip = () => { setRunning(false); setRemaining(0); firedRef.current = true; setOverlay("hidden"); };

  const mmss = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  const live = running || remaining > 0;          // a countdown is in progress (running or paused)
  const pctLeft = duration ? Math.min(100, Math.max(0, (remaining / duration) * 100)) : 0;

  return (
    <>
    <div className="rest">
      <button className={`icon-btn timer-btn ${live ? "timer-on" : ""} ${running ? "timer-live" : ""}`} onClick={() => setOpen((o) => !o)}>
        {live ? <span className="timer-count">{mmss}</span> : <Timer size={20} />}
      </button>
      {open && (
        <div className="rest-pop">
          <div className="rest-big">{mmss}</div>
          <div className="rest-track"><div className="rest-track-fill" style={{ width: `${pctLeft}%` }} /></div>
          <div className="rest-presets">
            {[60, 90, 120, 180].map((s) => (
              <button
                key={s}
                className={duration === s ? "preset-on" : ""}
                onClick={() => start(s)}
              >{s < 120 ? `${s}s` : `${s / 60}m`}</button>
            ))}
          </div>
          <div className="rest-custom">
            <input className="rest-custom-input" inputMode="numeric" placeholder={`${duration}s — custom`}
              value={customStr}
              onChange={(e) => setCustomStr(e.target.value.replace(/[^\d]/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && applyCustom()} />
            <span className="rest-custom-unit">sec</span>
            <button className="rest-custom-set" onClick={applyCustom} disabled={!customStr}>Set</button>
          </div>
          <div className="rest-adjust">
            <button onClick={() => adjust(-15)} disabled={!live}>−15s</button>
            <button onClick={() => adjust(15)}>+15s</button>
            <button onClick={skip} disabled={!live}>Skip</button>
          </div>
          <button
            className={`auto-toggle ${auto ? "auto-on" : ""}`}
            onClick={() => setAuto((a) => !a)}
          >
            Auto-rest {auto ? "ON" : "OFF"} · {duration}s
          </button>
          <div className="rest-ctrl">
            <button onClick={togglePause} disabled={remaining === 0 && !running}>
              {running ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button onClick={() => start(duration)} title="restart"><RotateCcw size={15} /></button>
            <button className={muted ? "" : "sound-on"} onClick={() => setMuted((m) => !m)} aria-label="toggle sound">
              {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
          </div>
        </div>
      )}
    </div>

    {overlay !== "hidden" && createPortal(
      <div className="rest-overlay">
        <div className="rest-overlay-card">
          {overlay === "done" ? (
            <>
              <div className="rest-ov-done"><Check size={20} /> Rest complete</div>
              <button className="rest-ov-btn primary" onClick={() => setOverlay("hidden")}>Start next set</button>
            </>
          ) : (
            <>
              <div className="rest-ov-label"><Timer size={14} /> {running ? "Resting" : "Paused"}</div>
              <div className="rest-ov-time">{mmss}</div>
              <div className="rest-ov-track"><div style={{ width: `${pctLeft}%` }} /></div>
              <div className="rest-ov-btns">
                <button className="rest-ov-btn" onClick={() => adjust(15)}>+15s</button>
                <button className="rest-ov-btn" onClick={togglePause}>{running ? "Pause" : "Resume"}</button>
                <button className="rest-ov-btn primary" onClick={skip}>End rest</button>
              </div>
            </>
          )}
        </div>
      </div>,
      document.body
    )}
    </>
  );
}

/* ================================================================== */
/*  HISTORY VIEW                                                       */
/* ================================================================== */
function HistoryView({ sessions, onDelete, onEdit, onImport }) {
  const [openId, setOpenId] = useState(null);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);
  const sorted = [...sessions].sort((a, b) => b.startedAt - a.startedAt);

  // chronological PR detection per name+variation (by best estimated 1RM)
  const prFlags = {};
  {
    const best = {};
    const chrono = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
    for (const s of chrono) {
      s.exercises.forEach((ex, i) => {
        const key = `${ex.name}|${ex.variation || ""}`;
        const v = bestSetE1rm(ex.sets);
        if (v > 0 && v > (best[key] || 0)) {
          (prFlags[s.id] = prFlags[s.id] || new Set()).add(i);
        }
        if (v > (best[key] || 0)) best[key] = v;
      });
    }
  }

  const exportData = () => {
    try {
      const payload = { app: "IRONLOG", version: 1, exportedAt: Date.now(), sessions };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ironlog-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { setMsg("Export failed"); }
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const arr = Array.isArray(data) ? data : data.sessions;
      const added = await onImport(arr);
      setMsg(`Restored — ${added} new workout${added === 1 ? "" : "s"} added`);
    } catch { setMsg("Couldn't read that backup file"); }
    e.target.value = "";
    setTimeout(() => setMsg(null), 4000);
  };

  const BackupBar = (
    <div className="backup-wrap">
      <div className="backup">
        <button className="backup-btn" onClick={exportData} disabled={!sessions.length}>
          <Download size={15} /> Export backup
        </button>
        <button className="backup-btn" onClick={() => fileRef.current?.click()}>
          <Upload size={15} /> Import
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={handleFile} style={{ display: "none" }} />
      </div>
      {msg && <div className="backup-msg">{msg}</div>}
      <p className="footnote" style={{ margin: "10px 4px 0" }}>
        Your data lives only on this device. Export a backup file to keep it safe or move it to another device.
      </p>
    </div>
  );

  if (!sorted.length) {
    return (
      <div className="fade-in">
        <div className="empty">
          <History size={40} />
          <h3>No workouts yet</h3>
          <p>Finish a session on the Train tab and it'll show up here.</p>
        </div>
        {BackupBar}
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div className="section-label">{sorted.length} logged workout{sorted.length > 1 ? "s" : ""}</div>
      {sorted.map((s) => {
        const open = openId === s.id;
        const setCount = s.exercises.reduce((n, e) => n + e.sets.length, 0);
        const vol = s.exercises.reduce((t, e) =>
          t + e.sets.reduce((x, st) => x + (parseFloat(st.w) || 0) * (parseFloat(st.r) || 0), 0), 0);
        const prCount = prFlags[s.id]?.size || 0;
        let topLift = null, topE = 0;
        for (const ex of s.exercises) { const e = bestSetE1rm(ex.sets); if (e > topE) { topE = e; topLift = { name: ex.name, e1rm: Math.round(e) }; } }
        const shareStats = { volume: vol, setCount, exCount: s.exercises.length, prCount, topLift };
        return (
          <div className="hist-card" key={s.id}>
            <button className="hist-head" onClick={() => setOpenId(open ? null : s.id)}>
              <div className="hist-info">
                <span className="day-tag sm">{s.tag}</span>
                <div>
                  <h3>{s.dayName} {prCount > 0 && <span className="pr-badge sm"><Trophy size={10} /> {prCount}</span>}</h3>
                  <p>{fmtDate(s.startedAt)} · {setCount} sets · {Math.round(vol).toLocaleString()} lbs vol</p>
                </div>
              </div>
              {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
            </button>
            {open && (
              <div className="hist-body">
                {s.note && <div className="hist-note"><BookOpen size={13} /> {s.note}</div>}
                {s.exercises.map((ex, i) => {
                  const rests = ex.sets.map((st) => st.restBefore).filter((r) => r != null);
                  const avgRest = rests.length ? Math.round(rests.reduce((a, b) => a + b, 0) / rests.length) : null;
                  const top1rm = Math.round(bestSetE1rm(ex.sets));
                  const isPR = prFlags[s.id]?.has(i);
                  return (
                    <div className="hist-ex" key={i}>
                      <div className="hist-ex-name">
                        {ex.name}{ex.variation ? <em> · {ex.variation}</em> : null}
                        {isPR && <span className="pr-badge sm"><Trophy size={10} /> PR</span>}
                      </div>
                      <div className="hist-sets">
                        {ex.sets.map((st, j) => (
                          <span key={j} className="last-chip">{st.w || "–"}<i>×</i>{st.r || "–"}</span>
                        ))}
                      </div>
                      <div className="hist-meta">
                        {top1rm > 0 && <span>est 1RM {top1rm} lbs</span>}
                        {avgRest != null && <span><Timer size={11} /> avg rest {fmtRest(avgRest)}</span>}
                      </div>
                      {ex.note && <div className="hist-ex-note">“{ex.note}”</div>}
                    </div>
                  );
                })}
                <div className="hist-actions">
                  <button className="hist-edit" onClick={() => onEdit(s)}>
                    <Pencil size={14} /> Edit
                  </button>
                  <button className="hist-share" onClick={() => shareWorkoutCard(s, shareStats)}>
                    <Share2 size={14} /> Share
                  </button>
                  <button className="btn-danger sm" style={{ marginTop: 0 }} onClick={() => onDelete(s.id)}>
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {BackupBar}
    </div>
  );
}

/* ================================================================== */
/*  PROGRESS VIEW                                                      */
/* ================================================================== */
/* ----------------------- STREAKS & ACHIEVEMENTS ------------------------- */
function streaks(sessions) {
  if (!sessions.length) return { current: 0, longest: 0 };
  const DAY = 86400000;
  const days = new Set(sessions.map((s) => dateKey(s.startedAt)));
  const ts = [...new Set(sessions.map((s) => { const d = new Date(s.startedAt); d.setHours(0, 0, 0, 0); return d.getTime(); }))].sort((a, b) => a - b);
  let longest = 1, run = 1;
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] === DAY) { run++; longest = Math.max(longest, run); }
    else { run = 1; }
  }
  const has = (t) => days.has(dateKey(t));
  let cur = new Date(); cur.setHours(0, 0, 0, 0);
  if (!has(cur.getTime())) cur.setTime(cur.getTime() - DAY); // allow "yesterday" start
  let current = 0;
  while (has(cur.getTime())) { current++; cur.setTime(cur.getTime() - DAY); }
  return { current, longest };
}

function computeAchievements(sessions) {
  const n = sessions.length;
  const totalVolume = Math.round(sessions.reduce((t, s) =>
    t + s.exercises.reduce((x, e) => x + e.sets.reduce((y, st) => y + (parseFloat(st.w) || 0) * (parseFloat(st.r) || 0), 0), 0), 0));
  let prCount = 0;
  const best = {};
  for (const s of [...sessions].sort((a, b) => a.startedAt - b.startedAt)) {
    for (const ex of s.exercises) {
      const k = `${ex.name}|${ex.variation || ""}`;
      const v = bestSetE1rm(ex.sets);
      if (v > 0 && v > (best[k] || 0)) prCount++;
      if (v > (best[k] || 0)) best[k] = v;
    }
  }
  const distinct = new Set(sessions.flatMap((s) => s.exercises.map((e) => e.name))).size;
  const { current: currentStreak, longest: longestStreak } = streaks(sessions);
  return { n, totalVolume, prCount, distinct, currentStreak, longestStreak };
}

const ACHIEVEMENTS = [
  { id: "first", key: "n", goal: 1, icon: <Dumbbell size={20} />, title: "First Lift", desc: "Log your first workout" },
  { id: "w10", key: "n", goal: 10, icon: <Dumbbell size={20} />, title: "Getting Serious", desc: "10 workouts logged" },
  { id: "w50", key: "n", goal: 50, icon: <Trophy size={20} />, title: "Half Century", desc: "50 workouts logged" },
  { id: "w100", key: "n", goal: 100, icon: <Trophy size={20} />, title: "Centurion", desc: "100 workouts logged" },
  { id: "s3", key: "longestStreak", goal: 3, icon: <Flame size={20} />, title: "Warmed Up", desc: "3-day workout streak" },
  { id: "s7", key: "longestStreak", goal: 7, icon: <Flame size={20} />, title: "On Fire", desc: "7-day workout streak" },
  { id: "s30", key: "longestStreak", goal: 30, icon: <Flame size={20} />, title: "Unstoppable", desc: "30-day workout streak" },
  { id: "pr1", key: "prCount", goal: 1, icon: <Trophy size={20} />, title: "New PR!", desc: "Set your first personal record" },
  { id: "pr10", key: "prCount", goal: 10, icon: <Star size={20} />, title: "PR Machine", desc: "Set 10 personal records" },
  { id: "v100k", key: "totalVolume", goal: 100000, icon: <Scale size={20} />, title: "Heavy Hauler", desc: "Move 100k lbs total" },
  { id: "v1m", key: "totalVolume", goal: 1000000, icon: <Scale size={20} />, title: "Iron Mountain", desc: "Move 1,000,000 lbs total" },
  { id: "explore", key: "distinct", goal: 15, icon: <ListChecks size={20} />, title: "Explorer", desc: "Train 15 different exercises" },
];

function AchievementsView({ sessions }) {
  const a = computeAchievements(sessions);
  const earned = ACHIEVEMENTS.filter((x) => a[x.key] >= x.goal).length;
  return (
    <div className="fade-in">
      <div className="stat-row">
        <div className="stat"><span className="stat-n">{a.currentStreak}</span><span className="stat-l">day streak</span></div>
        <div className="stat"><span className="stat-n">{a.longestStreak}</span><span className="stat-l">best streak</span></div>
        <div className="stat"><span className="stat-n">{a.n}</span><span className="stat-l">workouts</span></div>
      </div>
      <div className="section-label" style={{ margin: "4px 4px 12px" }}>{earned} of {ACHIEVEMENTS.length} badges earned</div>
      <div className="badge-grid">
        {ACHIEVEMENTS.map((x) => {
          const val = a[x.key] || 0;
          const done = val >= x.goal;
          const pct = Math.min(100, Math.round((val / x.goal) * 100));
          return (
            <div className={`badge ${done ? "badge-on" : ""}`} key={x.id}>
              <div className="badge-ico">{x.icon}</div>
              <div className="badge-text">
                <strong>{x.title}</strong>
                <span>{x.desc}</span>
              </div>
              {done ? <span className="badge-check"><Check size={16} /></span>
                : <div className="badge-prog"><div className="badge-prog-fill" style={{ width: `${pct}%` }} /></div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProgressView({ sessions }) {
  const [tab, setTab] = useState("trends");
  return (
    <div className="fade-in">
      <div className="metric-tabs">
        <button className={tab === "trends" ? "mt-on" : ""} onClick={() => setTab("trends")}>Strength</button>
        <button className={tab === "awards" ? "mt-on" : ""} onClick={() => setTab("awards")}>Awards</button>
      </div>
      {tab === "trends" ? <StrengthTrends sessions={sessions} /> : <AchievementsView sessions={sessions} />}
    </div>
  );
}

function StrengthTrends({ sessions }) {
  const names = Array.from(new Set(sessions.flatMap((s) => s.exercises.map((e) => e.name)))).sort();
  const [sel, setSel] = useState(names[0] || null);
  const [metric, setMetric] = useState("e1rm"); // e1rm | top
  const [varFilter, setVarFilter] = useState("all");

  if (!names.length) {
    return (
      <div className="empty fade-in">
        <TrendingUp size={40} />
        <h3>No data to chart yet</h3>
        <p>Log a few workouts and your strength trend per lift will appear here.</p>
      </div>
    );
  }
  const current = names.includes(sel) ? sel : names[0];

  // variations actually logged for this exercise
  const variations = Array.from(new Set(
    sessions.flatMap((s) => s.exercises.filter((e) => e.name === current && e.variation).map((e) => e.variation))
  ));
  const useVar = variations.includes(varFilter) ? varFilter : "all";

  const data = sessions
    .filter((s) => s.exercises.some((e) => e.name === current && (useVar === "all" || e.variation === useVar)))
    .map((s) => {
      const ex = s.exercises.find((e) => e.name === current && (useVar === "all" || e.variation === useVar));
      const top = ex.sets.reduce((m, st) => Math.max(m, parseFloat(st.w) || 0), 0);
      const oneRm = Math.round(bestSetE1rm(ex.sets));
      return { date: s.startedAt, top, e1rm: oneRm };
    })
    .sort((a, b) => a.date - b.date)
    .map((d) => ({ ...d, label: fmtShort(d.date) }));

  const key = metric === "top" ? "top" : "e1rm";
  const best = data.length ? Math.max(...data.map((d) => d[key])) : 0;
  const latest = data.length ? data[data.length - 1][key] : 0;
  const unit = metric === "top" ? "weight" : "est 1RM";

  return (
    <div className="fade-in">
      <div className="metric-tabs">
        <button className={metric === "e1rm" ? "mt-on" : ""} onClick={() => setMetric("e1rm")}>Est. 1RM</button>
        <button className={metric === "top" ? "mt-on" : ""} onClick={() => setMetric("top")}>Top weight</button>
      </div>

      <select className="ex-select" value={current} onChange={(e) => { setSel(e.target.value); setVarFilter("all"); }}>
        {names.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>

      {variations.length > 1 && (
        <div className="var-row" style={{ marginBottom: 14 }}>
          <button className={`var-pill ${useVar === "all" ? "var-on" : ""}`} onClick={() => setVarFilter("all")}>All</button>
          {variations.map((v) => (
            <button key={v} className={`var-pill ${useVar === v ? "var-on" : ""}`} onClick={() => setVarFilter(v)}>{v}</button>
          ))}
        </div>
      )}

      <div className="stat-row">
        <div className="stat"><span className="stat-n">{latest || "–"}</span><span className="stat-l">latest lbs</span></div>
        <div className="stat"><span className="stat-n">{best || "–"}</span><span className="stat-l">best lbs</span></div>
        <div className="stat"><span className="stat-n">{data.length}</span><span className="stat-l">sessions</span></div>
      </div>

      <div className="section-label" style={{ margin: "0 4px 10px" }}>{unit} per session</div>
      <div className="chart-box">
        {data.length < 2 ? (
          <p className="chart-hint">Log this lift at least twice to see a trend line.</p>
        ) : (
          <Suspense fallback={<ChartFallback />}>
            <TrendChart data={data} yKey={key} color="#d8ff36" height={240} format={(v) => [`${v} lbs`, unit]} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/*  NUTRITION — targets math + meal/profile screens                    */
/* ================================================================== */
const ACTIVITY = {
  sedentary: { mult: 1.2, label: "Sedentary (little exercise)" },
  light: { mult: 1.375, label: "Light (1–3 days/wk)" },
  moderate: { mult: 1.55, label: "Moderate (3–5 days/wk)" },
  very: { mult: 1.725, label: "Very active (6–7 days/wk)" },
  athlete: { mult: 1.9, label: "Athlete (2x/day)" },
};
const GOALS = {
  lose_weight: { factor: 0.75, proteinPerLb: 0.8, label: "Lose weight" },
  lose_fat: { factor: 0.8, proteinPerLb: 1.0, label: "Lose fat" },
  maintain: { factor: 1.0, proteinPerLb: 0.8, label: "Maintain" },
  bulk: { factor: 1.12, proteinPerLb: 0.9, label: "Bulk" },
};
const MACROS = [
  { key: "calories", label: "Calories", unit: "kcal", color: "#d8ff36" },
  { key: "protein", label: "Protein", unit: "g", color: "#46d9ff" },
  { key: "carbs", label: "Carbs", unit: "g", color: "#ffb13e" },
  { key: "fat", label: "Fat", unit: "g", color: "#ff6fd0" },
];

// Mifflin–St Jeor BMR -> TDEE (activity) -> calories (goal) -> macro split.
function computeTargets({ sex, age, heightIn, weightLbs, activity, goal }) {
  const w = Number(weightLbs), h = Number(heightIn), a = Number(age);
  if (!w || !h || !a) return null;
  const kg = w / 2.2046226, cm = h * 2.54;
  const bmr = 10 * kg + 6.25 * cm - 5 * a + (sex === "female" ? -161 : 5);
  const tdee = bmr * (ACTIVITY[activity]?.mult || 1.55);
  const g = GOALS[goal] || GOALS.maintain;
  const calories = Math.round((tdee * g.factor) / 10) * 10;
  const protein = Math.round(g.proteinPerLb * w);
  const fat = Math.round((calories * 0.27) / 9);   // ~27% of calories from fat
  const carbs = Math.max(0, Math.round((calories - protein * 4 - fat * 9) / 4));
  return { calories, protein, carbs, fat };
}

const pad2 = (n) => String(n).padStart(2, "0");
const localDayStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function shiftDay(dayStr, delta) {
  const [y, m, dd] = dayStr.split("-").map(Number);
  return localDayStr(new Date(y, m - 1, dd + delta));
}
function dayLabel(dayStr) {
  const today = localDayStr();
  if (dayStr === today) return "Today";
  if (dayStr === shiftDay(today, -1)) return "Yesterday";
  if (dayStr === shiftDay(today, 1)) return "Tomorrow";
  const [y, m, dd] = dayStr.split("-").map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/* ----------------------------- MEAL VIEW -------------------------- */
const MEAL_SLOTS = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snacks", label: "Snacks" },
];
const sumMacros = (list) => list.reduce(
  (a, m) => ({ calories: a.calories + m.calories, protein: a.protein + m.protein, carbs: a.carbs + m.carbs, fat: a.fat + m.fat }),
  { calories: 0, protein: 0, carbs: 0, fat: 0 }
);

// Rough active-calorie estimate for a logged workout: MET × bodyweight(kg) × hours.
// ~5 METs is typical for general resistance training. Returns 0 if we can't tell
// (no duration, or no bodyweight on file). It's an estimate, always user-editable.
const STRENGTH_MET = 5.0;
function estimateBurn(session, weightLbs) {
  const w = Number(weightLbs);
  if (!w || !session?.startedAt || !session?.finishedAt) return 0;
  const hrs = Math.max(0, (session.finishedAt - session.startedAt) / 3600000);
  if (!hrs || hrs > 6) return 0; // ignore zero / runaway timers
  const kg = w / 2.2046226;
  return Math.round(STRENGTH_MET * kg * hrs);
}
// Sum the estimate across every workout that started on `day` (local date string).
function estimateDayBurn(sessions, day, weightLbs) {
  return (sessions || [])
    .filter((s) => s.startedAt && localDayStr(new Date(s.startedAt)) === day)
    .reduce((sum, s) => sum + estimateBurn(s, weightLbs), 0);
}

function MealView({ profile, sessions, onGoProfile }) {
  const [day, setDay] = useState(localDayStr());
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addSlot, setAddSlot] = useState(null);      // FoodSearch open for this slot
  const [editing, setEditing] = useState(null);      // entry being edited
  const [saveItems, setSaveItems] = useState(null);  // entries to name & save as a meal
  const [copyBusy, setCopyBusy] = useState(false);
  const [burned, setBurned] = useState(null);        // { calories, source } | null
  const targets = profile?.targets || null;

  useEffect(() => {
    let on = true;
    setLoading(true);
    setBurned(null);
    api.getMeals(day)
      .then((r) => { if (on) { setEntries(Array.isArray(r) ? r : []); setLoading(false); } })
      .catch(() => { if (on) { setEntries([]); setLoading(false); } });
    api.getActivity(day)
      .then((a) => { if (on) setBurned(a || null); })
      .catch(() => { if (on) setBurned(null); });
    return () => { on = false; };
  }, [day]);

  const totals = sumMacros(entries);
  const burnedCals = burned?.calories || 0;

  const saveBurn = async (calories, source) => {
    const prev = burned;
    const next = calories > 0 ? { calories, source } : null;
    setBurned(next);
    try {
      if (calories > 0) await api.logActivity(day, calories, source);
      else await api.clearActivity(day);
    } catch { setBurned(prev); }
  };

  const addEntry = async (entry) => {
    const tmp = { ...entry, id: `tmp-${Date.now()}` };
    setEntries((p) => [...p, tmp]);
    try {
      const saved = await api.addMeal(entry);
      setEntries((p) => p.map((e) => (e.id === tmp.id ? saved : e)));
    } catch { setEntries((p) => p.filter((e) => e.id !== tmp.id)); }
  };
  const updateEntry = async (id, fields) => {
    const prev = entries;
    setEntries((p) => p.map((e) => (e.id === id ? { ...e, ...fields } : e)));
    try { const saved = await api.updateMeal(id, fields); setEntries((p) => p.map((e) => (e.id === id ? saved : e))); }
    catch { setEntries(prev); }
  };
  const delEntry = async (id) => {
    const prev = entries;
    setEntries((p) => p.filter((e) => e.id !== id));
    try { await api.deleteMeal(id); } catch { setEntries(prev); }
  };
  const logItems = async (items) => {
    try { const fresh = await api.bulkAddMeals(day, items); setEntries(Array.isArray(fresh) ? fresh : entries); }
    catch { /* ignore */ }
  };
  const copyPrevDay = async () => {
    setCopyBusy(true);
    try { const fresh = await api.copyDay(shiftDay(day, -1), day); setEntries(Array.isArray(fresh) ? fresh : entries); }
    catch { /* ignore */ }
    setCopyBusy(false);
  };

  return (
    <div className="fade-in">
      <div className="meal-datebar">
        <button className="icon-btn sm" onClick={() => setDay((d) => shiftDay(d, -1))}><ChevronLeft size={18} /></button>
        <div className="meal-date">
          <strong>{dayLabel(day)}</strong>
          {day !== localDayStr() && <button className="meal-today" onClick={() => setDay(localDayStr())}>jump to today</button>}
        </div>
        <button className="icon-btn sm" onClick={() => setDay((d) => shiftDay(d, 1))} disabled={day >= localDayStr()}><ChevronRight size={18} /></button>
      </div>

      {!targets && (
        <button className="meal-cta" onClick={onGoProfile}>
          <Target size={16} /> Set your body stats & goal to get daily macro targets →
        </button>
      )}

      <div className="macro-grid">
        {MACROS.map((mc) => (
          <MacroStat key={mc.key} label={mc.label} unit={mc.unit} color={mc.color}
            value={totals[mc.key]} target={targets?.[mc.key]} />
        ))}
      </div>

      <BurnCard
        burned={burnedCals}
        source={burned?.source}
        eaten={totals.calories}
        calorieTarget={targets?.calories}
        estimate={estimateDayBurn(sessions, day, profile?.weightLbs)}
        onSave={saveBurn}
      />

      <button className="meal-copy" onClick={copyPrevDay} disabled={copyBusy}>
        <Copy size={14} /> {copyBusy ? "Copying…" : "Copy yesterday's meals"}
      </button>

      {loading ? (
        <p className="chart-hint" style={{ padding: 24 }}>Loading…</p>
      ) : (
        MEAL_SLOTS.map(({ key, label }) => {
          const list = entries.filter((e) => (e.slot || "snacks") === key);
          const st = sumMacros(list);
          return (
            <div className="slot-sec" key={key}>
              <div className="slot-head">
                <div className="slot-title">{label}{list.length > 0 && <span className="slot-sub">{Math.round(st.calories)} kcal · P{Math.round(st.protein)} C{Math.round(st.carbs)} F{Math.round(st.fat)}</span>}</div>
                <div className="slot-actions">
                  {list.length > 0 && <button className="slot-save" onClick={() => setSaveItems(list)} title="Save these as a meal"><Save size={15} /></button>}
                  <button className="slot-add" onClick={() => setAddSlot(key)}><Plus size={14} /> Add</button>
                </div>
              </div>
              {list.map((m) => (
                <div className="meal-row" key={m.id}>
                  <button className="meal-info-btn" onClick={() => setEditing(m)}>
                    <strong>{m.name}</strong>
                    <p>{[m.brand, m.amount].filter(Boolean).join(" · ") || "tap to edit"}</p>
                  </button>
                  <div className="meal-macros">
                    <span className="meal-kcal">{Math.round(m.calories)} kcal</span>
                    <span>P {Math.round(m.protein)} · C {Math.round(m.carbs)} · F {Math.round(m.fat)}</span>
                  </div>
                  <button className="del-set" onClick={() => delEntry(m.id)} aria-label="remove food"><X size={16} /></button>
                </div>
              ))}
            </div>
          );
        })
      )}

      {addSlot && (
        <FoodSearch
          day={day} slot={addSlot}
          onAdd={addEntry}
          onLogRecipe={(items) => logItems(items.map((it) => ({ ...it, slot: addSlot })))}
          onClose={() => setAddSlot(null)}
        />
      )}
      {editing && <EditEntry entry={editing} onSave={(fields) => { updateEntry(editing.id, fields); setEditing(null); }} onClose={() => setEditing(null)} />}
      {saveItems && <SaveMeal items={saveItems} onClose={() => setSaveItems(null)} />}
    </div>
  );
}

/* ---- calories burned (manual entry or workout estimate) + net budget ---- */
function BurnCard({ burned, source, eaten, calorieTarget, estimate, onSave }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");

  const open = () => { setVal(burned ? String(Math.round(burned)) : ""); setEditing(true); };
  const commit = () => { onSave(Math.max(0, Math.round(Number(val) || 0)), "manual"); setEditing(false); };
  const useEstimate = () => { onSave(estimate, "estimate"); setEditing(false); };

  // Net = what you ate minus what you burned; budget gets the burn added back.
  const net = Math.round(eaten - burned);
  const remaining = calorieTarget ? Math.round(calorieTarget - eaten + burned) : null;

  return (
    <div className="burn-card">
      <div className="burn-head">
        <div className="burn-title"><Flame size={15} /> Calories burned</div>
        {!editing && (
          <button className="burn-edit" onClick={open}>
            {burned > 0 ? <><strong>{Math.round(burned)}</strong> kcal <Pencil size={12} /></> : <>＋ Add</>}
          </button>
        )}
      </div>

      {editing ? (
        <div className="burn-edit-row">
          <input className="login-input burn-input" inputMode="numeric" autoFocus placeholder="0"
            value={val} onChange={(e) => setVal(e.target.value.replace(/[^\d]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && commit()} />
          <span className="burn-unit">kcal</span>
          <button className="burn-save" onClick={commit}>Save</button>
          <button className="burn-cancel" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      ) : (
        <>
          {estimate > 0 && Math.round(burned) !== estimate && (
            <button className="burn-estimate" onClick={useEstimate}>
              Use today's workout estimate · ~{estimate} kcal
            </button>
          )}
          {calorieTarget ? (
            <div className="burn-net">
              <span>Net <strong>{net.toLocaleString()}</strong> / {Math.round(calorieTarget).toLocaleString()} kcal</span>
              <span className={remaining < 0 ? "burn-over" : "burn-left"}>
                {remaining < 0 ? `${Math.abs(remaining).toLocaleString()} over` : `${remaining.toLocaleString()} left`}
              </span>
            </div>
          ) : (
            burned > 0 && <p className="burn-hint">Net intake: {net.toLocaleString()} kcal eaten − burned</p>
          )}
          <p className="burn-foot">
            {source === "estimate" ? "Estimated from your workout — " : ""}
            Read it off your Apple Watch and tap to adjust. Burned calories add back to your daily budget.
          </p>
        </>
      )}
    </div>
  );
}

/* ---- edit a logged entry (rescale by amount, or edit macros directly) ---- */
function EditEntry({ entry, onSave, onClose }) {
  const per100 = entry.base?.per100g || null;
  const servingG = entry.base?.servingG || null;
  const [unit, setUnit] = useState(servingG ? "serving" : "gram");
  const [qty, setQty] = useState(() => {
    if (!per100) return "";
    if (servingG) return String(Math.round(((entry.grams || servingG) / servingG) * 100) / 100);
    return String(entry.grams || 100);
  });
  const [c, setC] = useState({ calories: entry.calories, protein: entry.protein, carbs: entry.carbs, fat: entry.fat });

  const grams = per100 ? (unit === "serving" ? (Number(qty) || 0) * (servingG || 0) : (Number(qty) || 0)) : null;
  const scaled = per100 ? {
    calories: per100.calories * grams / 100, protein: (per100.protein || 0) * grams / 100,
    carbs: (per100.carbs || 0) * grams / 100, fat: (per100.fat || 0) * grams / 100,
  } : null;

  const save = () => {
    if (per100) {
      const g = Math.max(1, Math.round(grams));
      const n = Number(qty) || 0;
      onSave({ amount: unit === "serving" ? `${n} serving${n === 1 ? "" : "s"} (${g} g)` : `${g} g`, grams: g, ...scaled });
    } else {
      onSave({ amount: entry.amount || "", grams: entry.grams ?? null, calories: +c.calories || 0, protein: +c.protein || 0, carbs: +c.carbs || 0, fat: +c.fat || 0 });
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="food-modal" onClick={(e) => e.stopPropagation()}>
        <div className="food-head"><h3>Edit · {entry.name}</h3><button className="icon-btn sm" onClick={onClose}><X size={18} /></button></div>
        <div className="food-amount">
          {per100 ? (
            <>
              {servingG ? (
                <div className="seg">
                  <button className={unit === "serving" ? "seg-on" : ""} onClick={() => { setUnit("serving"); setQty("1"); }}>Servings</button>
                  <button className={unit === "gram" ? "seg-on" : ""} onClick={() => { setUnit("gram"); setQty(String(Math.round(servingG))); }}>Grams</button>
                </div>
              ) : null}
              <label className="field-label">{unit === "serving" ? `Servings (1 = ${Math.round(servingG)} g)` : "Amount (grams)"}</label>
              <input className="login-input" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ""))} />
              <div className="food-preview">
                <span style={{ color: "#d8ff36" }}>{Math.round(scaled.calories)} kcal</span>
                <span>P {Math.round(scaled.protein)}</span><span>C {Math.round(scaled.carbs)}</span><span>F {Math.round(scaled.fat)}</span>
              </div>
            </>
          ) : (
            <div className="custom-macros">
              {[["calories", "Calories"], ["protein", "Protein g"], ["carbs", "Carbs g"], ["fat", "Fat g"]].map(([k, lbl]) => (
                <div key={k}>
                  <label className="field-label">{lbl}</label>
                  <input className="login-input" inputMode="decimal" value={c[k]} onChange={(e) => setC({ ...c, [k]: e.target.value.replace(/[^\d.]/g, "") })} />
                </div>
              ))}
            </div>
          )}
          <button className="login-go" style={{ margin: 0 }} onClick={save}>Save changes</button>
        </div>
      </div>
    </div>
  );
}

/* ---- name + save a set of foods as a reusable meal (recipe) ---- */
function SaveMeal({ items, onClose }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const st = sumMacros(items);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await api.addRecipe(name.trim(), items); setDone(true); setTimeout(onClose, 900); }
    catch { setBusy(false); }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="food-modal" onClick={(e) => e.stopPropagation()}>
        <div className="food-head"><h3>Save as a meal</h3><button className="icon-btn sm" onClick={onClose}><X size={18} /></button></div>
        <div className="food-amount">
          <p className="help-note" style={{ margin: 0 }}>{items.length} item{items.length === 1 ? "" : "s"} · {Math.round(st.calories)} kcal · P{Math.round(st.protein)} C{Math.round(st.carbs)} F{Math.round(st.fat)}</p>
          <label className="field-label">Meal name</label>
          <input className="login-input" autoFocus value={name} placeholder="e.g. My breakfast" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
          <button className="login-go" style={{ margin: 0 }} disabled={busy || !name.trim()} onClick={save}>{done ? "Saved ✓" : busy ? "Saving…" : "Save meal"}</button>
          <p className="help-note" style={{ margin: 0 }}>Find it under “Saved meals” when you tap Add — log the whole thing in one tap.</p>
        </div>
      </div>
    </div>
  );
}

function MacroStat({ label, value, target, unit, color }) {
  const pct = target ? Math.min(100, Math.round((value / target) * 100)) : 0;
  const over = target && value > target;
  return (
    <div className="macro-stat">
      <div className="macro-top">
        <span className="macro-label">{label}</span>
        <span className="macro-val" style={{ color }}>{Math.round(value)}{target ? <i> / {Math.round(target)}</i> : null}</span>
      </div>
      <div className="macro-bar">
        <div className="macro-fill" style={{ width: `${pct}%`, background: over ? "var(--danger)" : color }} />
      </div>
      <span className="macro-unit">{unit}{target ? (over ? ` · ${Math.round(value - target)} over` : ` · ${Math.round(target - value)} left`) : ""}</span>
    </div>
  );
}

/* --------------------------- FOOD SEARCH -------------------------- */
const isBarcode = (s) => /^\d{8,14}$/.test(s.trim());

function FoodSearch({ day, slot, onAdd, onLogRecipe, onClose }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [sel, setSel] = useState(null);
  const [unit, setUnit] = useState("gram");   // "serving" | "gram"
  const [qty, setQty] = useState("100");       // count of servings, or grams
  const [custom, setCustom] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [c, setC] = useState({ name: "", calories: "", protein: "", carbs: "", fat: "" });
  const [recents, setRecents] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const timer = useRef(null);
  const barcodeQ = isBarcode(q);
  const favKeys = new Set(favorites.map((f) => `${f.name}|${f.amount || ""}`));
  const slotLabel = (MEAL_SLOTS.find((s) => s.key === slot) || {}).label || "";

  // load recent foods, favorites + saved meals for one-tap logging
  useEffect(() => {
    let on = true;
    Promise.all([
      api.getRecentFoods().catch(() => []),
      api.getFavorites().catch(() => []),
      api.getRecipes().catch(() => []),
    ]).then(([r, f, rec]) => {
      if (on) { setRecents(Array.isArray(r) ? r : []); setFavorites(Array.isArray(f) ? f : []); setRecipes(Array.isArray(rec) ? rec : []); }
    });
    return () => { on = false; };
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        if (isBarcode(term)) {
          const f = await api.getFoodByBarcode(term);   // exact product by barcode
          setResults(f ? [f] : []);
        } else {
          setResults(await api.searchFoods(term));       // search by name
        }
      } catch { setResults([]); }
      setSearching(false);
    }, isBarcode(term) ? 150 : 450);
    return () => timer.current && clearTimeout(timer.current);
  }, [q]);

  // pick a food -> default to servings if the DB gave us a serving size
  const pickFood = (f) => {
    setSel(f);
    if (f.servingG) { setUnit("serving"); setQty("1"); }
    else { setUnit("gram"); setQty("100"); }
  };
  // a scanned+looked-up product jumps straight to the quantity screen
  const onScanResult = (food) => { setScanning(false); setQ(""); pickFood(food); };

  // effective grams from the chosen unit + quantity
  const grams = sel
    ? (unit === "serving" ? (Number(qty) || 0) * (sel.servingG || 0) : (Number(qty) || 0))
    : 0;
  const scaled = sel ? (() => {
    const f = Math.max(0, grams) / 100;
    return {
      calories: sel.per100g.calories * f,
      protein: (sel.per100g.protein || 0) * f,
      carbs: (sel.per100g.carbs || 0) * f,
      fat: (sel.per100g.fat || 0) * f,
    };
  })() : null;

  const addSelected = () => {
    const g = Math.max(1, Math.round(grams));
    const n = Number(qty) || 0;
    const amount = unit === "serving" ? `${n} serving${n === 1 ? "" : "s"} (${g} g)` : `${g} g`;
    onAdd({ day, slot, name: sel.name, brand: sel.brand || "", amount, grams: g, base: { per100g: sel.per100g, servingG: sel.servingG || null }, ...scaled });
    onClose();
  };
  const addCustom = () => {
    if (!c.name.trim()) return;
    onAdd({ day, slot, name: c.name.trim(), brand: "", amount: "", grams: null, base: null,
      calories: +c.calories || 0, protein: +c.protein || 0, carbs: +c.carbs || 0, fat: +c.fat || 0 });
    onClose();
  };

  // one-tap re-log a recent/favorite food into this slot
  const addQuick = (item) => {
    onAdd({ day, slot, name: item.name, brand: item.brand || "", amount: item.amount || "",
      grams: item.grams ?? null, base: item.base ?? null,
      calories: item.calories, protein: item.protein, carbs: item.carbs, fat: item.fat });
    onClose();
  };
  const favorite = async (item) => {
    try { setFavorites(await api.addFavorite(item)); } catch { /* ignore */ }
  };
  const unfavorite = async (id) => {
    setFavorites((prev) => prev.filter((f) => f.id !== id));
    try { await api.deleteFavorite(id); } catch { /* ignore */ }
  };
  const logRecipe = (recipe) => { onLogRecipe(recipe.items); onClose(); };
  const removeRecipe = async (id) => {
    setRecipes((prev) => prev.filter((r) => r.id !== id));
    try { await api.deleteRecipe(id); } catch { /* ignore */ }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="food-modal" onClick={(e) => e.stopPropagation()}>
        <div className="food-head">
          <h3>{custom ? "Add custom food" : `Add to ${slotLabel || "day"}`}</h3>
          <button className="icon-btn sm" onClick={onClose}><X size={18} /></button>
        </div>

        {!custom && (
          <>
            <div className="food-searchbar">
              <div className="food-search">
                {barcodeQ ? <ScanLine size={16} /> : <Search size={16} />}
                <input autoFocus className="food-input" inputMode="search"
                  placeholder="Search foods or enter a barcode #"
                  value={q} onChange={(e) => { setQ(e.target.value); setSel(null); }} />
              </div>
              <button className="scan-btn" onClick={() => setScanning(true)} aria-label="scan barcode" title="Scan barcode">
                <Camera size={18} />
              </button>
            </div>
            {!sel && <p className="food-hint">{barcodeQ ? "Looking up barcode…" : "Type a name, paste a barcode number, or tap the camera to scan."}</p>}

            {sel ? (
              <div className="food-amount">
                <div className="food-sel-name"><strong>{sel.name}</strong>{sel.brand ? <em> · {sel.brand}</em> : null}</div>
                {sel.servingG ? (
                  <div className="seg">
                    <button className={unit === "serving" ? "seg-on" : ""} onClick={() => { setUnit("serving"); setQty("1"); }}>Servings</button>
                    <button className={unit === "gram" ? "seg-on" : ""} onClick={() => { setUnit("gram"); setQty(String(Math.round(sel.servingG))); }}>Grams</button>
                  </div>
                ) : null}
                <label className="field-label">
                  {unit === "serving" ? `Servings (1 serving = ${Math.round(sel.servingG)} g)` : "Amount (grams)"}
                </label>
                <input className="login-input" inputMode="decimal" value={qty}
                  onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ""))} />
                <div className="food-preview">
                  <span style={{ color: "#d8ff36" }}>{Math.round(scaled.calories)} kcal</span>
                  <span>P {Math.round(scaled.protein)}</span><span>C {Math.round(scaled.carbs)}</span><span>F {Math.round(scaled.fat)}</span>
                  {unit === "serving" && grams > 0 && <span>= {Math.round(grams)} g</span>}
                </div>
                <div className="modal-btns">
                  <button className="btn-ghost" onClick={() => setSel(null)}>← Back</button>
                  <button className="login-go" style={{ flex: 1, margin: 0 }} onClick={addSelected}>Add to day</button>
                </div>
              </div>
            ) : q.trim().length >= 2 ? (
              <div className="food-results">
                {searching && <p className="chart-hint" style={{ padding: 20 }}>Searching…</p>}
                {!searching && results.length === 0 && (
                  <p className="chart-hint" style={{ padding: 20 }}>
                    {barcodeQ ? "No product found for that barcode. Try the name or add it manually." : "No matches. Try another term or add it manually."}
                  </p>
                )}
                {results.map((f) => (
                  <button className="food-result" key={f.id} onClick={() => pickFood(f)}>
                    <div className="food-result-name">
                      <strong>{f.name}</strong>
                      {f.brand && <em>{f.brand}</em>}
                    </div>
                    <span className="food-result-kcal">{f.per100g.calories} kcal<i>/100g</i></span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="food-results">
                {favorites.length === 0 && recents.length === 0 && recipes.length === 0 && (
                  <p className="chart-hint" style={{ padding: 20 }}>Search, scan, or add a custom food. Your saved meals, recent &amp; favorite foods will show here for one-tap logging.</p>
                )}
                {recipes.length > 0 && <div className="quick-label"><BookOpen size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Saved meals</div>}
                {recipes.map((rec) => {
                  const st = sumMacros(rec.items);
                  return (
                    <div className="quick-row" key={"rec-meal" + rec.id}>
                      <button className="quick-add" onClick={() => logRecipe(rec)}>
                        <div className="food-result-name"><strong>{rec.name}</strong><em>{rec.items.length} item{rec.items.length === 1 ? "" : "s"}</em></div>
                        <span className="quick-meta">{Math.round(st.calories)} kcal</span>
                      </button>
                      <button className="quick-star" onClick={() => removeRecipe(rec.id)} aria-label="delete saved meal"><X size={16} /></button>
                    </div>
                  );
                })}
                {favorites.length > 0 && <div className="quick-label">★ Favorites</div>}
                {favorites.map((f) => (
                  <div className="quick-row" key={"fav" + f.id}>
                    <button className="quick-add" onClick={() => addQuick(f)}>
                      <div className="food-result-name"><strong>{f.name}</strong>{f.brand && <em>{f.brand}</em>}</div>
                      <span className="quick-meta">{Math.round(f.calories)} kcal{f.amount ? ` · ${f.amount}` : ""}</span>
                    </button>
                    <button className="quick-star on" onClick={() => unfavorite(f.id)} aria-label="remove favorite"><Star size={16} fill="currentColor" /></button>
                  </div>
                ))}
                {recents.length > 0 && <div className="quick-label">Recent</div>}
                {recents.map((r, i) => {
                  const faved = favKeys.has(`${r.name}|${r.amount || ""}`);
                  return (
                    <div className="quick-row" key={"rec" + i}>
                      <button className="quick-add" onClick={() => addQuick(r)}>
                        <div className="food-result-name"><strong>{r.name}</strong>{r.brand && <em>{r.brand}</em>}</div>
                        <span className="quick-meta">{Math.round(r.calories)} kcal{r.amount ? ` · ${r.amount}` : ""}</span>
                      </button>
                      <button className={`quick-star ${faved ? "on" : ""}`} onClick={() => !faved && favorite(r)} aria-label="favorite">
                        <Star size={16} fill={faved ? "currentColor" : "none"} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {!sel && (
              <button className="food-manual" onClick={() => setCustom(true)}>Can’t find it? Add manually</button>
            )}
          </>
        )}

        {custom && (
          <div className="food-amount">
            <label className="field-label">Food name</label>
            <input className="login-input" value={c.name} placeholder="e.g. Mom's chili"
              onChange={(e) => setC({ ...c, name: e.target.value })} />
            <div className="custom-macros">
              {[["calories", "Calories"], ["protein", "Protein g"], ["carbs", "Carbs g"], ["fat", "Fat g"]].map(([k, lbl]) => (
                <div key={k}>
                  <label className="field-label">{lbl}</label>
                  <input className="login-input" inputMode="decimal" value={c[k]}
                    onChange={(e) => setC({ ...c, [k]: e.target.value.replace(/[^\d.]/g, "") })} />
                </div>
              ))}
            </div>
            <div className="modal-btns">
              <button className="btn-ghost" onClick={() => setCustom(false)}>← Search instead</button>
              <button className="login-go" style={{ flex: 1, margin: 0 }} onClick={addCustom}>Add to day</button>
            </div>
          </div>
        )}

        {scanning && <BarcodeScanner onResult={onScanResult} onClose={() => setScanning(false)} />}
      </div>
    </div>
  );
}

/* ------------------------- BARCODE SCANNER ------------------------ */
// Uses the browser's native BarcodeDetector (Chrome/Android/Edge). On iOS Safari
// / Firefox (no support) or when the camera is blocked, it shows a clear message
// and the user types/pastes the number instead (which hits the same lookup).
function BarcodeScanner({ onResult, onClose }) {
  const videoRef = useRef(null);
  const lockRef = useRef(false);          // pause while a lookup is in flight / after success
  const rejectedRef = useRef({});         // code -> last "not found" time (avoid re-spamming)
  const [err, setErr] = useState("");
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState(null);
  const [notice, setNotice] = useState("");
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);

  // A detected/typed code -> look it up; resolve to the product or keep scanning.
  const handleCode = useCallback(async (raw) => {
    const code = String(raw || "").replace(/\D/g, "");
    if (code.length < 6 || lockRef.current) return;
    if (rejectedRef.current[code] && Date.now() - rejectedRef.current[code] < 4000) return;
    lockRef.current = true;
    setBusy(true); setNotice("");
    try {
      const food = await api.getFoodByBarcode(code);
      if (food) {
        if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(90);
        setFound(food);
        setTimeout(() => onResult(food), 650); // brief confirmation, then to quantity
        return;                                 // stay locked — we're done
      }
      rejectedRef.current[code] = Date.now();
      setNotice(`No product found for ${code}. Keep scanning or type another number.`);
    } catch {
      setNotice("Lookup failed — check your connection and try again.");
    }
    setBusy(false);
    lockRef.current = false;                     // resume scanning
  }, [onResult]);

  useEffect(() => {
    let stopped = false, stream = null, timer = null, zxingControls = null;

    const checkTorch = () => {
      try {
        const track = videoRef.current?.srcObject?.getVideoTracks?.()[0];
        const caps = track?.getCapabilities?.();
        if (caps && "torch" in caps) setTorchSupported(true);
      } catch { /* not supported */ }
    };

    // Fast path: Chrome/Android/Edge native barcode detector.
    async function runNative() {
      const detector = new window.BarcodeDetector({
        formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39"],
      });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (stopped) return;
      const v = videoRef.current;
      if (v) { v.srcObject = stream; await v.play().catch(() => {}); }
      checkTorch();
      const tick = async () => {
        if (stopped) return;
        try {
          const codes = await detector.detect(videoRef.current);
          const hit = codes.find((c) => c.rawValue && /\d{6,}/.test(c.rawValue));
          if (hit) handleCode(hit.rawValue);     // keep looping; handleCode de-dupes
        } catch { /* keep trying */ }
        timer = setTimeout(tick, 350);
      };
      tick();
    }

    // Fallback: decode camera frames in JS (iOS Safari, Firefox), lazy-loaded.
    async function runZxing() {
      const [{ BrowserMultiFormatReader }, lib] = await Promise.all([
        import("@zxing/browser"),
        import("@zxing/library"),
      ]);
      if (stopped) return;
      let hints;
      try {
        hints = new Map();
        hints.set(lib.DecodeHintType.POSSIBLE_FORMATS, [
          lib.BarcodeFormat.EAN_13, lib.BarcodeFormat.EAN_8, lib.BarcodeFormat.UPC_A,
          lib.BarcodeFormat.UPC_E, lib.BarcodeFormat.CODE_128, lib.BarcodeFormat.CODE_39,
        ]);
        hints.set(lib.DecodeHintType.TRY_HARDER, true);
      } catch { hints = undefined; }
      const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 250 });
      zxingControls = await reader.decodeFromConstraints(
        { video: { facingMode: "environment" } },
        videoRef.current,
        (result) => { if (result) handleCode(result.getText()); }
      );
      checkTorch();
    }

    (async () => {
      try {
        if (typeof window !== "undefined" && "BarcodeDetector" in window) await runNative();
        else await runZxing();
      } catch {
        if (!stopped) setErr("Couldn't start the camera. Allow camera access for this site in your browser settings, or enter the barcode number below.");
      }
    })();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (zxingControls) { try { zxingControls.stop(); } catch { /* noop */ } }
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [handleCode]);

  const toggleTorch = async () => {
    const track = videoRef.current?.srcObject?.getVideoTracks?.()[0];
    if (!track) return;
    try { await track.applyConstraints({ advanced: [{ torch: !torchOn }] }); setTorchOn((v) => !v); }
    catch { /* torch unavailable */ }
  };

  return (
    <div className="scan-overlay">
      <div className="scan-head">
        <span><ScanLine size={16} /> Scan a barcode</span>
        <button className="icon-btn sm" onClick={onClose}><X size={18} /></button>
      </div>

      {err ? (
        <p className="scan-err">{err}</p>
      ) : (
        <div className="scan-video-wrap">
          <video ref={videoRef} className="scan-video" muted playsInline autoPlay />
          <div className={`scan-reticle ${found ? "scan-reticle-ok" : busy ? "scan-reticle-busy" : ""}`} />
          {found ? (
            <div className="scan-found">
              <Check size={34} />
              <strong>{found.name}</strong>
              <span>{found.per100g.calories} kcal / 100g</span>
            </div>
          ) : (
            <p className="scan-tip">{busy ? "Looking up…" : "Point your camera at the barcode"}</p>
          )}
          {torchSupported && !found && (
            <button className={`scan-torch ${torchOn ? "on" : ""}`} onClick={toggleTorch} aria-label="toggle flashlight">
              <Flashlight size={18} />
            </button>
          )}
        </div>
      )}

      {notice && <p className="scan-notice">{notice}</p>}

      <div className="scan-manual">
        <input className="login-input" inputMode="numeric" placeholder="…or type the barcode number"
          value={manual} onChange={(e) => setManual(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && manual.length >= 6 && handleCode(manual)} />
        <button className="login-go" style={{ margin: 0 }} disabled={manual.length < 6 || busy} onClick={() => handleCode(manual)}>Look up</button>
      </div>
    </div>
  );
}

/* ---------------------------- PROFILE VIEW ------------------------ */
function ProfileView({ profile, onSave, onBack, onLogout, onRestartOnboarding }) {
  const init = profile || {};
  const [p, setP] = useState({
    sex: init.sex || "male",
    age: init.age ?? "",
    heightFt: init.heightIn != null ? Math.floor(init.heightIn / 12) : "",
    heightIn: init.heightIn != null ? init.heightIn % 12 : "",
    weightLbs: init.weightLbs ?? "",
    activity: init.activity || "moderate",
    goal: init.goal || "lose_fat",
  });
  const [override, setOverride] = useState(!!init.custom);
  const [manual, setManual] = useState(init.targets || { calories: "", protein: "", carbs: "", fat: "" });
  const [saved, setSaved] = useState(false);
  const [weights, setWeights] = useState([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [busy, setBusy] = useState("");

  // load the body-weight history for the trend chart
  useEffect(() => {
    let on = true;
    api.getWeights().then((w) => { if (on) setWeights(Array.isArray(w) ? w : []); }).catch(() => {});
    return () => { on = false; };
  }, []);

  const heightIn = (Number(p.heightFt) || 0) * 12 + (Number(p.heightIn) || 0);
  const computed = computeTargets({ ...p, heightIn });
  const targets = override ? manual : computed;

  const set = (k, v) => { setP((o) => ({ ...o, [k]: v })); setSaved(false); };

  const save = async () => {
    const payload = {
      sex: p.sex, age: Number(p.age) || null, heightIn: heightIn || null, weightLbs: Number(p.weightLbs) || null,
      activity: p.activity, goal: p.goal, custom: override,
      targets: targets && targets.calories ? {
        calories: Math.round(Number(targets.calories)) || 0,
        protein: Math.round(Number(targets.protein)) || 0,
        carbs: Math.round(Number(targets.carbs)) || 0,
        fat: Math.round(Number(targets.fat)) || 0,
      } : null,
    };
    await onSave(payload);
    // also record today's weight into the trend log
    if (Number(p.weightLbs)) {
      try { setWeights(await api.logWeight(localDayStr(), Number(p.weightLbs))); } catch { /* ignore */ }
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const logWeightToday = async () => {
    const lbs = Number(p.weightLbs);
    if (!lbs) return;
    try { setWeights(await api.logWeight(localDayStr(), lbs)); } catch { /* ignore */ }
  };

  const exportMine = async () => {
    setBusy("export");
    try {
      const data = await api.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ironlog-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
    setBusy("");
  };
  const deleteMine = async () => {
    setBusy("delete");
    try { await api.deleteAccount(); onLogout(); }
    catch { setBusy(""); }
  };

  // chart data + summary
  const wdata = weights.map((w) => {
    const [y, m, dd] = w.day.split("-").map(Number);
    return { label: fmtShort(new Date(y, m - 1, dd).getTime()), weight: w.weightLbs };
  });
  const wFirst = weights.length ? weights[0].weightLbs : null;
  const wLast = weights.length ? weights[weights.length - 1].weightLbs : null;
  const wDelta = wFirst != null ? Math.round((wLast - wFirst) * 10) / 10 : 0;

  return (
    <div className="fade-in">
      <div className="train-head">
        <button className="edit-prog-btn" onClick={onBack}><ChevronLeft size={14} /> Back</button>
        <div className="section-label" style={{ margin: 0 }}>Profile & goals</div>
        <span style={{ width: 60 }} />
      </div>

      <div className="prog-day">
        <div className="section-label" style={{ margin: "0 0 10px" }}><Scale size={13} style={{ verticalAlign: -2, marginRight: 5 }} />Body stats</div>

        <div className="seg">
          {["male", "female"].map((s) => (
            <button key={s} className={p.sex === s ? "seg-on" : ""} onClick={() => set("sex", s)}>{s === "male" ? "Male" : "Female"}</button>
          ))}
        </div>

        <div className="prof-grid">
          <div>
            <label className="field-label">Age</label>
            <input className="login-input" inputMode="numeric" value={p.age} onChange={(e) => set("age", e.target.value.replace(/[^\d]/g, ""))} />
          </div>
          <div>
            <label className="field-label">Weight (lbs)</label>
            <input className="login-input" inputMode="decimal" value={p.weightLbs} onChange={(e) => set("weightLbs", e.target.value.replace(/[^\d.]/g, ""))} />
          </div>
          <div>
            <label className="field-label">Height (ft)</label>
            <input className="login-input" inputMode="numeric" value={p.heightFt} onChange={(e) => set("heightFt", e.target.value.replace(/[^\d]/g, ""))} />
          </div>
          <div>
            <label className="field-label">Height (in)</label>
            <input className="login-input" inputMode="numeric" value={p.heightIn} onChange={(e) => set("heightIn", e.target.value.replace(/[^\d]/g, ""))} />
          </div>
        </div>

        <label className="field-label" style={{ marginTop: 12, display: "block" }}>Activity level</label>
        <select className="ex-select" value={p.activity} onChange={(e) => set("activity", e.target.value)} style={{ marginBottom: 0 }}>
          {Object.entries(ACTIVITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>

      <div className="prog-day">
        <div className="section-label" style={{ margin: "0 0 10px" }}><Target size={13} style={{ verticalAlign: -2, marginRight: 5 }} />Goal</div>
        <div className="goal-grid">
          {Object.entries(GOALS).map(([k, v]) => (
            <button key={k} className={`goal-pill ${p.goal === k ? "goal-on" : ""}`} onClick={() => set("goal", k)}>{v.label}</button>
          ))}
        </div>
      </div>

      <div className="prog-day">
        <div className="prof-targets-head">
          <div className="section-label" style={{ margin: 0 }}>Daily targets</div>
          <button className={`pin-opt ${override ? "on" : ""}`} style={{ padding: "7px 10px", fontSize: 12 }} onClick={() => setOverride((v) => !v)}>
            {override ? "Custom" : "Auto"}
          </button>
        </div>
        {!targets ? (
          <p className="footnote" style={{ margin: "6px 2px 0" }}>Fill in age, height and weight to calculate your targets.</p>
        ) : override ? (
          <div className="custom-macros">
            {MACROS.map((mc) => (
              <div key={mc.key}>
                <label className="field-label">{mc.label}</label>
                <input className="login-input" inputMode="numeric" value={manual[mc.key] ?? ""}
                  onChange={(e) => { setManual({ ...manual, [mc.key]: e.target.value.replace(/[^\d]/g, "") }); setSaved(false); }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="macro-grid" style={{ marginTop: 4 }}>
            {MACROS.map((mc) => (
              <div className="macro-stat" key={mc.key}>
                <div className="macro-top"><span className="macro-label">{mc.label}</span></div>
                <span className="macro-val" style={{ color: mc.color, fontSize: 22 }}>{computed[mc.key]}</span>
                <span className="macro-unit">{mc.unit}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="prog-day">
        <div className="prof-targets-head">
          <div className="section-label" style={{ margin: 0 }}><TrendingUp size={13} style={{ verticalAlign: -2, marginRight: 5 }} />Body-weight trend</div>
          <button className="edit-prog-btn" onClick={logWeightToday} disabled={!Number(p.weightLbs)}>Log today</button>
        </div>
        {weights.length >= 2 ? (
          <>
            <div className="stat-row" style={{ margin: "4px 0 12px" }}>
              <div className="stat"><span className="stat-n">{wLast}</span><span className="stat-l">current lbs</span></div>
              <div className="stat"><span className="stat-n">{wDelta === 0 ? "0" : (wDelta < 0 ? `−${Math.abs(wDelta)}` : `+${wDelta}`)}</span><span className="stat-l">since start</span></div>
              <div className="stat"><span className="stat-n">{weights.length}</span><span className="stat-l">entries</span></div>
            </div>
            <div className="chart-box">
              <Suspense fallback={<ChartFallback />}>
                <TrendChart data={wdata} yKey="weight" color="#46d9ff" height={200} format={(v) => [`${v} lbs`, "weight"]} />
              </Suspense>
            </div>
          </>
        ) : (
          <p className="footnote" style={{ margin: "8px 2px 0" }}>
            Tap <strong>Log today</strong> (or just save your profile) on a few different days and your weight trend will chart here.
          </p>
        )}
      </div>

      <button className="add-day-btn" onClick={save}>{saved ? "Saved ✓" : "Save profile"}</button>

      <div className="prog-day" style={{ marginTop: 14 }}>
        <div className="section-label" style={{ margin: "0 0 10px" }}>Data &amp; account</div>
        <button className="backup-btn" style={{ width: "100%" }} onClick={exportMine} disabled={busy === "export"}>
          <Download size={15} /> {busy === "export" ? "Preparing…" : "Export my data (JSON)"}
        </button>
        <button className="backup-btn" style={{ width: "100%", marginTop: 10 }} onClick={() => setConfirmRestart(true)}>
          <RotateCcw size={15} /> Restart onboarding
        </button>
        <button className="btn-danger" style={{ width: "100%", marginTop: 10 }} onClick={() => setConfirmDelete(true)}>
          <Trash2 size={14} /> Delete account
        </button>
        <p className="footnote" style={{ margin: "10px 2px 0" }}>
          Export downloads all your workouts, meals, program &amp; weight history. Deleting your
          account erases everything permanently.
        </p>
      </div>

      <button className="login-back" style={{ width: "100%", marginTop: 14 }} onClick={onLogout}><LogOut size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Sign out</button>

      {confirmRestart && (
        <div className="modal-bg" onClick={() => setConfirmRestart(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Restart onboarding?</h3>
            <p>This takes you back through setup (your details &amp; program choice). Your <strong>workout history is kept</strong>, but your current program is cleared and you'll pick again.</p>
            <div className="modal-btns">
              <button className="btn-ghost" onClick={() => setConfirmRestart(false)}>Cancel</button>
              <button className="login-go" style={{ flex: 1, margin: 0 }} onClick={() => { setConfirmRestart(false); onRestartOnboarding(); }}>Restart</button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-bg" onClick={() => setConfirmDelete(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete your account?</h3>
            <p>This permanently erases your account and <strong>all</strong> your data — workouts, meals, program, and weight history. This cannot be undone.</p>
            <div className="modal-btns">
              <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button className="btn-danger" onClick={deleteMine} disabled={busy === "delete"}>{busy === "delete" ? "Deleting…" : "Delete forever"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/*  PROGRAM EDITOR                                                     */
/* ================================================================== */
function ProgramView({ program, onChange, onReset }) {
  const days = program || [];
  const [confirmReset, setConfirmReset] = useState(false);

  // every edit clones the program and pushes it up (App debounces the save)
  const mutate = (fn) => {
    const copy = structuredClone(days);
    fn(copy);
    onChange(copy);
  };

  const addDay = () => mutate((d) => {
    const color = DAY_PALETTE[d.length % DAY_PALETTE.length];
    d.push({ key: uid(), name: "New Day", focus: "", tag: "DAY", color, exercises: [] });
  });
  const delDay = (i) => mutate((d) => d.splice(i, 1));
  const moveDay = (i, dir) => mutate((d) => {
    const j = i + dir;
    if (j < 0 || j >= d.length) return;
    [d[i], d[j]] = [d[j], d[i]];
  });
  const setDayField = (i, field, val) => mutate((d) => { d[i][field] = val; });

  const addEx = (i) => mutate((d) => d[i].exercises.push({ key: uid(), name: "New Exercise", variations: [], sets: 3 }));
  const delEx = (i, j) => mutate((d) => d[i].exercises.splice(j, 1));
  const moveEx = (i, j, dir) => mutate((d) => {
    const ex = d[i].exercises, k = j + dir;
    if (k < 0 || k >= ex.length) return;
    [ex[j], ex[k]] = [ex[k], ex[j]];
  });
  const setExField = (i, j, field, val) => mutate((d) => { d[i].exercises[j][field] = val; });

  return (
    <div className="fade-in">
      <div className="train-head">
        <div className="section-label" style={{ margin: 0 }}>Your program · {days.length} day{days.length === 1 ? "" : "s"}</div>
        <button className="edit-prog-btn" onClick={() => setConfirmReset(true)}><RotateCcw size={13} /> Reset</button>
      </div>

      {days.map((day, i) => (
        <div className="prog-day" key={day.key}>
          <div className="prog-day-head">
            <span className="color-dot" style={{ background: day.color || "var(--accent)" }} />
            <input
              className="prog-input prog-day-name"
              value={day.name}
              placeholder="Day name"
              onChange={(e) => setDayField(i, "name", e.target.value)}
            />
            <div className="prog-move">
              <button onClick={() => moveDay(i, -1)} disabled={i === 0} aria-label="move day up"><ChevronUp size={16} /></button>
              <button onClick={() => moveDay(i, 1)} disabled={i === days.length - 1} aria-label="move day down"><ChevronDown size={16} /></button>
              <button className="prog-del" onClick={() => delDay(i)} aria-label="delete day"><Trash2 size={15} /></button>
            </div>
          </div>

          <div className="prog-day-meta">
            <input
              className="prog-input prog-tag"
              value={day.tag || ""}
              maxLength={5}
              placeholder="TAG"
              onChange={(e) => setDayField(i, "tag", e.target.value.toUpperCase())}
            />
            <input
              className="prog-input"
              value={day.focus || ""}
              placeholder="Focus (e.g. Chest Bias)"
              onChange={(e) => setDayField(i, "focus", e.target.value)}
            />
          </div>

          <div className="prog-colors">
            {DAY_PALETTE.map((c) => (
              <button
                key={c}
                className={`swatch ${day.color === c ? "swatch-on" : ""}`}
                style={{ background: c }}
                onClick={() => setDayField(i, "color", c)}
                aria-label="pick color"
              />
            ))}
          </div>

          {day.exercises.map((ex, j) => (
            <ExerciseRow
              key={ex.key}
              ex={ex}
              canUp={j > 0}
              canDown={j < day.exercises.length - 1}
              onField={(field, val) => setExField(i, j, field, val)}
              onMove={(dir) => moveEx(i, j, dir)}
              onDelete={() => delEx(i, j)}
            />
          ))}

          <button className="add-set" onClick={() => addEx(i)}>
            <Plus size={15} /> Add exercise
          </button>
        </div>
      ))}

      <button className="add-day-btn" onClick={addDay}>
        <Plus size={16} /> Add day
      </button>
      <p className="footnote">
        Changes save to your account automatically. Editing your program never changes
        workouts you've already finished.
      </p>

      {confirmReset && (
        <div className="modal-bg" onClick={() => setConfirmReset(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Reset to default program?</h3>
            <p>This replaces your current program with the original 4-day split. Your finished workout history is not affected.</p>
            <div className="modal-btns">
              <button className="btn-ghost" onClick={() => setConfirmReset(false)}>Cancel</button>
              <button className="btn-danger" onClick={() => { onReset(); setConfirmReset(false); }}>Reset</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// One editable exercise row. Variations are kept as a local text string while
// typing (so commas don't vanish) and committed to the array on each change.
function ExerciseRow({ ex, canUp, canDown, onField, onMove, onDelete }) {
  const [varStr, setVarStr] = useState((ex.variations || []).join(", "));
  const sets = Math.max(1, Number(ex.sets) || 1);

  const onVarChange = (v) => {
    setVarStr(v);
    onField("variations", v.split(",").map((s) => s.trim()).filter(Boolean));
  };

  return (
    <div className="prog-ex">
      <div className="prog-ex-top">
        <input
          className="prog-input"
          value={ex.name}
          placeholder="Exercise name"
          onChange={(e) => onField("name", e.target.value)}
        />
        <div className="prog-move">
          <button onClick={() => onMove(-1)} disabled={!canUp} aria-label="move up"><ChevronUp size={15} /></button>
          <button onClick={() => onMove(1)} disabled={!canDown} aria-label="move down"><ChevronDown size={15} /></button>
          <button className="prog-del" onClick={onDelete} aria-label="delete exercise"><X size={15} /></button>
        </div>
      </div>
      <div className="prog-ex-bot">
        <input
          className="prog-input prog-var"
          value={varStr}
          placeholder="Variations, comma-separated (optional)"
          onChange={(e) => onVarChange(e.target.value)}
        />
        <div className="sets-step">
          <button onClick={() => onField("sets", Math.max(1, sets - 1))} aria-label="fewer sets">−</button>
          <span>{sets} <i>set{sets === 1 ? "" : "s"}</i></span>
          <button onClick={() => onField("sets", Math.min(10, sets + 1))} aria-label="more sets">+</button>
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/*  STYLES + FONTS                                                     */
/* ================================================================== */
function FontsAndStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Archivo:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');

      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
      /* Mobile: stable text size on rotation; no pull-to-refresh mid-workout;
         instant taps (no double-tap-zoom wait) and no accidental long-press
         text selection on controls. */
      html { -webkit-text-size-adjust:100%; text-size-adjust:100%; }
      html, body { overscroll-behavior-y:none; }
      button, select, input, textarea { touch-action:manipulation; }
      button { -webkit-user-select:none; user-select:none; }
      /* Theme vars on :root too, so portaled UI (the rest popup) inherits them
         even though it renders outside .wt-root on document.body. */
      :root {
        --bg:#0a0b0d; --surface:#15171b; --surface2:#1d2025; --line:#2a2e36;
        --text:#f2f4f5; --muted:#8b9199; --accent:#d8ff36; --danger:#ff5a4d;
      }
      .wt-root {
        --bg:#0a0b0d; --surface:#15171b; --surface2:#1d2025; --line:#2a2e36;
        --text:#f2f4f5; --muted:#8b9199; --accent:#d8ff36; --danger:#ff5a4d;
        position:relative; min-height:100vh; min-height:100dvh; background:
          radial-gradient(900px 500px at 90% -10%, rgba(216,255,54,.06), transparent 60%),
          radial-gradient(700px 500px at -10% 110%, rgba(216,255,54,.04), transparent 60%),
          var(--bg);
        color:var(--text); font-family:'Archivo',sans-serif;
        max-width:560px; margin:0 auto; padding-bottom:env(safe-area-inset-bottom);
        overflow-x:hidden;
      }
      .grain { pointer-events:none; position:fixed; inset:0; z-index:0; opacity:.035;
        background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
      .wt-root > *:not(.grain){ position:relative; z-index:1; }

      h1,h2,h3 { margin:0; font-family:'Oswald',sans-serif; letter-spacing:.02em; }
      .loader { display:flex; flex-direction:column; align-items:center; justify-content:center;
        min-height:100vh; min-height:100dvh; gap:14px; color:var(--muted); }
      .loader svg { color:var(--accent); animation:pulse 1.4s ease-in-out infinite; }
      @keyframes pulse { 0%,100%{opacity:.4; transform:scale(.95)} 50%{opacity:1; transform:scale(1.05)} }

      /* TOPBAR */
      .topbar { padding:calc(26px + env(safe-area-inset-top)) 20px 14px; display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
      .brand { display:flex; align-items:center; gap:13px; }
      .brand-mark { font-size:34px; color:var(--accent); line-height:1; transform:translateY(-2px); }
      .brand-mark.big { font-size:54px; }
      .brand h1 { font-size:30px; font-weight:700; line-height:1; }
      .brand p { margin:3px 0 0; font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); }

      .profile-chip { display:flex; align-items:center; gap:8px; background:var(--surface2); border:1px solid var(--line);
        color:var(--text); border-radius:99px; padding:6px 11px 6px 6px; cursor:pointer; flex-shrink:0; }
      .profile-chip svg { color:var(--muted); }
      .profile-name { font-family:'Oswald'; font-weight:600; font-size:14px; max-width:90px; overflow:hidden;
        text-overflow:ellipsis; white-space:nowrap; }
      .avatar { width:26px; height:26px; border-radius:99px; background:var(--accent); color:#101200;
        display:flex; align-items:center; justify-content:center; font-family:'Oswald'; font-weight:700; font-size:14px; flex-shrink:0; }
      .avatar.lg { width:42px; height:42px; font-size:20px; }
      .avatar-img { object-fit:cover; }

      .sync-error { margin:0 16px; padding:10px 13px; background:rgba(255,90,77,.12);
        border:1px solid var(--danger); border-radius:10px; color:var(--danger); font-size:12.5px;
        font-family:'Archivo'; cursor:pointer; }
      .sync-pending { margin:0 16px 6px; padding:10px 13px; background:rgba(255,177,62,.1);
        border:1px solid rgba(255,177,62,.4); border-radius:10px; color:#ffb13e; font-size:12.5px;
        font-family:'Archivo'; cursor:pointer; display:flex; align-items:center; gap:8px; line-height:1.4; }
      .sync-pending svg { flex-shrink:0; }

      .update-banner { position:sticky; top:0; z-index:30; width:100%; display:flex; align-items:center;
        justify-content:center; gap:8px; background:var(--accent); color:#101200; border:none;
        font-family:'Archivo'; font-weight:700; font-size:13px; padding:11px; cursor:pointer;
        box-shadow:0 4px 16px rgba(0,0,0,.4); }
      .update-banner svg { color:#101200; }

      .demo-banner { width:100%; text-align:center; background:rgba(216,255,54,.08);
        border-bottom:1px solid rgba(216,255,54,.25); color:var(--accent);
        font-family:'Archivo'; font-size:12px; font-weight:600; padding:7px 14px; }

      /* LOGIN */
      .login { min-height:100vh; min-height:100dvh; display:flex; flex-direction:column; align-items:center; justify-content:center;
        padding:calc(30px + env(safe-area-inset-top)) 24px calc(30px + env(safe-area-inset-bottom)); max-width:460px; margin:0 auto; }
      .login-brand { text-align:center; margin-bottom:34px; }
      .login-brand h1 { font-size:42px; font-weight:700; margin-top:6px; }
      .login-brand p { margin:8px 0 0; font-size:13px; letter-spacing:.06em; color:var(--muted); }
      .profile-list { width:100%; display:flex; flex-direction:column; gap:11px; }
      .profile-row { display:flex; gap:9px; }
      .profile-pick { flex:1; display:flex; align-items:center; gap:13px; background:var(--surface); border:1px solid var(--line);
        border-radius:14px; padding:14px; cursor:pointer; color:var(--text); transition:border-color .15s, transform .12s; }
      .profile-pick:active { transform:scale(.985); }
      .profile-pick:hover { border-color:#3a4150; }
      .profile-pick svg { color:var(--muted); margin-left:auto; }
      .profile-pick-name { font-family:'Oswald'; font-weight:600; font-size:19px; }
      .profile-del { width:48px; border:1px solid var(--line); background:var(--surface); border-radius:14px; color:#565b63;
        cursor:pointer; display:flex; align-items:center; justify-content:center; }
      .profile-del:active { color:var(--danger); border-color:var(--danger); }
      .add-profile { display:flex; align-items:center; justify-content:center; gap:8px; background:none;
        border:1px dashed var(--line); color:var(--muted); font-family:'Archivo'; font-weight:600; font-size:14px;
        padding:14px; border-radius:14px; cursor:pointer; margin-top:4px; transition:all .15s; }
      .add-profile:active { border-color:var(--accent); color:var(--accent); }

      .login-form { width:100%; display:flex; flex-direction:column; gap:11px; }
      .field-label { font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
      .login-input { width:100%; background:var(--surface); border:1px solid var(--line); border-radius:12px; color:var(--text);
        font-family:'Archivo'; font-weight:600; font-size:17px; padding:14px; outline:none; transition:border-color .15s; }
      .login-input:focus { border-color:var(--accent); }
      .login-input.center { text-align:center; letter-spacing:.4em; font-size:24px; }
      .pin-opt { display:flex; align-items:center; gap:8px; background:var(--surface); border:1px solid var(--line);
        color:var(--muted); font-family:'Archivo'; font-weight:600; font-size:13px; padding:12px 14px; border-radius:12px; cursor:pointer; }
      .pin-opt.on { border-color:var(--accent); color:var(--accent); }
      .pin-who { display:flex; align-items:center; gap:12px; justify-content:center; font-family:'Oswald'; font-weight:600;
        font-size:20px; margin-bottom:6px; }
      .login-err { color:var(--danger); font-size:13px; font-weight:600; text-align:center; }
      .login-go { background:var(--accent); color:#101200; border:none; border-radius:13px; font-family:'Oswald';
        font-weight:700; font-size:17px; letter-spacing:.03em; padding:15px; cursor:pointer; margin-top:4px;
        box-shadow:0 8px 24px rgba(216,255,54,.16); }
      .login-go:active { transform:scale(.98); }
      .login-back { background:none; border:none; color:var(--muted); font-family:'Archivo'; font-size:13px; cursor:pointer; padding:6px; }
      .login-note { font-size:11.5px; line-height:1.6; color:var(--muted); text-align:center; margin:8px 0 0; }
      .gbtn-wrap { display:flex; justify-content:center; min-height:44px; margin:6px 0 2px; color-scheme:light; }
      .signin { display:flex; flex-direction:column; align-items:center; gap:8px; }

      /* LANDING */
      .landing { max-width:560px; margin:0 auto; padding:calc(40px + env(safe-area-inset-top)) 22px calc(40px + env(safe-area-inset-bottom)); }
      .lp-hero { text-align:center; display:flex; flex-direction:column; align-items:center; }
      .lp-hero h1 { font-size:46px; font-weight:700; margin-top:4px; }
      .lp-tag { margin:14px 0 0; font-family:'Oswald'; font-weight:600; font-size:22px; color:var(--text); line-height:1.25; max-width:360px; }
      .lp-sub { margin:10px 0 0; font-size:14px; line-height:1.6; color:var(--muted); max-width:360px; }
      .lp-cta { margin:24px 0 10px; }
      .demo-cta { margin:0 0 16px; display:flex; flex-direction:column; align-items:center; gap:6px; }
      .demo-btn { display:flex; align-items:center; gap:8px; background:var(--surface2);
        border:1px solid var(--line); color:var(--text); font-family:'Archivo'; font-weight:600;
        font-size:14px; padding:11px 22px; border-radius:999px; cursor:pointer; transition:all .15s; }
      .demo-btn:hover, .demo-btn:active { border-color:var(--accent); color:var(--accent); }
      .demo-btn:disabled { opacity:.6; cursor:default; }
      .demo-btn svg { color:var(--accent); }
      .lp-features { display:grid; gap:12px; margin:34px 0 0; }
      .lp-card { background:linear-gradient(150deg, var(--surface2), var(--surface)); border:1px solid var(--line);
        border-radius:16px; padding:18px; }
      .lp-ico { display:inline-flex; align-items:center; justify-content:center; width:42px; height:42px; border-radius:11px;
        background:rgba(216,255,54,.1); color:var(--accent); border:1px solid rgba(216,255,54,.3); }
      .lp-card h3 { font-size:18px; font-weight:600; margin:12px 0 0; }
      .lp-card p { margin:6px 0 0; font-size:13px; line-height:1.6; color:var(--muted); }
      .lp-strip { display:flex; flex-wrap:wrap; justify-content:center; gap:10px 18px; margin:26px 0 0; }
      .lp-strip span { display:flex; align-items:center; gap:6px; font-family:'Space Mono',monospace; font-size:11px;
        font-weight:700; color:var(--muted); }
      .lp-strip svg { color:var(--accent); }
      .lp-foot { text-align:center; margin:26px 0 0; font-size:12px; color:var(--muted); }

      .content { padding:8px 16px 110px; }
      .section-label { font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); margin:14px 4px 14px; }

      /* DAY CARDS */
      .day-grid { display:grid; gap:13px; }
      .day-card { text-align:left; background:linear-gradient(150deg, var(--surface2), var(--surface));
        border:1px solid var(--line); border-radius:16px; padding:18px; cursor:pointer; color:var(--text);
        position:relative; overflow:hidden; opacity:0; animation:rise .5s ease forwards;
        transition:border-color .2s, transform .12s; }
      .day-card:active { transform:scale(.985); }
      .day-card:hover { border-color:#3a4150; }
      .day-card::before { content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--day-accent, var(--accent)); }
      .day-card-top { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
      .day-tag { font-family:'Space Mono',monospace; font-size:11px; font-weight:700; letter-spacing:.06em;
        background:var(--accent); color:#101200; padding:3px 8px; border-radius:6px; }
      .day-tag.sm { font-size:10px; padding:2px 6px; }
      .day-last { font-size:11px; color:var(--muted); font-family:'Space Mono',monospace; }
      .day-name { font-size:22px; font-weight:600; }
      .day-focus { display:flex; align-items:center; gap:6px; margin:5px 0 0; color:var(--accent); font-size:13px; font-weight:600; }
      .day-focus svg { color:var(--accent); }
      .day-meta { font-size:12px; color:var(--muted); margin-top:9px; }
      .day-go { display:inline-flex; align-items:center; gap:7px; margin-top:14px; font-family:'Oswald';
        font-weight:600; font-size:14px; letter-spacing:.04em; color:var(--accent);
        border:1px solid var(--accent); padding:7px 14px; border-radius:9px; }
      .footnote { margin:22px 6px 0; font-size:12px; line-height:1.6; color:var(--muted); }

      /* TABBAR */
      .tabbar { position:fixed; bottom:0; left:50%; transform:translateX(-50%); width:100%; max-width:560px;
        display:flex; background:rgba(13,14,17,.86); backdrop-filter:blur(14px);
        border-top:1px solid var(--line); padding:8px 8px calc(8px + env(safe-area-inset-bottom)); z-index:5; }
      .tab { flex:1; display:flex; flex-direction:column; align-items:center; gap:3px; background:none; border:none;
        color:var(--muted); font-family:'Archivo'; font-size:11px; font-weight:600; padding:7px 0; cursor:pointer;
        border-radius:11px; transition:color .15s, background .15s; }
      .tab span { letter-spacing:.02em; }
      .tab-on { color:var(--accent); background:rgba(216,255,54,.08); }

      /* SESSION */
      .session { min-height:100vh; min-height:100dvh; display:flex; flex-direction:column; }
      .session-head { position:sticky; top:0; z-index:6; display:flex; align-items:center; gap:10px;
        padding:calc(16px + env(safe-area-inset-top)) 14px 12px; border-bottom:1px solid var(--line);
        background:rgba(10,11,13,.92); backdrop-filter:blur(14px); }
      .icon-btn { background:var(--surface2); border:1px solid var(--line); color:var(--text); border-radius:11px;
        width:42px; height:42px; display:flex; align-items:center; justify-content:center; cursor:pointer; flex-shrink:0; }
      .icon-btn.timer-on { border-color:var(--accent); color:var(--accent); }
      .timer-btn { min-width:42px; width:auto; padding:0 10px; }
      .timer-live { animation:timerpulse 1.6s ease-in-out infinite; }
      @keyframes timerpulse { 0%,100%{ box-shadow:0 0 0 0 rgba(216,255,54,0); } 50%{ box-shadow:0 0 0 4px rgba(216,255,54,.12); } }
      .timer-count { font-family:'Space Mono',monospace; font-size:15px; font-weight:700; letter-spacing:.02em; }
      .session-title { flex:1; display:flex; align-items:center; gap:10px; min-width:0; }
      .session-title h2 { font-size:18px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .session-title p { margin:1px 0 0; font-size:12px; color:var(--accent); }

      .progress-wrap { display:flex; align-items:center; gap:10px; padding:12px 18px; }
      .progress-bar { flex:1; height:6px; background:var(--surface2); border-radius:99px; overflow:hidden; }
      .progress-fill { height:100%; background:var(--accent); border-radius:99px; transition:width .35s ease; }
      .progress-txt { font-family:'Space Mono',monospace; font-size:12px; color:var(--muted); }

      .date-row { padding:0 18px 6px; }
      .date-field { position:relative; display:flex; align-items:center; gap:9px; background:var(--surface2);
        border:1px solid var(--line); border-radius:11px; padding:11px 13px; cursor:pointer; color:var(--accent);
        transition:border-color .15s; }
      .date-field:active { border-color:var(--accent); }
      .date-text { flex:1; font-family:'Space Mono',monospace; font-size:13px; font-weight:700; color:var(--text); }
      .date-input { position:absolute; inset:0; opacity:0; width:100%; height:100%; cursor:pointer;
        font-size:16px; border:none; }

      .session-body { flex:1; padding:6px 14px 0; }
      .ex-card { background:var(--surface); border:1px solid var(--line); border-radius:15px; padding:15px; margin-bottom:13px; }
      .ex-head { display:flex; align-items:baseline; gap:9px; }
      .ex-num { font-family:'Space Mono',monospace; font-size:12px; color:var(--accent); font-weight:700; }
      .ex-head h3 { font-size:17px; font-weight:600; }
      .howto-btn { margin-left:auto; align-self:center; display:flex; align-items:center; gap:5px; flex-shrink:0;
        background:var(--surface2); border:1px solid var(--line); color:var(--muted); font-family:'Archivo';
        font-weight:600; font-size:11px; padding:5px 10px; border-radius:99px; cursor:pointer; }
      .howto-btn:active { border-color:var(--accent); color:var(--accent); }
      .howto-btn svg { color:var(--accent); }

      /* EXERCISE GUIDE MODAL */
      .help-modal { position:relative; background:var(--surface); border:1px solid var(--line); border-radius:18px;
        padding:16px; width:100%; max-width:440px; max-height:86vh; display:flex; flex-direction:column; overflow:hidden; }
      .help-body { overflow-y:auto; }
      .help-img-wrap { width:100%; aspect-ratio:5/4; background:#fff; border-radius:12px; overflow:hidden; margin-bottom:12px; }
      .help-img { width:100%; height:100%; object-fit:contain; }
      .help-muscles { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--accent);
        font-family:'Space Mono',monospace; text-transform:capitalize; margin:0 0 10px; }
      .help-steps { margin:0; padding-left:20px; display:flex; flex-direction:column; gap:9px; }
      .help-steps li { font-size:13.5px; line-height:1.55; color:var(--text); }
      .help-steps li::marker { color:var(--accent); font-family:'Space Mono',monospace; font-weight:700; }
      .help-note { margin:12px 2px 0; font-size:11.5px; color:var(--muted); line-height:1.5; }
      .help-empty { padding:24px 14px; color:var(--muted); font-size:13.5px; line-height:1.6; text-align:center; }
      .howto-video { display:flex; align-items:center; justify-content:center; gap:8px; margin-top:12px; flex-shrink:0;
        background:var(--surface2); border:1px solid var(--line); color:var(--text); text-decoration:none;
        font-family:'Archivo'; font-weight:600; font-size:13px; padding:12px; border-radius:11px; }
      .howto-video:active { border-color:var(--accent); color:var(--accent); }
      .howto-video svg { color:var(--accent); }

      .var-row { display:flex; flex-wrap:wrap; gap:7px; margin:11px 0 4px; }
      .var-pill { background:var(--surface2); border:1px solid var(--line); color:var(--muted); font-family:'Archivo';
        font-size:12px; font-weight:600; padding:6px 11px; border-radius:99px; cursor:pointer; transition:all .15s; }
      .var-pill:active { transform:scale(.95); }
      .var-on { background:var(--accent); color:#101200; border-color:var(--accent); }

      .last-ref { margin:10px 0 2px; padding:9px 11px; background:var(--surface2); border-radius:10px;
        display:flex; flex-direction:column; gap:6px; }
      .last-label { font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
      .last-sets { display:flex; flex-wrap:wrap; gap:6px; }
      .last-chip { font-family:'Space Mono',monospace; font-size:12px; background:#0e1013; border:1px solid var(--line);
        padding:3px 8px; border-radius:7px; color:var(--text); }
      .last-chip i { color:var(--muted); font-style:normal; margin:0 2px; }

      .sets { margin-top:12px; }
      .set-row { display:grid; grid-template-columns:40px 1fr 1fr 84px; align-items:center; gap:8px; margin-bottom:8px; }
      .set-header { margin-bottom:6px; }
      .set-header span { font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); text-align:center; }
      .set-header span:first-child { text-align:left; padding-left:4px; }
      .set-idx { font-family:'Space Mono',monospace; font-weight:700; color:var(--muted); text-align:center; }
      .set-input { width:100%; background:var(--surface2); border:1px solid var(--line); border-radius:9px;
        color:var(--text); font-family:'Space Mono',monospace; font-size:15px; font-weight:700; text-align:center;
        padding:11px 4px; outline:none; transition:border-color .15s; }
      .set-input:focus { border-color:var(--accent); }
      .set-input::placeholder { color:#565b63; font-weight:400; }
      .set-actions { display:flex; gap:6px; justify-content:flex-end; }
      .check { width:38px; height:38px; border-radius:9px; border:1px solid var(--line); background:var(--surface2);
        color:var(--muted); display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all .15s; }
      .check-on { background:var(--accent); border-color:var(--accent); color:#101200; }
      .del-set { width:30px; height:38px; border-radius:9px; border:none; background:none; color:#565b63; cursor:pointer;
        display:flex; align-items:center; justify-content:center; }
      .del-set:active { color:var(--danger); }
      .set-done .set-input { border-color:rgba(216,255,54,.4); }
      .rest-log { display:flex; align-items:center; gap:5px; font-family:'Space Mono',monospace; font-size:10px;
        letter-spacing:.04em; color:var(--muted); margin:-2px 0 8px 48px; }
      .rest-log svg { color:var(--accent); }
      .hist-rest { display:flex; align-items:center; gap:5px; font-family:'Space Mono',monospace; font-size:10px;
        color:var(--muted); margin-top:8px; }
      .hist-rest svg { color:var(--accent); }
      .hist-meta { display:flex; flex-wrap:wrap; gap:14px; margin-top:9px; }
      .hist-meta span { display:flex; align-items:center; gap:5px; font-family:'Space Mono',monospace; font-size:10px;
        letter-spacing:.03em; color:var(--muted); }
      .hist-meta svg { color:var(--accent); }

      .pr-badge { display:inline-flex; align-items:center; gap:3px; vertical-align:middle; margin-left:7px;
        font-family:'Space Mono',monospace; font-size:10px; font-weight:700; letter-spacing:.04em;
        background:var(--accent); color:#101200; padding:2px 7px; border-radius:99px; }
      .pr-badge.sm { font-size:9px; padding:1px 6px; margin-left:6px; }
      .pr-badge svg { color:#101200; }

      .sound-on { color:var(--accent) !important; border-color:var(--accent) !important; }

      .backup-wrap { margin-top:22px; }
      .backup { display:flex; gap:10px; }
      .backup-btn { flex:1; display:flex; align-items:center; justify-content:center; gap:7px; background:var(--surface);
        border:1px solid var(--line); color:var(--text); font-family:'Archivo'; font-weight:600; font-size:13px;
        padding:13px; border-radius:12px; cursor:pointer; transition:border-color .15s; }
      .backup-btn:active { border-color:var(--accent); color:var(--accent); }
      .backup-btn:disabled { opacity:.4; cursor:not-allowed; }
      .backup-msg { margin-top:10px; padding:10px 13px; background:rgba(216,255,54,.1); border:1px solid var(--accent);
        border-radius:10px; color:var(--accent); font-size:12px; font-family:'Space Mono',monospace; text-align:center; }

      .metric-tabs { display:flex; gap:6px; background:var(--surface2); border:1px solid var(--line); border-radius:12px;
        padding:4px; margin-bottom:14px; }
      .metric-tabs button { flex:1; background:none; border:none; color:var(--muted); font-family:'Oswald';
        font-weight:600; font-size:14px; letter-spacing:.03em; padding:9px; border-radius:9px; cursor:pointer; transition:all .15s; }
      .metric-tabs button.mt-on { background:var(--accent); color:#101200; }

      /* ACHIEVEMENTS */
      .badge-grid { display:flex; flex-direction:column; gap:10px; }
      .badge { display:flex; align-items:center; gap:12px; background:var(--surface); border:1px solid var(--line);
        border-radius:14px; padding:13px 14px; opacity:.55; transition:opacity .2s; }
      .badge-on { opacity:1; border-color:rgba(216,255,54,.4); }
      .badge-ico { width:44px; height:44px; flex-shrink:0; border-radius:11px; display:flex; align-items:center;
        justify-content:center; background:var(--surface2); color:var(--muted); border:1px solid var(--line); }
      .badge-on .badge-ico { background:rgba(216,255,54,.12); color:var(--accent); border-color:rgba(216,255,54,.4); }
      .badge-text { flex:1; min-width:0; }
      .badge-text strong { font-family:'Oswald'; font-weight:600; font-size:16px; display:block; }
      .badge-text span { font-size:12px; color:var(--muted); }
      .badge-check { width:30px; height:30px; flex-shrink:0; border-radius:99px; background:var(--accent); color:#101200;
        display:flex; align-items:center; justify-content:center; }
      .badge-prog { width:54px; flex-shrink:0; height:6px; background:var(--surface2); border-radius:99px; overflow:hidden; }
      .badge-prog-fill { height:100%; background:var(--muted); border-radius:99px; }

      .add-set { margin-top:6px; width:100%; background:none; border:1px dashed var(--line); color:var(--muted);
        font-family:'Archivo'; font-weight:600; font-size:13px; padding:10px; border-radius:10px; cursor:pointer;
        display:flex; align-items:center; justify-content:center; gap:6px; transition:all .15s; }
      .add-set:active { border-color:var(--accent); color:var(--accent); }

      /* NOTES (session + per-exercise) */
      .note-row { padding:0 18px 6px; }
      .session-note { width:100%; background:var(--surface2); border:1px solid var(--line); color:var(--text);
        font-family:'Archivo'; font-size:14px; line-height:1.45; padding:11px 13px; border-radius:11px; resize:vertical;
        min-height:46px; }
      .session-note::placeholder { color:var(--muted); }
      .session-note:focus { outline:none; border-color:var(--accent); }
      .ex-note { width:100%; margin-top:6px; background:none; border:1px dashed var(--line); color:var(--text);
        font-family:'Archivo'; font-size:13px; padding:10px; border-radius:10px; }
      .ex-note::placeholder { color:var(--muted); }
      .ex-note:focus { outline:none; border-style:solid; border-color:var(--accent); }
      .hist-note { display:flex; align-items:flex-start; gap:7px; background:var(--surface2); border:1px solid var(--line);
        border-radius:10px; padding:9px 11px; font-size:13px; line-height:1.45; color:var(--text); margin-bottom:12px; }
      .hist-note svg { color:var(--accent); flex-shrink:0; margin-top:2px; }
      .hist-ex-note { margin-top:5px; font-size:12.5px; font-style:italic; color:var(--muted); line-height:1.4; }

      /* LOG A PAST WORKOUT */
      .log-past-btn { width:100%; display:flex; align-items:center; justify-content:center; gap:8px; margin-top:14px;
        background:var(--surface); border:1px solid var(--line); color:var(--text); font-family:'Archivo'; font-weight:600;
        font-size:13.5px; padding:13px; border-radius:12px; cursor:pointer; }
      .log-past-btn:active { border-color:var(--accent); color:var(--accent); }
      .log-past-btn svg { color:var(--accent); }

      .finish-bar { position:fixed; bottom:0; left:50%; transform:translateX(-50%); width:100%; max-width:560px;
        padding:14px 16px calc(16px + env(safe-area-inset-bottom)); background:linear-gradient(transparent, var(--bg) 30%); z-index:4; }
      .finish-btn { width:100%; background:var(--accent); color:#101200; border:none; border-radius:13px;
        font-family:'Oswald'; font-weight:700; font-size:17px; letter-spacing:.03em; padding:16px; cursor:pointer;
        box-shadow:0 8px 24px rgba(216,255,54,.18); transition:transform .12s; }
      .finish-btn:active { transform:scale(.98); }

      /* REST POPOVER */
      .rest { position:relative; }
      .rest-pop { position:absolute; right:0; top:52px; width:228px; background:var(--surface); border:1px solid var(--line);
        border-radius:14px; padding:13px; z-index:20; box-shadow:0 16px 40px rgba(0,0,0,.5); }
      .rest-big { font-family:'Space Mono',monospace; font-size:34px; font-weight:700; text-align:center; color:var(--accent); line-height:1.1; }
      .rest-track { height:5px; background:var(--surface2); border-radius:99px; overflow:hidden; margin:8px 0 2px; }
      .rest-track-fill { height:100%; background:var(--accent); border-radius:99px; transition:width .25s linear; }
      .rest-adjust { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin:8px 0; }
      .rest-adjust button { background:var(--surface2); border:1px solid var(--line); color:var(--text);
        font-family:'Space Mono',monospace; font-size:12px; padding:8px 0; border-radius:8px; cursor:pointer; }
      .rest-adjust button:active:not(:disabled) { background:var(--accent); color:#101200; }
      .rest-adjust button:disabled { opacity:.4; }
      .rest-custom { display:flex; align-items:center; gap:6px; margin:0 0 8px; }
      .rest-custom-input { flex:1; min-width:0; background:var(--surface2); border:1px solid var(--line); color:var(--text);
        font-family:'Space Mono',monospace; font-size:13px; text-align:center; padding:8px 6px; border-radius:8px; }
      .rest-custom-input::placeholder { color:var(--muted); font-size:11px; }
      .rest-custom-unit { font-size:11px; color:var(--muted); font-family:'Space Mono',monospace; }
      .rest-custom-set { background:var(--surface2); border:1px solid var(--line); color:var(--text);
        font-family:'Archivo'; font-weight:700; font-size:12px; padding:8px 13px; border-radius:8px; cursor:pointer; }
      .rest-custom-set:active:not(:disabled) { background:var(--accent); color:#101200; }
      .rest-custom-set:disabled { opacity:.4; }
      .rest-presets { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin:10px 0 8px; }
      .rest-presets button { background:var(--surface2); border:1px solid var(--line); color:var(--text);
        font-family:'Space Mono',monospace; font-size:12px; padding:7px 0; border-radius:8px; cursor:pointer; }
      .rest-presets button:active { background:var(--accent); color:#101200; }
      .rest-presets button.preset-on { background:var(--accent); color:#101200; border-color:var(--accent); }
      .auto-toggle { width:100%; margin:8px 0; background:var(--surface2); border:1px solid var(--line);
        color:var(--muted); font-family:'Space Mono',monospace; font-size:11px; font-weight:700; letter-spacing:.04em;
        padding:8px; border-radius:8px; cursor:pointer; transition:all .15s; }
      .auto-toggle.auto-on { background:rgba(216,255,54,.12); border-color:var(--accent); color:var(--accent); }
      .rest-ctrl { display:flex; gap:6px; }
      .rest-ctrl button { flex:1; background:var(--surface2); border:1px solid var(--line); color:var(--text);
        padding:8px; border-radius:8px; display:flex; align-items:center; justify-content:center; cursor:pointer; }

      /* REST POPUP OVERLAY (auto-appears when a set is checked) */
      .rest-overlay { position:fixed; left:0; right:0; bottom:calc(98px + env(safe-area-inset-bottom));
        display:flex; justify-content:center; padding:0 16px; z-index:8; pointer-events:none; }
      .rest-overlay-card { pointer-events:auto; width:100%; max-width:400px; background:var(--surface);
        border:1px solid var(--accent); border-radius:18px; padding:16px 18px 17px;
        box-shadow:0 18px 50px rgba(0,0,0,.6); animation:restRise .22s ease; }
      @keyframes restRise { from { transform:translateY(16px); opacity:0; } to { transform:none; opacity:1; } }
      .rest-ov-label { display:flex; align-items:center; gap:6px; font-size:11px; letter-spacing:.12em;
        text-transform:uppercase; color:var(--muted); }
      .rest-ov-label svg { color:var(--accent); }
      .rest-ov-time { font-family:'Space Mono',monospace; font-size:48px; font-weight:700; color:var(--accent);
        text-align:center; line-height:1.05; margin:4px 0 8px; }
      .rest-ov-track { height:6px; background:var(--surface2); border-radius:99px; overflow:hidden; margin-bottom:13px; }
      .rest-ov-track > div { height:100%; background:var(--accent); border-radius:99px; transition:width .25s linear; }
      .rest-ov-btns { display:flex; gap:9px; }
      .rest-ov-btn { flex:1; padding:13px 6px; border-radius:12px; font-family:'Archivo'; font-weight:700; font-size:14px;
        cursor:pointer; border:1px solid var(--line); background:var(--surface2); color:var(--text); }
      .rest-ov-btn:active { transform:scale(.97); }
      .rest-ov-btn.primary { background:var(--accent); color:#101200; border-color:var(--accent); }
      .rest-ov-done { display:flex; align-items:center; justify-content:center; gap:8px; font-family:'Oswald';
        font-weight:700; font-size:23px; color:var(--accent); margin:2px 0 14px; }

      /* MODAL */
      .modal-bg { position:fixed; inset:0; background:rgba(0,0,0,.6); backdrop-filter:blur(3px); z-index:50;
        display:flex; align-items:center; justify-content:center; padding:24px; }
      .modal { background:var(--surface); border:1px solid var(--line); border-radius:18px; padding:22px; max-width:340px; width:100%; }
      .modal h3 { font-size:20px; font-weight:600; }
      .modal p { margin:8px 0 18px; color:var(--muted); font-size:14px; line-height:1.5; }
      .modal-btns { display:flex; gap:10px; }
      .btn-ghost { flex:1; background:var(--surface2); border:1px solid var(--line); color:var(--text);
        font-family:'Archivo'; font-weight:600; padding:12px; border-radius:11px; cursor:pointer; }
      .btn-danger { flex:1; background:rgba(255,90,77,.12); border:1px solid var(--danger); color:var(--danger);
        font-family:'Archivo'; font-weight:600; padding:12px; border-radius:11px; cursor:pointer;
        display:flex; align-items:center; justify-content:center; gap:6px; }
      .btn-danger.sm { flex:none; margin-top:12px; padding:9px 14px; font-size:13px; }
      .hist-actions { display:flex; gap:10px; margin-top:12px; }
      .hist-edit { display:flex; align-items:center; gap:6px; background:var(--surface2); color:var(--text);
        border:1px solid var(--line); border-radius:11px; font-family:'Archivo'; font-weight:700; font-size:13px;
        padding:9px 16px; cursor:pointer; }
      .hist-edit:active { transform:scale(.98); border-color:var(--accent); color:var(--accent); }
      .hist-share { display:flex; align-items:center; gap:6px; background:var(--accent); color:#101200; border:none;
        border-radius:11px; font-family:'Archivo'; font-weight:700; font-size:13px; padding:9px 16px; cursor:pointer; }
      .hist-share:active { transform:scale(.98); }
      .hist-share svg { color:#101200; }

      /* HISTORY */
      .hist-card { background:var(--surface); border:1px solid var(--line); border-radius:14px; margin-bottom:11px; overflow:hidden; }
      .hist-head { width:100%; display:flex; align-items:center; justify-content:space-between; gap:10px;
        background:none; border:none; color:var(--text); padding:15px; cursor:pointer; }
      .hist-info { display:flex; align-items:center; gap:11px; text-align:left; }
      .hist-info h3 { font-size:16px; font-weight:600; }
      .hist-info p { margin:2px 0 0; font-size:12px; color:var(--muted); font-family:'Space Mono',monospace; }
      .hist-body { padding:4px 15px 16px; border-top:1px solid var(--line); }
      .hist-ex { padding:11px 0; border-bottom:1px solid var(--line); }
      .hist-ex:last-of-type { border-bottom:none; }
      .hist-ex-name { font-size:14px; font-weight:600; margin-bottom:7px; }
      .hist-ex-name em { color:var(--muted); font-style:normal; font-weight:400; }
      .hist-sets { display:flex; flex-wrap:wrap; gap:6px; }

      /* PROGRESS */
      .ex-select { width:100%; background:var(--surface); border:1px solid var(--line); color:var(--text);
        font-family:'Archivo'; font-weight:600; font-size:15px; padding:13px 14px; border-radius:12px; cursor:pointer; margin-bottom:14px; }
      .stat-row { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; }
      .stat { background:var(--surface); border:1px solid var(--line); border-radius:13px; padding:14px; text-align:center; }
      .stat-n { display:block; font-family:'Space Mono',monospace; font-size:26px; font-weight:700; color:var(--accent); }
      .stat-l { display:block; font-size:11px; color:var(--muted); margin-top:3px; letter-spacing:.04em; }
      .chart-box { background:var(--surface); border:1px solid var(--line); border-radius:15px; padding:14px 8px 8px; }
      .chart-hint { color:var(--muted); font-size:13px; text-align:center; padding:50px 16px; }

      /* CALENDAR */
      .cal-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; }
      .cal-card { background:var(--surface); border:1px solid var(--line); border-radius:16px; padding:14px; }
      .cal-nav { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
      .cal-nav h3 { font-size:18px; font-weight:600; }
      .icon-btn.sm { width:36px; height:36px; }
      .cal-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:5px; }
      .cal-dow { margin-bottom:6px; }
      .cal-dow span { text-align:center; font-size:11px; font-weight:700; color:var(--muted); font-family:'Space Mono',monospace; }
      .cal-cell { aspect-ratio:1; border:1px solid transparent; background:var(--surface2); border-radius:10px;
        display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; cursor:default;
        position:relative; padding:0; }
      .cal-cell.empty-cell { background:none; }
      .cal-num { font-family:'Space Mono',monospace; font-size:13px; color:var(--muted); }
      .cal-cell.has { cursor:pointer; background:#0f1216; border-color:var(--line); }
      .cal-cell.has .cal-num { color:var(--text); font-weight:700; }
      .cal-cell.today { box-shadow:inset 0 0 0 1.5px var(--accent); }
      .cal-cell.today .cal-num { color:var(--accent); }
      .cal-cell.sel { border-color:var(--accent); background:rgba(216,255,54,.1); }
      .cal-cell:active.has { transform:scale(.93); }
      .cal-dots { display:flex; gap:3px; height:6px; align-items:center; }
      .cal-dots i { width:6px; height:6px; border-radius:99px; display:block; }
      .cal-legend { display:flex; flex-wrap:wrap; gap:14px; justify-content:center; margin:16px 0 4px; }
      .leg-item { display:flex; align-items:center; gap:6px; font-size:11px; font-weight:700;
        font-family:'Space Mono',monospace; color:var(--muted); }
      .leg-item i { width:9px; height:9px; border-radius:99px; }
      .cal-detail { margin-top:18px; }
      .cal-detail-row { display:flex; align-items:center; gap:11px; background:var(--surface); border:1px solid var(--line);
        border-radius:13px; padding:13px; margin-bottom:10px; }
      .cal-detail-row strong { font-family:'Oswald'; font-weight:600; font-size:16px; }
      .cal-detail-row p { margin:2px 0 0; font-size:12px; color:var(--muted); font-family:'Space Mono',monospace; }

      /* EMPTY */
      .empty { display:flex; flex-direction:column; align-items:center; text-align:center; padding:70px 30px; color:var(--muted); }
      .empty svg { color:var(--line); margin-bottom:16px; }
      .empty h3 { font-size:20px; color:var(--text); font-weight:600; }
      .empty p { margin:8px 0 0; font-size:14px; line-height:1.6; max-width:280px; }

      /* TABBAR: tighten for 6 tabs */
      .tab { font-size:10px; padding:7px 2px; }
      .tab svg { width:19px; height:19px; }

      /* MEALS */
      .meal-datebar { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:8px 2px 14px; }
      .meal-date { text-align:center; display:flex; flex-direction:column; gap:2px; }
      .meal-date strong { font-family:'Oswald'; font-weight:600; font-size:18px; }
      .meal-today { background:none; border:none; color:var(--accent); font-family:'Space Mono',monospace; font-size:11px; cursor:pointer; }
      .meal-cta { width:100%; display:flex; align-items:center; gap:8px; justify-content:center; background:rgba(216,255,54,.08);
        border:1px solid var(--accent); color:var(--accent); font-family:'Archivo'; font-weight:600; font-size:12.5px;
        padding:11px; border-radius:11px; cursor:pointer; margin-bottom:14px; }
      .meal-cta svg { flex-shrink:0; }
      .macro-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin-bottom:6px; }
      .macro-stat { background:var(--surface); border:1px solid var(--line); border-radius:13px; padding:12px 13px; }
      .macro-top { display:flex; align-items:baseline; justify-content:space-between; }
      .macro-label { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
      .macro-val { font-family:'Space Mono',monospace; font-size:17px; font-weight:700; }
      .macro-val i { color:var(--muted); font-style:normal; font-size:12px; font-weight:400; }
      .macro-bar { height:6px; background:var(--surface2); border-radius:99px; overflow:hidden; margin:9px 0 5px; }
      .macro-fill { height:100%; border-radius:99px; transition:width .35s ease; }
      .macro-unit { font-size:10px; color:var(--muted); font-family:'Space Mono',monospace; }
      .meal-copy { width:100%; display:flex; align-items:center; justify-content:center; gap:7px; background:var(--surface2);
        border:1px solid var(--line); color:var(--muted); font-family:'Archivo'; font-weight:600; font-size:12.5px;
        padding:10px; border-radius:11px; cursor:pointer; margin:2px 0 14px; }
      .meal-copy:active { border-color:var(--accent); color:var(--accent); }
      .meal-copy svg { color:var(--accent); }

      /* CALORIES BURNED CARD */
      .burn-card { background:var(--surface); border:1px solid var(--line); border-radius:13px; padding:12px 13px; margin:0 0 14px; }
      .burn-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .burn-title { display:flex; align-items:center; gap:7px; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
      .burn-title svg { color:#ff7a3d; }
      .burn-edit { display:flex; align-items:center; gap:5px; background:var(--surface2); border:1px solid var(--line);
        color:var(--text); font-family:'Space Mono',monospace; font-size:13px; padding:5px 11px; border-radius:9px; cursor:pointer; }
      .burn-edit strong { color:#ff7a3d; }
      .burn-edit svg { color:var(--muted); }
      .burn-edit-row { display:flex; align-items:center; gap:7px; margin-top:10px; }
      .burn-input { margin:0; width:90px; text-align:center; }
      .burn-unit { font-size:12px; color:var(--muted); font-family:'Space Mono',monospace; }
      .burn-save { margin-left:auto; background:var(--accent); color:#0b0b0c; border:none; font-family:'Archivo'; font-weight:700;
        font-size:13px; padding:8px 16px; border-radius:9px; cursor:pointer; }
      .burn-cancel { background:none; border:none; color:var(--muted); font-family:'Archivo'; font-size:13px; cursor:pointer; padding:8px 4px; }
      .burn-estimate { width:100%; margin-top:10px; background:rgba(255,122,61,.09); border:1px dashed rgba(255,122,61,.4);
        color:#ff9a66; font-family:'Archivo'; font-weight:600; font-size:12.5px; padding:9px; border-radius:10px; cursor:pointer; }
      .burn-estimate:active { background:rgba(255,122,61,.16); }
      .burn-net { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-top:11px;
        font-family:'Space Mono',monospace; font-size:13px; color:var(--text); }
      .burn-net strong { color:var(--accent); font-size:15px; }
      .burn-left { color:var(--muted); font-size:11px; }
      .burn-over { color:var(--danger); font-size:11px; }
      .burn-hint { margin:9px 0 0; font-size:11px; color:var(--muted); font-family:'Space Mono',monospace; }
      .burn-foot { margin:9px 0 0; font-size:10.5px; line-height:1.45; color:var(--muted); }

      /* MEAL SLOTS */
      .slot-sec { margin-bottom:14px; }
      .slot-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:0 2px 8px; }
      .slot-title { font-family:'Oswald'; font-weight:600; font-size:16px; display:flex; align-items:baseline; gap:8px; min-width:0; }
      .slot-sub { font-family:'Space Mono',monospace; font-size:10px; font-weight:700; color:var(--muted); white-space:nowrap; }
      .slot-actions { display:flex; align-items:center; gap:7px; flex-shrink:0; }
      .slot-save { width:34px; height:30px; border-radius:8px; border:1px solid var(--line); background:var(--surface2);
        color:var(--muted); display:flex; align-items:center; justify-content:center; cursor:pointer; }
      .slot-save:active { color:var(--accent); border-color:var(--accent); }
      .slot-add { display:flex; align-items:center; gap:5px; background:var(--surface2); border:1px solid var(--line);
        color:var(--accent); font-family:'Archivo'; font-weight:600; font-size:12px; padding:6px 11px; border-radius:99px; cursor:pointer; }
      .slot-add:active { background:var(--accent); color:#101200; }
      .meal-list { display:flex; flex-direction:column; gap:9px; }
      .meal-row { display:flex; align-items:center; gap:10px; background:var(--surface); border:1px solid var(--line);
        border-radius:13px; padding:12px 13px; margin-bottom:7px; }
      .meal-info-btn { flex:1; min-width:0; text-align:left; background:none; border:none; color:var(--text); cursor:pointer; padding:0; }
      .meal-info-btn strong { font-size:14px; font-weight:600; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .meal-info-btn p { margin:2px 0 0; font-size:11px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .meal-info { flex:1; min-width:0; }
      .meal-info strong { font-size:14px; font-weight:600; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .meal-info p { margin:2px 0 0; font-size:11px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .meal-macros { text-align:right; flex-shrink:0; display:flex; flex-direction:column; gap:2px; }
      .meal-macros .meal-kcal { font-family:'Space Mono',monospace; font-weight:700; font-size:13px; color:var(--accent); }
      .meal-macros span:last-child { font-size:10px; color:var(--muted); font-family:'Space Mono',monospace; }

      /* FOOD SEARCH MODAL */
      .food-modal { position:relative; background:var(--surface); border:1px solid var(--line); border-radius:18px; padding:16px;
        width:100%; max-width:420px; max-height:82vh; display:flex; flex-direction:column; }
      .food-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
      .food-head h3 { font-size:18px; font-weight:600; }
      .food-searchbar { display:flex; gap:8px; align-items:stretch; }
      .food-search { flex:1; display:flex; align-items:center; gap:8px; background:var(--surface2); border:1px solid var(--line);
        border-radius:11px; padding:0 12px; }
      .scan-btn { width:48px; flex-shrink:0; background:var(--surface2); border:1px solid var(--line); border-radius:11px;
        color:var(--accent); display:flex; align-items:center; justify-content:center; cursor:pointer; }
      .scan-btn:active { background:var(--accent); color:#101200; }
      .food-hint { margin:8px 2px 0; font-size:11px; color:var(--muted); line-height:1.5; }

      /* BARCODE SCANNER OVERLAY — full screen so the camera view is large */
      .scan-overlay { position:fixed; inset:0; z-index:60; background:var(--bg);
        padding:calc(14px + env(safe-area-inset-top)) 14px calc(14px + env(safe-area-inset-bottom));
        display:flex; flex-direction:column; gap:12px; }
      .scan-head { display:flex; align-items:center; justify-content:space-between; }
      .scan-head span { display:flex; align-items:center; gap:7px; font-family:'Oswald'; font-weight:600; font-size:17px; }
      .scan-head svg { color:var(--accent); }
      .scan-video-wrap { position:relative; flex:1; min-height:55vh; background:#000; border-radius:14px; overflow:hidden;
        display:flex; align-items:center; justify-content:center; }
      .scan-video { width:100%; height:100%; object-fit:cover; }
      .scan-reticle { position:absolute; left:8%; right:8%; top:34%; height:30%; border:2px solid var(--accent);
        border-radius:12px; box-shadow:0 0 0 100vmax rgba(0,0,0,.35); transition:border-color .2s; }
      .scan-reticle-busy { border-color:#fff; animation:pulse 1s ease-in-out infinite; }
      .scan-reticle-ok { border-color:#9cff6f; box-shadow:0 0 0 100vmax rgba(0,40,0,.45); }
      .scan-tip { position:absolute; bottom:10px; left:0; right:0; text-align:center; font-size:12px; color:#fff;
        text-shadow:0 1px 4px #000; }
      .scan-found { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;
        gap:6px; background:rgba(8,18,6,.78); color:#fff; padding:20px; text-align:center; }
      .scan-found svg { color:#9cff6f; }
      .scan-found strong { font-family:'Oswald'; font-weight:600; font-size:18px; }
      .scan-found span { font-family:'Space Mono',monospace; font-size:12px; color:var(--accent); }
      .scan-torch { position:absolute; top:10px; right:10px; width:40px; height:40px; border-radius:99px;
        background:rgba(0,0,0,.5); border:1px solid rgba(255,255,255,.3); color:#fff; display:flex; align-items:center;
        justify-content:center; cursor:pointer; }
      .scan-torch.on { background:var(--accent); color:#101200; border-color:var(--accent); }
      .scan-notice { background:var(--surface2); border:1px solid var(--line); color:var(--text); border-radius:10px;
        padding:10px 12px; font-size:12.5px; line-height:1.5; }
      .scan-err { background:rgba(255,90,77,.1); border:1px solid var(--danger); color:var(--danger); border-radius:10px;
        padding:12px 13px; font-size:13px; line-height:1.5; }
      .scan-manual { display:flex; gap:8px; align-items:stretch; }
      .scan-manual .login-input { flex:1; }
      .scan-manual .login-go { flex-shrink:0; padding:0 18px; }
      .food-search svg { color:var(--muted); flex-shrink:0; }
      .food-input { flex:1; background:none; border:none; outline:none; color:var(--text); font-family:'Archivo';
        font-size:15px; padding:13px 0; }
      .food-results { margin-top:10px; overflow-y:auto; display:flex; flex-direction:column; gap:7px; }
      .food-result { display:flex; align-items:center; justify-content:space-between; gap:10px; text-align:left;
        background:var(--surface2); border:1px solid var(--line); border-radius:11px; padding:11px 12px; cursor:pointer; color:var(--text); }
      .food-result:active { border-color:var(--accent); }
      .food-result-name { min-width:0; }
      .food-result-name strong { font-size:13.5px; font-weight:600; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .food-result-name em { font-style:normal; font-size:11px; color:var(--muted); }
      .food-result-kcal { flex-shrink:0; font-family:'Space Mono',monospace; font-size:12px; font-weight:700; color:var(--accent); }
      .food-result-kcal i { color:var(--muted); font-style:normal; font-weight:400; }
      .food-manual { margin-top:12px; width:100%; background:none; border:1px dashed var(--line); color:var(--muted);
        font-family:'Archivo'; font-weight:600; font-size:13px; padding:11px; border-radius:11px; cursor:pointer; }
      .food-amount { margin-top:12px; display:flex; flex-direction:column; gap:9px; overflow-y:auto; }
      .food-sel-name { font-size:15px; } .food-sel-name em { font-style:normal; color:var(--muted); font-size:13px; }
      .food-preview { display:flex; flex-wrap:wrap; gap:12px; padding:11px 13px; background:var(--surface2); border-radius:10px;
        font-family:'Space Mono',monospace; font-size:13px; font-weight:700; }
      .food-preview span:not(:first-child) { color:var(--muted); }
      .custom-macros { display:grid; grid-template-columns:repeat(2,1fr); gap:9px; }

      /* QUICK ADD (recent + favorites) */
      .quick-label { font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); margin:12px 2px 7px; }
      .quick-row { display:flex; align-items:stretch; gap:7px; margin-bottom:7px; }
      .quick-add { flex:1; min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; text-align:left;
        background:var(--surface2); border:1px solid var(--line); border-radius:11px; padding:11px 12px; cursor:pointer; color:var(--text); }
      .quick-add:active { border-color:var(--accent); }
      .quick-meta { flex-shrink:0; font-family:'Space Mono',monospace; font-size:11px; font-weight:700; color:var(--accent); }
      .quick-star { width:44px; flex-shrink:0; background:var(--surface2); border:1px solid var(--line); border-radius:11px;
        color:#565b63; display:flex; align-items:center; justify-content:center; cursor:pointer; }
      .quick-star.on { color:var(--accent); border-color:var(--accent); }

      /* PROFILE */
      .seg { display:flex; gap:6px; background:var(--surface2); border:1px solid var(--line); border-radius:11px; padding:4px; margin-bottom:11px; }
      .seg button { flex:1; background:none; border:none; color:var(--muted); font-family:'Oswald'; font-weight:600; font-size:14px;
        padding:9px; border-radius:8px; cursor:pointer; }
      .seg button.seg-on { background:var(--accent); color:#101200; }
      .prof-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:9px; }
      .prof-grid .field-label { display:block; margin-bottom:4px; }
      .goal-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:8px; }
      .goal-pill { background:var(--surface2); border:1px solid var(--line); color:var(--text); font-family:'Oswald';
        font-weight:600; font-size:15px; padding:13px; border-radius:11px; cursor:pointer; transition:all .15s; }
      .goal-pill.goal-on { background:var(--accent); color:#101200; border-color:var(--accent); }
      .prof-targets-head { display:flex; align-items:center; justify-content:space-between; }

      /* ONBOARDING */
      .onb-targets { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; background:rgba(216,255,54,.08);
        border:1px solid var(--accent); border-radius:12px; padding:12px 14px; margin-top:4px; }
      .onb-targets span { font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
      .onb-targets strong { font-family:'Space Mono',monospace; font-size:20px; font-weight:700; color:var(--accent); }
      .onb-targets em { font-family:'Space Mono',monospace; font-style:normal; font-size:12px; color:var(--text); margin-left:auto; }
      .onb-cards { width:100%; display:flex; flex-direction:column; gap:13px; }
      .onb-card { position:relative; text-align:left; background:linear-gradient(150deg, var(--surface2), var(--surface));
        border:1px solid var(--line); border-radius:16px; padding:20px; cursor:pointer; color:var(--text);
        transition:border-color .15s, transform .12s; }
      .onb-card:active { transform:scale(.99); }
      .onb-card:hover { border-color:#3a4150; }
      .onb-card:disabled { opacity:.6; cursor:default; }
      .onb-card svg { color:var(--accent); }
      .onb-card h3 { font-size:19px; font-weight:600; margin:11px 0 0; }
      .onb-card p { margin:6px 0 0; font-size:13px; line-height:1.55; color:var(--muted); }
      .onb-go { display:inline-block; margin-top:14px; font-family:'Oswald'; font-weight:600; font-size:14px;
        letter-spacing:.03em; color:var(--accent); }
      .onb-tag { position:absolute; top:14px; right:14px; font-family:'Space Mono',monospace; font-size:10px; font-weight:700;
        letter-spacing:.04em; background:var(--accent); color:#101200; padding:3px 8px; border-radius:6px; }

      /* PROGRAM EDITOR */
      .train-head { display:flex; align-items:center; justify-content:space-between; margin:14px 4px 14px; }
      .edit-prog-btn { display:flex; align-items:center; gap:5px; background:var(--surface2); border:1px solid var(--line);
        color:var(--muted); font-family:'Archivo'; font-weight:600; font-size:12px; padding:6px 11px; border-radius:99px; cursor:pointer; }
      .edit-prog-btn:active { border-color:var(--accent); color:var(--accent); }
      .prog-day { background:var(--surface); border:1px solid var(--line); border-radius:15px; padding:14px; margin-bottom:13px; }
      .prog-day-head { display:flex; align-items:center; gap:9px; }
      .color-dot { width:14px; height:14px; border-radius:99px; flex-shrink:0; }
      .prog-input { flex:1; min-width:0; background:var(--surface2); border:1px solid var(--line); border-radius:9px;
        color:var(--text); font-family:'Archivo'; font-weight:600; font-size:14px; padding:10px 11px; outline:none; transition:border-color .15s; }
      .prog-input:focus { border-color:var(--accent); }
      .prog-input::placeholder { color:#565b63; font-weight:400; }
      .prog-day-name { font-family:'Oswald'; font-weight:600; font-size:16px; }
      .prog-move { display:flex; align-items:center; gap:4px; flex-shrink:0; }
      .prog-move button { width:32px; height:32px; border-radius:8px; border:1px solid var(--line); background:var(--surface2);
        color:var(--muted); display:flex; align-items:center; justify-content:center; cursor:pointer; }
      .prog-move button:disabled { opacity:.3; cursor:not-allowed; }
      .prog-move .prog-del:active { color:var(--danger); border-color:var(--danger); }
      .prog-day-meta { display:flex; gap:8px; margin-top:9px; }
      .prog-tag { flex:none; width:74px; text-align:center; font-family:'Space Mono',monospace; font-weight:700; letter-spacing:.04em; }
      .prog-colors { display:flex; flex-wrap:wrap; gap:7px; margin:11px 0 4px; }
      .swatch { width:22px; height:22px; border-radius:7px; border:2px solid transparent; cursor:pointer; padding:0; }
      .swatch-on { border-color:var(--text); }
      .prog-ex { border-top:1px solid var(--line); padding:11px 0 4px; margin-top:8px; }
      .prog-ex-top { display:flex; align-items:center; gap:8px; }
      .prog-ex-bot { display:flex; align-items:center; gap:8px; margin-top:8px; }
      .prog-var { font-size:12.5px; }
      .sets-step { display:flex; align-items:center; gap:8px; flex-shrink:0; background:var(--surface2);
        border:1px solid var(--line); border-radius:9px; padding:4px 6px; }
      .sets-step button { width:28px; height:28px; border-radius:7px; border:none; background:var(--bg); color:var(--text);
        font-size:18px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; }
      .sets-step span { font-family:'Space Mono',monospace; font-size:13px; font-weight:700; min-width:54px; text-align:center; }
      .sets-step i { color:var(--muted); font-style:normal; font-weight:400; font-size:11px; }
      .add-day-btn { width:100%; display:flex; align-items:center; justify-content:center; gap:8px; background:var(--accent);
        color:#101200; border:none; border-radius:13px; font-family:'Oswald'; font-weight:700; font-size:15px; letter-spacing:.03em;
        padding:14px; cursor:pointer; box-shadow:0 8px 24px rgba(216,255,54,.16); }
      .add-day-btn:active { transform:scale(.99); }

      .fade-in { animation:fade .4s ease; }
      @keyframes fade { from{opacity:0; transform:translateY(6px)} to{opacity:1; transform:none} }
      @keyframes rise { from{opacity:0; transform:translateY(14px)} to{opacity:1; transform:none} }

      /* SMALL PHONES (≤360px): keep 6 tabs + the set grid comfortable */
      @media (max-width: 360px) {
        .tab { font-size:9px; }
        .tab svg { width:17px; height:17px; }
        .content { padding:8px 12px 110px; }
        .topbar { padding-left:14px; padding-right:14px; }
        .brand h1 { font-size:24px; }
        .profile-name { max-width:72px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .session-body { padding-left:12px; padding-right:12px; }
      }
      /* Respect reduced-motion (mostly a mobile OS setting) */
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation-duration:.01ms !important; transition-duration:.01ms !important; }
      }
    `}</style>
  );
}
