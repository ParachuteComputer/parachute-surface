<!--
  SECURITY.md template for backed Parachute surfaces (spec §13,
  design/2026-06-10-surface-runtime-primitives.md). Ships with
  @openparachute/surface-server.

  How to use: copy this file to your surface package root as SECURITY.md,
  replace every ⟨angle-bracket⟩ placeholder with your surface's real
  answer, and delete the comments. Every section is load-bearing — if a
  section truly doesn't apply, say so explicitly rather than deleting it
  (an absent answer reads as an unconsidered one).

  The actor table should cite your gateway conformance suite
  (@openparachute/surface-server/conformance) — the generated case names
  are the evidence that the table's refusals actually hold.
-->

# Security — ⟨surface name⟩

## The one rule

<!-- A single sentence stating the surface's core trust invariant —
     what must NEVER happen, e.g. "No actor without an explicit grant
     ever reads or alters a note, and a denied note is indistinguishable
     from a missing one." -->

⟨one-rule statement⟩

## Threat-model summary

<!-- 3–6 bullets. Who attacks, through what, and what the blast radius
     is. Name what's IN scope (the surface's own gateway, its audience
     plane, its credential) and what's OUT (the host's containment, the
     hub's session auth — substrate guarantees you inherit, not re-prove). -->

- **Assets:** ⟨what's worth taking — note content under the working tag, the vault-write credential, live collab state, …⟩
- **Actors:** ⟨who can reach the surface — anonymous internet, link-holding invitees, hub-identified users, the operator⟩
- **Entry points:** ⟨the HTTP gateway routes, the WS plane if any, capability entry links⟩
- **Out of scope (substrate):** ⟨host containment/CSP injection, hub proxy audience gate, vault auth — inherited, not re-proven here⟩

## Credential posture

<!-- What credential the backend holds, who minted it, what it can touch,
     where it lives, and how it's revoked/rotated. The kit's stance:
     the surface's vault credential is scoped to its working tag(s) +
     its ACL tag — never the whole vault. -->

| Credential | Scope | Custody | Revocation |
|---|---|---|---|
| ⟨e.g. hub-minted vault token⟩ | ⟨e.g. read/write on `doc` + `surface-acl/docs` only⟩ | ⟨e.g. injected via `SurfaceHostContext`, never serialized to disk by the backend⟩ | ⟨e.g. hub credential revocation; surface re-mounts on renewal⟩ |

## Audience plane

<!-- Which meta.json `audience` tier the surface declares and WHY; what
     the hub proxy enforces before the backend sees a request; what the
     backend's own auth adds on top (capability links, personal links,
     cookies). State the minimum hub version if the tier requires one. -->

- Declared tier: `⟨public | hub-users | operator | surface⟩` — ⟨why⟩.
- Hub-proxy gate: ⟨what's enforced before the backend runs⟩.
- Backend admission: ⟨what the backend's own auth admits — link shapes, cookie sessions, anon⟩.
- Minimum hub version: ⟨version, if the tier requires one⟩.

## Working scope

<!-- The working-tag statement: which vault tag(s) the surface operates
     on, what enforces membership (reads AND writes), and what happens
     to out-of-scope notes (they must be refused, not silently
     half-handled — the edit-loss class). -->

⟨working-scope statement — e.g. "Every note-kind read and write resolves
through the working-tag resolver; untagged and missing notes produce the
byte-identical `not_found` for every actor including the operator."⟩

## Actor table

<!-- One row per actor class × what they can/cannot do. Cite the
     conformance cases that pin each refusal — the suite's generated
     case names ARE the evidence trail. -->

| Actor | Can | Cannot | Pinned by |
|---|---|---|---|
| anonymous | ⟨…⟩ | ⟨…⟩ | `conformance: anon-sees-nothing — …` |
| ⟨link-holder at level X⟩ | ⟨…⟩ | ⟨…⟩ | `conformance: actor[N] allowed/denied — …` |
| operator | ⟨…⟩ | ⟨e.g. reading notes outside the working tag⟩ | ⟨suite/test name⟩ |

## Secrets table

<!-- Every secret the surface touches: where it's born, where it lives,
     where it travels, when it dies. Include capability tokens, session
     cookies, WS tickets — not just long-lived credentials. -->

| Secret | Born | Lives | Travels | Dies |
|---|---|---|---|---|
| ⟨e.g. capability token⟩ | ⟨mint path⟩ | ⟨storage — hashed? plaintext?⟩ | ⟨URL once at entry, then cookie⟩ | ⟨revocation/expiry⟩ |

## Residual risks

<!-- The honest list: what the design accepts and prices rather than
     prevents. The charter line ("a malicious backend can still
     hard-kill the daemon; the install trust act prices that") belongs
     to the HOST's residual risks — list YOUR surface's own here. -->

- ⟨risk⟩ — ⟨why it's accepted / what bounds it⟩

## Reporting

<!-- Where a finder sends a vulnerability report, and what response to
     expect. -->

Report vulnerabilities to ⟨channel — e.g. security@…, or the repo's
private vulnerability reporting⟩. ⟨Expected acknowledgment window.⟩
