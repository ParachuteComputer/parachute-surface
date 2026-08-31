/**
 * Signing-key loading. The secret key comes from a FILE, never from argv or
 * an env VALUE (`PARACHUTE_NSEC_FILE` names a path, not a key), and error
 * messages never echo file contents — a user pointing this at the wrong file
 * must not get that file's bytes reflected into a log.
 *
 * Adapted from nip98-proxy's key.ts with the box-specific agent-pool default
 * path dropped: which file to read comes from config resolution only.
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
      throw new Error("key file bech32 does not decode");
    }
    if (decoded.type !== "nsec") throw new Error("key file bech32 is not an nsec");
    return decoded.data;
  }
  if (/^[0-9a-f]{64}$/i.test(v)) return Uint8Array.from(Buffer.from(v, "hex"));
  throw new Error("key file is neither nsec1... nor 64-char hex");
}

/** Load the signing key from `path`, holding it in memory only. */
export function loadKey(path: string): LoadedKey {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read key file ${path}: ${(e as NodeJS.ErrnoException).code}`);
  }
  const sk = parseSecretKey(raw);
  const pubkey = getPublicKey(sk);
  return { sk, pubkey, npub: npubEncode(pubkey) };
}
