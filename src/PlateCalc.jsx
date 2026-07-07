// ---------------------------------------------------------------------------
//  PLATE CALCULATOR — a small bottom-sheet used from the live workout session.
//  Self-contained: math from lib/stats, styles scoped here via a <style> tag
//  (theme vars — --surface, --line, --accent … — are exposed on :root).
// ---------------------------------------------------------------------------
import React, { useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { calcPlates } from "./lib/stats.js";

const BARS = [45, 35, 25];

// visual size + color per plate weight (lbs). Height in px for the side view.
const PLATE_LOOK = {
  45: { h: 84, c: "#d8ff36" },
  35: { h: 72, c: "#46d9ff" },
  25: { h: 60, c: "#ffb13e" },
  10: { h: 44, c: "#ff6fd0" },
  5: { h: 34, c: "#7c9cff" },
  2.5: { h: 26, c: "#9cff6f" },
};
const plateLook = (p) => PLATE_LOOK[p] || { h: 30, c: "var(--muted)" };
const fmtLbs = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

export default function PlateCalc({ initialTarget, onClose }) {
  const [target, setTarget] = useState(
    initialTarget != null && initialTarget !== "" ? String(initialTarget) : ""
  );
  const [bar, setBar] = useState(45);

  const t = parseFloat(target) || 0;
  const { perSide, loaded, remainder } = calcPlates(t, bar);
  const belowBar = t > 0 && t < bar;

  return createPortal(
    <div className="pc-bg" onClick={onClose}>
      <style>{PC_CSS}</style>
      <div className="pc-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="pc-head">
          <h3>Plate calculator</h3>
          <button className="pc-close" onClick={onClose} aria-label="close"><X size={18} /></button>
        </div>

        <div className="pc-controls">
          <label className="pc-field">
            <span>Target</span>
            <input
              inputMode="decimal" placeholder="lbs" autoFocus
              value={target}
              onChange={(e) => setTarget(e.target.value.replace(/[^\d.]/g, ""))}
            />
          </label>
          <div className="pc-bars">
            <span>Bar</span>
            {BARS.map((b) => (
              <button key={b} className={`pc-bar-pill ${bar === b ? "pc-on" : ""}`} onClick={() => setBar(b)}>
                {b}
              </button>
            ))}
          </div>
        </div>

        <div className="pc-visual" aria-hidden="true">
          <span className="pc-sleeve" />
          {perSide.map((p, i) => {
            const { h, c } = plateLook(p);
            return (
              <span key={i} className="pc-plate" style={{ height: h, background: c }}>
                {fmtLbs(p)}
              </span>
            );
          })}
          <span className="pc-shaft">{t > 0 ? `${bar} lb bar` : "bar"}</span>
        </div>

        {t > 0 && !belowBar && (
          <p className="pc-perside">
            {perSide.length
              ? <>Per side: <b>{perSide.map(fmtLbs).join(" + ")}</b></>
              : "Empty bar — no plates needed"}
          </p>
        )}

        <div className="pc-total">
          <span>On the bar</span>
          <b>{t > 0 ? `${fmtLbs(loaded)} lbs` : "—"}</b>
        </div>

        {belowBar && (
          <p className="pc-note">Target is below the {bar} lb bar — the empty bar is your minimum.</p>
        )}
        {t > 0 && !belowBar && remainder > 0 && (
          <p className="pc-note">
            {fmtLbs(t)} isn't exactly loadable — closest is {fmtLbs(loaded)} ({fmtLbs(remainder)} lbs short).
          </p>
        )}
      </div>
    </div>,
    document.body
  );
}

const PC_CSS = `
  .pc-bg { position:fixed; inset:0; background:rgba(0,0,0,.6); backdrop-filter:blur(3px); z-index:60;
    display:flex; align-items:flex-end; justify-content:center; }
  .pc-sheet { background:var(--surface); border:1px solid var(--line); border-bottom:none;
    border-radius:20px 20px 0 0; padding:18px 18px calc(20px + env(safe-area-inset-bottom));
    width:100%; max-width:520px; animation:pc-up .22s ease; }
  @keyframes pc-up { from { transform:translateY(40px); opacity:0; } to { transform:none; opacity:1; } }
  .pc-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
  .pc-head h3 { font-size:17px; font-weight:600; margin:0; }
  .pc-close { background:var(--surface2); border:1px solid var(--line); color:var(--text);
    border-radius:9px; padding:5px 7px; cursor:pointer; display:flex; }
  .pc-controls { display:flex; gap:14px; align-items:flex-end; flex-wrap:wrap; }
  .pc-field { display:flex; flex-direction:column; gap:5px; }
  .pc-field span, .pc-bars > span { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  .pc-field input { width:110px; background:var(--surface2); border:1px solid var(--line); color:var(--text);
    font-family:'Space Mono',monospace; font-size:20px; padding:9px 12px; border-radius:11px; outline:none; }
  .pc-field input:focus { border-color:var(--accent); }
  .pc-bars { display:flex; align-items:center; gap:7px; padding-bottom:4px; }
  .pc-bar-pill { background:var(--surface2); border:1px solid var(--line); color:var(--muted);
    font-family:'Space Mono',monospace; font-size:14px; padding:8px 13px; border-radius:999px; cursor:pointer; }
  .pc-bar-pill.pc-on { background:var(--accent); border-color:var(--accent); color:#101200; font-weight:700; }
  .pc-visual { display:flex; align-items:center; gap:3px; min-height:104px; margin:16px 0 4px;
    padding:0 10px; overflow-x:auto; }
  .pc-sleeve { width:14px; height:12px; border-radius:3px; background:var(--line); flex:none; }
  .pc-plate { flex:none; width:22px; border-radius:5px; display:flex; align-items:center; justify-content:center;
    color:#101200; font-family:'Space Mono',monospace; font-size:9px; font-weight:700;
    writing-mode:vertical-rl; text-orientation:mixed; }
  .pc-shaft { flex:1; height:8px; background:var(--line); border-radius:4px; position:relative; min-width:60px;
    display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:10px;
    font-family:'Space Mono',monospace; line-height:0; }
  .pc-perside { margin:8px 2px 0; font-size:13px; color:var(--muted); }
  .pc-perside b { color:var(--text); font-family:'Space Mono',monospace; }
  .pc-total { display:flex; align-items:center; justify-content:space-between; margin-top:12px;
    background:var(--surface2); border:1px solid var(--line); border-radius:12px; padding:12px 15px; }
  .pc-total span { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  .pc-total b { font-family:'Space Mono',monospace; font-size:20px; color:var(--accent); }
  .pc-note { margin:10px 2px 0; font-size:12.5px; line-height:1.45; color:var(--muted); }
`;
