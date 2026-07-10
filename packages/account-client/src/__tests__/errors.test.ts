/**
 * Tests for `errors.ts` — the body parser + the status→type classifier.
 *
 * Coverage:
 *   - parseErrorBody across the two doors' shapes (OAuth + REST) and non-JSON
 *   - classifyErrorResponse maps each status/code to the right typed error
 *   - the instanceof hierarchy (403 permission under auth; vault-limit NOT)
 */

import { describe, expect, test } from "bun:test";

import {
  AccountAuthError,
  AccountBadRequestError,
  AccountConflictError,
  AccountError,
  AccountHttpError,
  AccountNotFoundError,
  AccountPermissionError,
  AccountServerError,
  AccountUnreachableError,
  VaultLimitError,
  classifyErrorResponse,
  parseErrorBody,
} from "../errors.ts";

describe("parseErrorBody", () => {
  test("reads OAuth-style { error, error_description }", () => {
    const p = parseErrorBody(JSON.stringify({ error: "invalid_grant", error_description: "nope" }));
    expect(p.code).toBe("invalid_grant");
    expect(p.message).toBe("nope");
  });

  test("reads REST-style { error, message } and prefers message over error_description", () => {
    const p = parseErrorBody(JSON.stringify({ error: "vault_taken", message: "taken" }));
    expect(p.code).toBe("vault_taken");
    expect(p.message).toBe("taken");
  });

  test("non-JSON body → empty parse", () => {
    expect(parseErrorBody("<html>500</html>")).toEqual({});
  });

  test("empty body → empty parse", () => {
    expect(parseErrorBody("")).toEqual({});
  });
});

describe("classifyErrorResponse", () => {
  test("5xx → AccountServerError (a subclass of AccountUnreachableError)", () => {
    const e = classifyErrorResponse(503, "", "GET /account");
    expect(e).toBeInstanceOf(AccountServerError);
    expect(e).toBeInstanceOf(AccountUnreachableError);
    expect(e.status).toBe(503);
  });

  test("401 → AccountAuthError", () => {
    const e = classifyErrorResponse(
      401,
      JSON.stringify({ error: "invalid_token" }),
      "GET /account",
    );
    expect(e).toBeInstanceOf(AccountAuthError);
    expect(e.status).toBe(401);
    expect(e.code).toBe("invalid_token");
  });

  test("403 → AccountPermissionError (extends AccountAuthError)", () => {
    const e = classifyErrorResponse(
      403,
      JSON.stringify({ error: "unowned_vault" }),
      "DELETE /account/vaults/x",
    );
    expect(e).toBeInstanceOf(AccountPermissionError);
    expect(e).toBeInstanceOf(AccountAuthError);
    expect(e.status).toBe(403);
  });

  test("403 vault_limit_reached → VaultLimitError, NOT under AccountAuthError", () => {
    const e = classifyErrorResponse(
      403,
      JSON.stringify({ error: "vault_limit_reached" }),
      "POST /account/vaults",
    );
    expect(e).toBeInstanceOf(VaultLimitError);
    expect(e).not.toBeInstanceOf(AccountAuthError);
    expect(e.status).toBe(403);
    expect(e.code).toBe("vault_limit_reached");
  });

  test("404 → AccountNotFoundError, carries the code", () => {
    const e = classifyErrorResponse(
      404,
      JSON.stringify({ error: "not_supported" }),
      "GET /account/plan",
    );
    expect(e).toBeInstanceOf(AccountNotFoundError);
    expect(e.code).toBe("not_supported");
  });

  test("409 → AccountConflictError", () => {
    const e = classifyErrorResponse(
      409,
      JSON.stringify({ error: "vault_taken" }),
      "POST /account/vaults",
    );
    expect(e).toBeInstanceOf(AccountConflictError);
    expect(e.code).toBe("vault_taken");
  });

  test("400 → AccountBadRequestError", () => {
    const e = classifyErrorResponse(
      400,
      JSON.stringify({ error: "invalid_name" }),
      "POST /account/vaults",
    );
    expect(e).toBeInstanceOf(AccountBadRequestError);
    expect(e.code).toBe("invalid_name");
  });

  test("unmapped status (429) → AccountHttpError carrying the status", () => {
    const e = classifyErrorResponse(
      429,
      JSON.stringify({ error: "rate_limited" }),
      "POST /account/token",
    );
    expect(e).toBeInstanceOf(AccountHttpError);
    expect(e).toBeInstanceOf(AccountError);
    expect(e.status).toBe(429);
  });

  test("message composes context + status + detail; raw body retained", () => {
    const e = classifyErrorResponse(
      409,
      JSON.stringify({ error: "vault_taken", message: "taken" }),
      "POST /account/vaults",
    );
    expect(e.message).toBe("POST /account/vaults → 409: taken");
    expect(e.body).toBe(JSON.stringify({ error: "vault_taken", message: "taken" }));
  });
});
