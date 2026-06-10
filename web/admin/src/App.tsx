/**
 * parachute-surface admin SPA.
 *
 * Three routes:
 *   - `/`         — Surfaces (list installed surfaces)
 *   - `/add`      — Add-surface flow (inspect → confirm, R3b)
 *   - `/info/:n`  — Per-surface detail (status / audience / OAuth / credential)
 *
 * Auth (boundary C4): every API call carries a Bearer resolved by
 * `lib/api.ts` — a `surface:admin` JWT silently minted from the hub session
 * cookie (`lib/auth.ts`, in-memory cache, zero paste), falling back to the
 * operator-pasted token in `localStorage["parachute_operator_token"]` for
 * direct / no-hub deployments (the `TokenSetup` fallback affordance).
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
          <Link to="/" className="brand" aria-label="Parachute · surface">
            <span className="brand-mark">
              <BrandMark size={24} />
            </span>
            <span className="brand-name">Parachute</span>
            <span className="brand-chip">surface</span>
          </Link>
        </h1>
        <nav className="app-nav">
          <Link to="/">Surfaces</Link>
          <Link to="/add">Add surface</Link>
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
          <code>parachute-surface</code> · UI host module ·{" "}
          <a href="https://github.com/ParachuteComputer/parachute-surface">source</a>
        </small>
      </footer>
    </div>
  );
}
