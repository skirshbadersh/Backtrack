import { createSign } from "node:crypto";
import type { TokenProvider } from "./rest.ts";

interface AppAuthOptions {
  appId: string;
  privateKeyPem: string;
  installationId: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * GitHub App installation-token provider. Each token is requested with only
 * `issues: write` (which implies read) and `metadata: read`, so a leaked token
 * cannot touch code, workflows or settings even if the App was granted more.
 */
export function githubAppTokenProvider(options: AppAuthOptions): TokenProvider {
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  let cached: { token: string; expiresAt: number } | null = null;

  return async () => {
    if (cached && cached.expiresAt - now().getTime() > 5 * 60_000) return cached.token;
    const res = await doFetch(`${baseUrl}/app/installations/${options.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt(options.appId, options.privateKeyPem, now())}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "bt-prototype",
        "content-type": "application/json",
      },
      body: JSON.stringify({ permissions: { issues: "write", metadata: "read" } }),
    });
    if (!res.ok) throw new Error(`could not mint installation token: HTTP ${res.status}`);
    const body = (await res.json()) as { token: string; expires_at: string };
    cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  };
}

export function appJwt(appId: string, privateKeyPem: string, at: Date): string {
  const iat = Math.floor(at.getTime() / 1000) - 60; // tolerate clock drift
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat, exp: iat + 540, iss: appId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem).toString("base64url");
  return `${unsigned}.${signature}`;
}
