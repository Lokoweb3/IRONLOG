import React from "react";
import { createRoot } from "react-dom/client";
import App from "./workout-tracker.jsx";

// Expose the running bundle's hash so the app can detect when a newer build has
// been deployed (see the update banner in App).
try {
  window.__BUILD__ = (import.meta.url.match(/index-([A-Za-z0-9_-]+)\.js/) || [])[1] || "dev";
} catch { window.__BUILD__ = "dev"; }

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register the service worker in production builds for PWA install + offline.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
