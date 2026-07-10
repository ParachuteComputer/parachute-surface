/**
 * Structured errors for {@link AccountClient} — mirrors surface-client's
 * `VaultError` hierarchy (`vault-client.ts:76-209`) so callers get the same
 * `catch (e instanceof AccountError)` catch-all + fine-grained `instanceof`
 * branching they already know from the vault client.
 *
 * Every concrete error carries `status` (HTTP status, or `0` for a pre-flight
 * network failure) and an optional `body` (raw response text). `code` carries
 * the door's machine-readable `error` field when the body was JSON — e.g.
 * `vault_taken`, `vault_limit_reached`, `caps_not_writable`, `not_supported`
 * — so a UI can branch on the reason without string-matching the message.
 *
 * Error bodies follow the doors' conventions (§1): Cloud uses OAuth-style
 * `{ error, error_description }` for auth failures and `{ error, message }`
 * for REST; Hub uses its `adminAuthErrorResponse` shape. The classifier reads
 * `error`/`error_description`/`message` across both.
 */

export interface AccountErrorOptions {
  /** Machine-readable reason from the body's `error` field, when present. */
  code?: string;
  /** Raw response body, when one was available. */
  body?: string;
}

/**
 * Common base class for every {@link AccountClient} error. Abstract — every
 * throw is one of the concrete subclasses below, so `instanceof AccountError`
 * catches anything the client raised.
 */
export abstract class AccountError extends Error {
  /** HTTP status, or `0` for a network-level failure with no response. */
  abstract readonly status: number;
  /** Machine-readable reason from the body's `error` field, when present. */
  readonly code?: string;
  /** Raw response body, when one was available. */
  readonly body?: string;
  constructor(message: string, opts: AccountErrorOptions = {}) {
    super(message);
    this.name = "AccountError";
    if (opts.code !== undefined) this.code = opts.code;
    if (opts.body !== undefined) this.body = opts.body;
  }
}

/**
 * The door was unreachable — a network-level failure (ECONNREFUSED, DNS,
 * TypeError) with `status === 0` and no response body. For 5xx responses (the
 * door answered with an error) use {@link AccountServerError}, which extends
 * this so a `catch (e instanceof AccountUnreachableError)` covers both.
 */
export class AccountUnreachableError extends AccountError {
  readonly status: number;
  constructor(message: string, status = 0, opts: AccountErrorOptions = {}) {
    super(message, opts);
    this.name = "AccountUnreachableError";
    this.status = status;
  }
}

/** The door answered with a 5xx. Extends `AccountUnreachableError` (the door is having a bad time, either way). */
export class AccountServerError extends AccountUnreachableError {
  constructor(message: string, status: number, opts: AccountErrorOptions = {}) {
    super(message, status, opts);
    this.name = "AccountServerError";
  }
}

/**
 * A 401 — the account token is missing, expired, or invalid, and the SDK
 * could not silently re-mint one (the session cookie is gone → the user must
 * sign in again). {@link AccountClient} retries once with a fresh mint before
 * surfacing this.
 */
export class AccountAuthError extends AccountError {
  readonly status: number;
  constructor(
    message = "The door rejected the account credential",
    status = 401,
    opts: AccountErrorOptions = {},
  ) {
    super(message, opts);
    this.name = "AccountAuthError";
    this.status = status;
  }
}

/**
 * A 403 — the token authenticated but lacks authority for this action: the
 * account scope is `read` where `admin` is required, or the vault isn't owned
 * by this account (the ownership gate, §2). Extends `AccountAuthError` so
 * existing `instanceof AccountAuthError` handlers keep catching it; branch on
 * `AccountPermissionError` for the "you can't do that" UX vs the
 * "re-authenticate" UX of a bare `AccountAuthError`.
 */
export class AccountPermissionError extends AccountAuthError {
  constructor(
    message = "Insufficient permission for this account action",
    opts: AccountErrorOptions = {},
  ) {
    super(message, 403, opts);
    this.name = "AccountPermissionError";
  }
}

/**
 * A 403 on create because the account is at its plan's vault ceiling
 * (`{error:"vault_limit_reached"}`, §1). A quota signal, NOT an auth failure —
 * so it extends `AccountError` directly (a `catch (AccountAuthError)` should
 * NOT swallow "you're out of vaults"). Branch on this to show the upgrade UX.
 */
