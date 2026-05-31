// ---------------------------------------------------------------------------
//  SERVER ENTRYPOINT — starts the HTTP listener for the app in app.js.
//  - In dev: serves only the API; the Vite dev server (:5173) proxies to it.
//  - In prod: app.js also serves the built frontend from dist/ (single origin).
// ---------------------------------------------------------------------------
import { app } from "./app.js";

const PORT = process.env.PORT || 8080;
const IS_PROD = process.env.NODE_ENV === "production";

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (${IS_PROD ? "production" : "development"})`);
});
