# @openparachute/app-client

Shared browser-side library for [Parachute](https://parachute.computer) apps hosted under [`@openparachute/app`](https://www.npmjs.com/package/@openparachute/app).

Each hosted UI under parachute-app would otherwise re-implement OAuth + vault REST + token storage from scratch — Notes did this; the Gitcoin Brain UI did its own. This library extracts the canonical pattern so future apps depend on one well-tested implementation. Same trajectory as `@openparachute/scope-guard` for resource-server JWT validation.

## Surface

```ts
import {
  ParachuteOAuth,
  VaultClient,
  loadToken, saveToken, clearToken,
  reloadAfterServiceWorkerUpdate,
  vaultIdFromUrl, normalizeVaultUrl,
} from "@openparachute/app-client";
```

| Module                        | Surface                                                                         |
|-------------------------------|---------------------------------------------------------------------------------|
| `oauth`                       | `ParachuteOAuth` driver class — PKCE + same-hub auto-trust                       |
| `vault-client`                | `VaultClient` REST client with auto-refresh on 401 + structured errors           |
| `token-storage`               | `loadToken` / `saveToken` / `clearToken` / `clearAllTokensForApp`                |
| `sw-reload`                   | `reloadAfterServiceWorkerUpdate` — PWA-mode SW reload helper                     |
| `vault-id`                    | `vaultIdFromUrl` / `normalizeVaultUrl` — canonical URL ↔ storage-key mapping     |

See the source in `src/` for the full surface; everything is re-exported from the barrel.

## OAuth quick-start

```ts
const oauth = new ParachuteOAuth({
  appName: "my-app",     // matches the meta.json `name`
  hubUrl: window.location.origin,
});

// 1. Boot — read our client_id from the app daemon:
const { client_id } = await oauth.getClientId();

// 2. Begin the flow (caller chooses how to navigate):
const { authorizeUrl } = await oauth.beginFlow({
  vaultName: "default",
  redirectUri: `${window.location.origin}/app/my-app/oauth/callback`,
});
window.location.assign(authorizeUrl);

// 3. After the redirect-back, on the callback page:
const url = new URL(window.location.href);
const code = url.searchParams.get("code")!;
const state = url.searchParams.get("state")!;
await oauth.handleCallback(code, state, "default");

// 4. Read the token whenever you need it:
const stored = oauth.getToken("default");
if (stored) {
  const vault = new VaultClient({
    vaultUrl: stored.vault ? `${hubUrl}/vault/${stored.vault}` : vaultUrl,
    accessToken: stored.accessToken,
    onAuthError: async () => {
      // refresh on 401, return fresh token or null
      if (!stored.refreshToken) return null;
      const { token } = await oauth.refreshAccessToken(stored.refreshToken, "default");
      return token.access_token;
    },
  });
  const notes = await vault.queryNotes({ tag: "x" });
}
```

## License

AGPL-3.0.
