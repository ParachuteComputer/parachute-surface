/**
 * Host-side credential renewal (surface-runtime design P3, against hub#648
 * H4's proof-of-possession endpoint).
 *
 * A sweep (on boot + interval) walks every stored credential; any within
 * the renewal horizon of its `expires_at` POSTs the hub's
 * `POST /admin/connections/<id>/renew` with the CURRENT token as Bearer
 * (possession is the auth — no operator click). The 200 body is
 * `{ ok: true, credential: <CredentialPayload op:"renewed"> }`; the stored
 * record is replaced from it.
 *
 * Terminal 401 (`invalid_credential` — expired/revoked: an expired
 * credential cannot renew itself, per the hub's design) marks the record
 * `needs-operator` and the sweep STOPS retrying it — no retry spin; the
 * operator re-approves in the hub UI (which re-delivers via the endpoint,
 * resetting status to "ok"). Transient failures (network, 5xx) are logged
 * and retried on the next sweep.
 */

import {
  type CredentialPayload,
  type StoredCredential,
  applyCredentialPayload,
  listCredentials,
  markCredentialNeedsOperator,
  resolveCredentialsDir,
} from "./credential-store.ts";

/** Renew when within this horizon of expiry (the design's "N days"). */
export const DEFAULT_RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
/** Sweep cadence. */
export const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type SweepOpts = {
  /** Hub origin renewals POST against. */
  hubOrigin: string;
  dir?: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "log" | "warn" | "error">;
  now?: () => Date;
  renewWithinMs?: number;
};

export type SweepOutcome = {
  checked: number;
  renewed: string[];
  needsOperator: string[];
  /** Transient failures — retried next sweep. */
  failed: Array<{ connectionId: string; detail: string }>;
};

function withinHorizon(rec: StoredCredential, now: Date, horizonMs: number): boolean {
  const expires = Date.parse(rec.expires_at);
  if (!Number.isFinite(expires)) return true; // unparseable expiry → try renewing
  return expires - now.getTime() <= horizonMs;
}

/** One renewal pass over the stored credentials. */
export async function sweepCredentials(opts: SweepOpts): Promise<SweepOutcome> {
  const dir = opts.dir ?? resolveCredentialsDir();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const logger = opts.logger ?? console;
  const now = opts.now ?? (() => new Date());
  const horizon = opts.renewWithinMs ?? DEFAULT_RENEW_WITHIN_MS;
  const origin = opts.hubOrigin.replace(/\/+$/, "");

  const outcome: SweepOutcome = { checked: 0, renewed: [], needsOperator: [], failed: [] };

  for (const rec of listCredentials(dir)) {
    outcome.checked++;
    // needs-operator is terminal for the sweep — no retry spin.
    if (rec.status === "needs-operator") continue;
    if (!withinHorizon(rec, now(), horizon)) continue;

    const renewPath = rec.renew_path.startsWith("/") ? rec.renew_path : `/${rec.renew_path}`;
    try {
      const res = await fetchImpl(`${origin}${renewPath}`, {
        method: "POST",
        headers: { authorization: `Bearer ${rec.token}` },
      });
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean; credential?: CredentialPayload };
        if (!body?.credential?.token) {
          outcome.failed.push({
            connectionId: rec.connection_id,
            detail: "renewal 200 but no credential in body",
          });
          logger.warn(
            `[app] credential ${rec.connection_id}: renewal response carried no credential — will retry`,
          );
          continue;
        }
        applyCredentialPayload(body.credential, dir, now);
        outcome.renewed.push(rec.connection_id);
        logger.log(
          `[app] credential ${rec.connection_id}: renewed (expires ${body.credential.expires_at})`,
        );
      } else if (res.status === 401) {
        // Terminal: expired/revoked credentials cannot renew themselves —
        // the operator re-approves in the hub UI (hub upserts + re-delivers).
        markCredentialNeedsOperator(rec.connection_id, dir, now);
        outcome.needsOperator.push(rec.connection_id);
        logger.error(
          `[app] credential ${rec.connection_id}: renewal rejected (401) — needs operator re-approval in the hub admin`,
        );
      } else {
        const detail = `hub ${res.status}`;
        outcome.failed.push({ connectionId: rec.connection_id, detail });
        logger.warn(
          `[app] credential ${rec.connection_id}: renewal failed (${detail}) — will retry`,
        );
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      outcome.failed.push({ connectionId: rec.connection_id, detail });
      logger.warn(`[app] credential ${rec.connection_id}: renewal failed (${detail}) — will retry`);
    }
  }
  return outcome;
}

/**
 * Boot-time sweep + interval loop. The timer is unref'd where supported so
 * it never pins the process; `stop()` clears it (daemon shutdown).
 */
export function startCredentialRenewal(opts: SweepOpts & { intervalMs?: number }): {
  stop: () => void;
  firstSweep: Promise<SweepOutcome>;
} {
  const logger = opts.logger ?? console;
  const run = () =>
    sweepCredentials(opts).catch((e) => {
      logger.warn(`[app] credential sweep failed: ${(e as Error).message}`);
      return { checked: 0, renewed: [], needsOperator: [], failed: [] } satisfies SweepOutcome;
    });
  const firstSweep = run();
  const timer = setInterval(run, opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  return {
    stop: () => clearInterval(timer),
    firstSweep,
  };
}
