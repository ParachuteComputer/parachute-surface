import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

/**
 * Single mount at /app/admin/. The daemon's HTTP server reserves this path
 * and serves the bundle from `<package-root>/dist/admin/`. React-router's
 * basename has to match for `<Link>` to resolve correctly.
 */
function detectBasename(): string {
  const path = window.location.pathname;
  if (path === "/app/admin" || path.startsWith("/app/admin/")) return "/app/admin";
  return "";
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename={detectBasename()}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