export class VaultLimitError extends AccountError {
  readonly status = 403;
  constructor(message = "Vault limit reached for this plan", opts: AccountErrorOptions = {}) {
    super(message, opts);
    this.name = "VaultLimitError";
  }
}

/**
 * A 400 — the request was malformed for the door: an invalid or reserved
 * vault name on create (`{error:"invalid_name"|"reserved"}`, §1), or a missing
 * CSRF token on the mint. `code` disambiguates.
 */
export class AccountBadRequestError extends AccountError {
  readonly status = 400;
  constructor(message = "Bad request", opts: AccountErrorOptions = {}) {
    super(message, opts);
    this.name = "AccountBadRequestError";
  }
}

/**
 * A 404 — the account, vault, or (on Hub) an honestly-unsupported capability.
 * The plan/billing endpoints answer `404 {error:"not_supported"}` on a door
 * whose `features.billing` is false (§1); {@link AccountClient.getPlan} maps
 * that specific case to `null` rather than throwing.
 */
export class AccountNotFoundError extends AccountError {
  readonly status = 404;
  constructor(message = "Not found", opts: AccountErrorOptions = {}) {
    super(message, opts);
    this.name = "AccountNotFoundError";
  }
}

/** A 409 — the vault name is already taken (`{error:"vault_taken"}`, §1). */
export class AccountConflictError extends AccountError {
  readonly status = 409;
  constructor(message = "Conflict", opts: AccountErrorOptions = {}) {
    super(message, opts);
    this.name = "AccountConflictError";
  }
}

/**
 * Any other non-2xx the classifier didn't map (e.g. a 429 rate-limit). Carries
 * the actual status so callers can still branch; keeps every throw under
 * `AccountError`.
 */
export class AccountHttpError extends AccountError {
  readonly status: number;
  constructor(message: string, status: number, opts: AccountErrorOptions = {}) {
    super(message, opts);
    this.name = "AccountHttpError";
    this.status = status;
  }
}

/** Parsed discriminators from a door error body (across both doors' shapes). */
export interface ParsedErrorBody {
  code?: string;
  message?: string;
}

/**
 * Parse a door error body into `{ code, message }`, tolerant of both the Cloud
 * OAuth shape (`{ error, error_description }`), the Cloud/Hub REST shape
 * (`{ error, message }`), and a non-JSON body (returns `{}`).
 */
export function parseErrorBody(bodyText: string): ParsedErrorBody {
  if (!bodyText) return {};
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: unknown;
      error_description?: unknown;
      message?: unknown;
    };
    const out: ParsedErrorBody = {};
    if (typeof parsed.error === "string") out.code = parsed.error;
    if (typeof parsed.message === "string") out.message = parsed.message;
    else if (typeof parsed.error_description === "string") out.message = parsed.error_description;
    return out;
  } catch {
    return {};
  }
}

/**
 * Map an HTTP status (+ optional parsed body) to the right typed error. The
 * single classify point used by {@link AccountClient} for every non-2xx that
 * isn't a network failure. `context` prefixes the message with the operation
 * (e.g. `"POST /account/vaults"`).
 */
export function classifyErrorResponse(
  status: number,
  bodyText: string,
  context: string,
): AccountError {
  const parsed = parseErrorBody(bodyText);
  const opts: AccountErrorOptions = {};
  if (parsed.code !== undefined) opts.code = parsed.code;
  if (bodyText) opts.body = bodyText;
  const detail = parsed.message ?? parsed.code;
  const message = detail ? `${context} → ${status}: ${detail}` : `${context} → ${status}`;

  if (status >= 500) return new AccountServerError(message, status, opts);
  if (status === 401) return new AccountAuthError(message, status, opts);
  if (status === 403) {
    if (parsed.code === "vault_limit_reached") return new VaultLimitError(message, opts);
    return new AccountPermissionError(message, opts);
  }
  if (status === 404) return new AccountNotFoundError(message, opts);
  if (status === 409) return new AccountConflictError(message, opts);
  if (status === 400) return new AccountBadRequestError(message, opts);
  return new AccountHttpError(message, status, opts);
}
