/**
 * Signing-key loading. The secret key normally comes from a FILE (never argv,
 * never an env VALUE — `PARACHUTE_NSEC_FILE` names a path, not a key), and
 * error messages never echo the key material — a user pointing this at the
 * wrong file must not get that file's bytes reflected into a log.
 *
 * ONE deliberate exception, `loadKeyValue`: a bech32 nsec read from the
 * `BUZZ_PRIVATE_KEY` env VALUE (see config.ts `resolveKeySource` for the full
 * security justification). It shares `parseSecretKey`, so it inherits the same
 * content-free error discipline — a malformed value never reaches a log.
 *
 * Adapted from nip98-proxy's key.ts with the box-specific agent-pool default
 * path dropped: which key to use comes from config resolution only.
 */
import { readFileSync } from "node:fs";
import { npubEncode } from "nostr-tools/nip19";
import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";

export interface LoadedKey {
  /** The secret key bytes — held in memory only. Never log, never stringify. */
  sk: Uint8Array;
  /** Hex public key. */
  pubkey: string;
  /** npub1... form of the public key — the ONLY key form that may be logged. */
  npub: string;
}

/** Parse an nsec1... or bare-hex secret key. Never echoes the input on failure. */
export function parseSecretKey(raw: string): Uint8Array {
  const v = raw.trim();
  if (v.startsWith("nsec1")) {
    let decoded: ReturnType<typeof decode>;
    try {
      decoded = decode(v);
    } catch {
      // nostr-tools' bech32 errors can quote the input; replace them wholesale.
      // Wording is source-neutral ("secret key", not "key file") because the
      // same parse serves both the key FILE and the BUZZ_PRIVATE_KEY value.
      throw new Error("secret key bech32 does not decode");
    }
    if (decoded.type !== "nsec") throw new Error("secret key bech32 is not an nsec");
    return decoded.data;
  }
  if (/^[0-9a-f]{64}$/i.test(v)) return Uint8Array.from(Buffer.from(v, "hex"));
  throw new Error("secret key is neither nsec1... nor 64-char hex");
}

/** Load the signing key from `path`, holding it in memory only. */
export function loadKey(path: string): LoadedKey {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read key file ${path}: ${(e as NodeJS.ErrnoException).code}`);
  }
  return fromSecret(raw);
}

/**
 * Load the signing key from an in-memory bech32 nsec VALUE (the
 * `BUZZ_PRIVATE_KEY` zero-config source), holding it in memory only. Never
 * touches the filesystem and never echoes the value: `parseSecretKey` scrubs
 * bech32 errors and we add no context that could leak the secret. Only the
 * derived npub is ever surfaced. See config.ts `resolveKeySource` for why
 * reading this env VALUE is a deliberate, per-agent-scoped exception.
 */
export function loadKeyValue(raw: string): LoadedKey {
  return fromSecret(raw);
}

function fromSecret(raw: string): LoadedKey {
  const sk = parseSecretKey(raw);
  const pubkey = getPublicKey(sk);
  return { sk, pubkey, npub: npubEncode(pubkey) };
}
