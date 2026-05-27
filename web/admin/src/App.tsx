/**
 * parachute-app admin SPA.
 *
 * Three routes:
 *   - `/`         — Modules (list installed UIs)
 *   - `/add`      — Add UI form
 *   - `/info/:n`  — Per-UI detail
 *
 * Auth: every API call carries a Bearer header sourced from
 * `localStorage["parachute_operator_token"]`. The operator pastes this once
 * via the setup banner; Phase 1.3 wires hub-session-based auth instead.
 *
 * Cross-surface navigation off the SPA (back to hub admin, to a hosted UI)
 * uses plain `<a href>` since react-router's `<Link>` resolves against the
 * SPA basename `/surface/admin`.
 */
import { Link, Route, Routes } from "react-router-dom";
import { TokenSetup } from "./TokenSetup.tsx";
import { BrandMark } from "./components/BrandMark.tsx";
import { Add } from "./routes/Add.tsx";
import { Modules } from "./routes/Modules.tsx";
import { UiInfo } from "./routes/UiInfo.tsx";

export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>
          <Link to="/" className="brand" aria-label="Parachute · app">
            <span className="brand-mark">
              <BrandMark size={24} />
            </span>
            <span className="brand-name">Parachute</span>
            <span className="brand-chip">app</span>
          </Link>
        </h1>
        <nav className="app-nav">
          <Link to="/">Modules</Link>
          <Link to="/add">Add UI</Link>
          <a href="/">Back to hub</a>
        </nav>
      </header>

      <TokenSetup />

      <main className="app-main">
        <Routes>
          <Route path="/" element={<Modules />} />
          <Route path="/add" element={<Add />} />
          <Route path="/info/:name" element={<UiInfo />} />
        </Routes>
      </main>

      <footer className="app-footer">
        <small>
          <code>parachute-app</code> · UI host module ·{" "}
          <a href="https://github.com/ParachuteComputer/parachute-app">source</a>
        </small>
      </footer>
    </div>
  );
}
