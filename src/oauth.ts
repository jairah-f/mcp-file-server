// M5, step 2: the OAuth 2.1 "authorization server" part of the HTTP server.
//
// Why this exists: Claude.ai's custom connector cannot send a fixed secret header. It signs in
// with OAuth instead. This file lets THIS server play both roles:
//   - resource server: the MCP endpoint /mcp (wired up in src/server-http.ts, step 3)
//   - authorization server: hands out short-lived access tokens, but ONLY after the OWNER
//     (you) approves the connection with a password on a web page.
//
// The standard, security-sensitive parts come from the MCP SDK (src/server/auth in the SDK):
//   discovery metadata, /register, /authorize (parameter checks, exact redirect-URI match),
//   /token (S256 PKCE check, rate limits), /revoke.
// This file only adds what the SDK leaves to the application: where things are stored,
// and the owner-approval page.
//
// Security rules implemented here (each one is tested in step 4):
//   - Nobody gets a token without the owner password (MCP_OWNER_PASSWORD).
//   - Client registration only accepts Claude's own callback URLs (plus any you list explicitly),
//     so a stranger who finds the URL cannot register an app that redirects somewhere else.
//   - Authorization codes: random, 5 minutes, single use. Re-using one revokes everything issued from it.
//   - Access tokens: random, 1 hour (default), bound to this server's /mcp URL (RFC 8707).
//   - Refresh tokens: random, 30 days, ROTATED on every use. Re-using an old one revokes the whole grant.
//   - Tokens, codes and the password are never logged, and tokens are kept in memory only as SHA-256 hashes.
//   - Everything is in memory: restarting the server forgets all clients and tokens
//     (Claude then shows "reconnect"). No token or secret is ever written to disk.
//
// This is a one-owner authorization server built for a class demo. It is not a general identity provider.

import crypto from "node:crypto";
import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

// ---------------------------------------------------------------------------
// Configuration (from environment variables; nothing is hard-coded)
// ---------------------------------------------------------------------------

// The callback addresses Claude uses (from Claude's connector documentation).
export const CLAUDE_REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];

// The one permission this server hands out: use the tools inside workspace/.
export const SCOPE = "workspace";

export const MIN_OWNER_PASSWORD_LENGTH = 12;
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PENDING_REQUEST_TTL_MS = 10 * 60 * 1000; // the owner has 10 minutes to answer the approval page
const MAX_CLIENTS = 100;
const MAX_PENDING_REQUESTS = 200;
const MAX_FAILED_PASSWORD_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export type OAuthConfig = {
  publicUrl: URL; // the public https address of this server, with no path (for example your ngrok address)
  resourceUrl: URL; // publicUrl + "/mcp": the "audience" every access token is bound to
  ownerPassword: string;
  allowedRedirectUris: string[]; // exact addresses an app may register
  accessTokenTtlSeconds: number;
};

const isLoopback = (host: string): boolean => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

// Returns null when OAuth is not configured at all (then only the static token works, as before).
// Throws an Error with a plain-English message when the settings are incomplete or unsafe.
export function loadOAuthConfig(env: NodeJS.ProcessEnv): OAuthConfig | null {
  const rawUrl = (env.MCP_PUBLIC_URL ?? "").trim();
  const password = env.MCP_OWNER_PASSWORD ?? "";
  if (rawUrl === "" && password.trim() === "") return null;
  if (rawUrl === "") throw new Error("MCP_OWNER_PASSWORD is set but MCP_PUBLIC_URL is not. Set both (see README.md) or neither.");
  if (password.trim() === "") throw new Error("MCP_PUBLIC_URL is set but MCP_OWNER_PASSWORD is not. Set both (see README.md) or neither.");

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("MCP_PUBLIC_URL is not a valid address. Example shape: https://your-name.ngrok-free.dev");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("MCP_PUBLIC_URL must start with https:// (plain http is only allowed for localhost testing).");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("MCP_PUBLIC_URL must be only the address (like https://your-name.ngrok-free.dev), with no path, query or login.");
  }
  const publicUrl = new URL(url.origin);

  if (password.length < MIN_OWNER_PASSWORD_LENGTH) {
    throw new Error(`MCP_OWNER_PASSWORD is too short. Use at least ${MIN_OWNER_PASSWORD_LENGTH} characters.`);
  }
  const staticToken = (env.MCP_AUTH_TOKEN ?? "").trim();
  if (staticToken !== "" && password === staticToken) {
    throw new Error("MCP_OWNER_PASSWORD must be different from MCP_AUTH_TOKEN. They protect different things.");
  }

  const allowedRedirectUris = [...CLAUDE_REDIRECT_URIS];
  for (const item of (env.MCP_EXTRA_REDIRECT_URIS ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "")) {
    let extra: URL;
    try {
      extra = new URL(item);
    } catch {
      throw new Error(`MCP_EXTRA_REDIRECT_URIS contains something that is not an address: "${item.slice(0, 60)}"`);
    }
    if ((extra.protocol !== "https:" && !(extra.protocol === "http:" && isLoopback(extra.hostname))) || extra.hash !== "") {
      throw new Error("MCP_EXTRA_REDIRECT_URIS entries must be https:// (or http://localhost for testing) and have no #fragment.");
    }
    allowedRedirectUris.push(extra.href);
  }

  let ttl = DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const rawTtl = (env.MCP_ACCESS_TOKEN_TTL_SECONDS ?? "").trim();
  if (rawTtl !== "") {
    ttl = Number(rawTtl);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) throw new Error("MCP_ACCESS_TOKEN_TTL_SECONDS must be a whole number from 1 to 86400.");
  }

  return { publicUrl, resourceUrl: new URL("/mcp", publicUrl), ownerPassword: password, allowedRedirectUris, accessTokenTtlSeconds: ttl };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sha256 = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
const randomToken = (): string => crypto.randomBytes(32).toString("base64url"); // 256 bits

// Compare two secrets without leaking where they differ (both are hashed to the same length first).
function sameSecret(a: string, b: string): boolean {
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());
}

// Two resource addresses are "the same" ignoring a #fragment and one trailing slash.
function normaliseResource(value: URL | string): string {
  const u = new URL(String(value));
  u.hash = "";
  return u.href.replace(/\/$/, "");
}
export const sameResource = (a: URL | string, b: URL | string): boolean => normaliseResource(a) === normaliseResource(b);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

// The app name is chosen by whoever registered the app, so it is untrusted text: clean it before showing it.
function safeLabel(text: string | undefined): string {
  const cleaned = (text ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return cleaned === "" ? "an unnamed app" : cleaned;
}

function evictOldest<T>(map: Map<string, T>): void {
  const first = map.keys().next();
  if (!first.done) map.delete(first.value);
}

// ---------------------------------------------------------------------------
// The owner-approval page
// ---------------------------------------------------------------------------

function renderConsentPage(opts: { clientName: string; redirectHost: string; requestId: string; message?: string }): string {
  const message = opts.message ? `<p class="msg">${escapeHtml(opts.message)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Approve connection - MCP File Server</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 2.5rem auto; padding: 0 1rem; line-height: 1.5; }
  .box { border: 1px solid #8886; border-radius: 10px; padding: 1.25rem; }
  .msg { color: #b00020; font-weight: 600; }
  .warn { background: #fff4e5; color: #4a3000; border-radius: 8px; padding: .6rem .8rem; }
  input[type=password] { width: 100%; padding: .55rem; font-size: 1rem; box-sizing: border-box; margin: .3rem 0 1rem; }
  button { font-size: 1rem; padding: .55rem 1.1rem; margin-right: .5rem; cursor: pointer; }
</style>
</head>
<body>
<h1>Approve a connection?</h1>
<div class="box">
  ${message}
  <p>An app called <strong>${escapeHtml(opts.clientName)}</strong> wants to connect to your MCP File Server.</p>
  <p>After you approve, it returns to <strong>${escapeHtml(opts.redirectHost)}</strong>.</p>
  <p class="warn">If you approve, it can <strong>read, write and delete files</strong> inside your <code>workspace/</code> folder, including the handoff files. The app name is chosen by the app itself and is not verified. Only approve if you just started this connection yourself.</p>
  <form method="post" action="/consent" autocomplete="off">
    <input type="hidden" name="request_id" value="${escapeHtml(opts.requestId)}">
    <label for="pw">Owner password</label>
    <input id="pw" type="password" name="password" autocomplete="current-password">
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
  </form>
</div>
</body>
</html>`;
}

function renderMessagePage(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:34rem;margin:2.5rem auto;padding:0 1rem;line-height:1.5"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`;
}

// Headers for every page this server shows to a person.
function sendPage(res: Response, status: number, html: string): void {
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY", // nobody can show this page inside another site (clickjacking)
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    })
    .send(html);
}

// ---------------------------------------------------------------------------
// The provider: stores clients, codes and tokens, and issues / checks them
// ---------------------------------------------------------------------------

type PendingRequest = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
  expiresAt: number;
};
type CodeRecord = { clientId: string; codeChallenge: string; redirectUri: string; familyId: string; expiresAt: number; used: boolean };
type TokenRecord = { clientId: string; resource: URL; scopes: string[]; familyId: string; expiresAt: number };
type RotatedRecord = { clientId: string; familyId: string; expiresAt: number };

export class OwnerApprovalProvider implements OAuthServerProvider {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly pending = new Map<string, PendingRequest>(); // key: random request id
  private readonly codes = new Map<string, CodeRecord>(); // key: SHA-256 of the code
  private readonly accessTokens = new Map<string, TokenRecord>(); // key: SHA-256 of the token
  private readonly refreshTokens = new Map<string, TokenRecord>();
  private readonly rotatedRefreshTokens = new Map<string, RotatedRecord>(); // already-used refresh tokens (to detect theft)
  private failedAttempts = 0;
  private lockedUntil = 0;
  private readonly allowedRedirects: Set<string>;
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly config: OAuthConfig,
    private readonly log: (message: string) => void = (m) => console.log(m)
  ) {
    this.allowedRedirects = new Set(config.allowedRedirectUris.map((u) => new URL(u).href));
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref(); // never keeps the server alive on its own
  }

  dispose(): void {
    clearInterval(this.sweeper);
  }

  // -- clients (Dynamic Client Registration, RFC 7591) ----------------------

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.clients.get(clientId),
      registerClient: (info) => {
        const uris = info.redirect_uris.map(String);
        if (uris.length === 0 || !uris.every((u) => this.allowedRedirects.has(new URL(u).href))) {
          throw new InvalidClientMetadataError("redirect_uris must be Claude's callback addresses (or addresses the server owner allowed).");
        }
        if (this.clients.size >= MAX_CLIENTS) evictOldest(this.clients);
        const client = {
          ...info,
          client_id: (info as { client_id?: string }).client_id ?? crypto.randomUUID(),
          client_id_issued_at: (info as { client_id_issued_at?: number }).client_id_issued_at ?? Math.floor(Date.now() / 1000),
        } as OAuthClientInformationFull;
        this.clients.set(client.client_id, client);
        return client;
      },
    };
  }

  // -- step 1: the app sends the owner here (the SDK has already checked the app and its redirect address) --

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweep();
    // Tokens are bound to THIS server. A request for any other resource is refused.
    if (params.resource !== undefined && !sameResource(params.resource, this.config.resourceUrl)) {
      throw new InvalidTargetError("The resource parameter must be this server's /mcp address.");
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) evictOldest(this.pending);
    const requestId = randomToken();
    this.pending.set(requestId, {
      clientId: client.client_id,
      clientName: safeLabel(client.client_name),
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      expiresAt: Date.now() + PENDING_REQUEST_TTL_MS,
    });
    const redirectHost = new URL(params.redirectUri).host;
    sendPage(res, 200, renderConsentPage({ clientName: safeLabel(client.client_name), redirectHost, requestId }));
  }

  // -- step 2: the owner answers the approval page (POST /consent) --------------

  handleConsent(req: Request, res: Response): void {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestId = typeof body.request_id === "string" ? body.request_id : "";
    const decision = body.decision === "approve" || body.decision === "deny" ? body.decision : "";
    const password = typeof body.password === "string" ? body.password : "";

    const request = this.pending.get(requestId);
    if (!request || request.expiresAt <= Date.now()) {
      if (request) this.pending.delete(requestId);
      sendPage(res, 400, renderMessagePage("Request expired", "This approval request is invalid or has expired. Go back to Claude and start the connection again."));
      return;
    }
    if (decision === "") {
      sendPage(res, 400, renderMessagePage("Bad request", "Choose Approve or Deny."));
      return;
    }

    if (decision === "deny") {
      this.pending.delete(requestId);
      this.log("OAuth: the owner denied a connection request.");
      this.redirectBack(res, request, { error: "access_denied", error_description: "The owner denied the request." });
      return;
    }

    // Approve: the owner password is checked first. Too many wrong tries lock approvals for a while.
    // (Behind a tunnel every request looks like it comes from the same address, so the lock is global.)
    if (Date.now() < this.lockedUntil) {
      sendPage(res, 429, renderMessagePage("Too many attempts", "Approvals are locked for a few minutes after repeated wrong passwords. Try again later."));
      return;
    }
    if (!sameSecret(password, this.config.ownerPassword)) {
      this.failedAttempts++;
      if (this.failedAttempts >= MAX_FAILED_PASSWORD_ATTEMPTS) {
        this.failedAttempts = 0;
        this.lockedUntil = Date.now() + LOCKOUT_MS;
        this.log("OAuth: too many wrong owner passwords. Approvals are locked for 15 minutes.");
        sendPage(res, 429, renderMessagePage("Too many attempts", "Approvals are locked for 15 minutes after repeated wrong passwords."));
        return;
      }
      this.log(`OAuth: a wrong owner password was entered (${this.failedAttempts} in a row).`);
      sendPage(
        res,
        401,
        renderConsentPage({ clientName: request.clientName, redirectHost: new URL(request.redirectUri).host, requestId, message: "Wrong password. Try again." })
      );
      return;
    }

    // Approved: make a single-use authorization code and send the owner back to the app.
    this.failedAttempts = 0;
    this.pending.delete(requestId);
    const code = randomToken();
    this.codes.set(sha256(code), {
      clientId: request.clientId,
      codeChallenge: request.codeChallenge,
      redirectUri: request.redirectUri,
      familyId: crypto.randomUUID(),
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      used: false,
    });
    this.log("OAuth: the owner approved a connection request.");
    this.redirectBack(res, request, { code });
  }

  private redirectBack(res: Response, request: PendingRequest, params: Record<string, string>): void {
    const target = new URL(request.redirectUri);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    if (request.state !== undefined) target.searchParams.set("state", request.state);
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }).redirect(302, target.href);
  }

  // -- step 3: the app swaps the code for tokens (the SDK checks the PKCE proof between these two calls) --

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = this.codes.get(sha256(authorizationCode));
    if (!record || record.clientId !== client.client_id || record.expiresAt <= Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code.");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = this.codes.get(sha256(authorizationCode));
    if (!record || record.clientId !== client.client_id || record.expiresAt <= Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code.");
    }
    if (record.used) {
      // A code is only ever used once. A second use means it was copied: cancel everything issued from it.
      this.revokeFamily(record.familyId);
      this.log("OAuth: an authorization code was used twice. The tokens issued from it were revoked.");
      throw new InvalidGrantError("This authorization code was already used.");
    }
    if (redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    }
    if (resource !== undefined && !sameResource(resource, this.config.resourceUrl)) {
      throw new InvalidTargetError("The resource parameter must be this server's /mcp address.");
    }
    record.used = true;
    return this.issueTokens(client.client_id, record.familyId);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const key = sha256(refreshToken);
    const rotated = this.rotatedRefreshTokens.get(key);
    if (rotated) {
      // An already-used refresh token came back. Either the app or a thief has an old copy: cancel the whole grant.
      if (rotated.clientId === client.client_id) {
        this.revokeFamily(rotated.familyId);
        this.log("OAuth: an old refresh token was presented again. The whole grant was revoked.");
      }
      throw new InvalidGrantError("This refresh token was already used.");
    }
    const record = this.refreshTokens.get(key);
    if (!record || record.clientId !== client.client_id || record.expiresAt <= Date.now()) {
      throw new InvalidGrantError("Invalid or expired refresh token.");
    }
    if (resource !== undefined && !sameResource(resource, record.resource)) {
      throw new InvalidTargetError("The resource parameter must be this server's /mcp address.");
    }
    if (scopes !== undefined && scopes.some((s) => !record.scopes.includes(s))) {
      throw new InvalidScopeError("A scope that was not granted was requested.");
    }
    // Rotate: the old refresh token and the old access tokens stop working, new ones are issued.
    this.refreshTokens.delete(key);
    this.rotatedRefreshTokens.set(key, { clientId: record.clientId, familyId: record.familyId, expiresAt: record.expiresAt });
    for (const [k, t] of this.accessTokens) if (t.familyId === record.familyId) this.accessTokens.delete(k);
    return this.issueTokens(record.clientId, record.familyId);
  }

  private issueTokens(clientId: string, familyId: string): OAuthTokens {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const now = Date.now();
    const ttl = this.config.accessTokenTtlSeconds;
    this.accessTokens.set(sha256(accessToken), { clientId, resource: this.config.resourceUrl, scopes: [SCOPE], familyId, expiresAt: now + ttl * 1000 });
    this.refreshTokens.set(sha256(refreshToken), { clientId, resource: this.config.resourceUrl, scopes: [SCOPE], familyId, expiresAt: now + REFRESH_TOKEN_TTL_MS });
    return { access_token: accessToken, token_type: "Bearer", expires_in: ttl, refresh_token: refreshToken, scope: SCOPE };
  }

  // -- checking a token on every /mcp request ---------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const key = sha256(token);
    const record = this.accessTokens.get(key);
    if (!record) throw new InvalidTokenError("Invalid access token.");
    if (record.expiresAt <= Date.now()) {
      this.accessTokens.delete(key);
      throw new InvalidTokenError("The access token has expired.");
    }
    return { token, clientId: record.clientId, scopes: record.scopes, expiresAt: Math.floor(record.expiresAt / 1000), resource: record.resource };
  }

  // -- revoking (RFC 7009) -------------------------------------------------------

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = sha256(request.token);
    const record = this.accessTokens.get(key) ?? this.refreshTokens.get(key);
    if (record && record.clientId === client.client_id) this.revokeFamily(record.familyId); // the whole grant, to be safe
  }

  private revokeFamily(familyId: string): void {
    for (const [k, t] of this.accessTokens) if (t.familyId === familyId) this.accessTokens.delete(k);
    for (const [k, t] of this.refreshTokens) if (t.familyId === familyId) this.refreshTokens.delete(k);
  }

  // Forget everything that has expired.
  private sweep(): void {
    const now = Date.now();
    for (const map of [this.pending, this.codes, this.accessTokens, this.refreshTokens, this.rotatedRefreshTokens] as Array<Map<string, { expiresAt: number }>>) {
      for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// The web app that serves the OAuth endpoints (mounted by src/server-http.ts in step 3)
// ---------------------------------------------------------------------------

// Which URL paths belong to the OAuth part. Everything else is handled by the MCP code as before.
export function isOAuthPath(pathname: string): boolean {
  return pathname.startsWith("/.well-known/oauth-") || ["/authorize", "/consent", "/token", "/register", "/revoke"].includes(pathname);
}

// The address of the "protected resource metadata" document. It goes into the WWW-Authenticate header of 401 answers.
export function resourceMetadataUrl(config: OAuthConfig): string {
  return getOAuthProtectedResourceMetadataUrl(config.resourceUrl);
}

function approvalRouter(provider: OwnerApprovalProvider): Router {
  const router = express.Router();
  router.post("/consent", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => provider.handleConsent(req, res));
  return router;
}

export function createOAuthApp(config: OAuthConfig, log?: (message: string) => void): { app: express.Express; provider: OwnerApprovalProvider } {
  const provider = new OwnerApprovalProvider(config, log);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // exactly one proxy (ngrok) sits in front of this server

  app.use(approvalRouter(provider));

  // Claude's documentation: when the server no longer knows a client (for example after a restart, because
  // clients are kept in memory), the token endpoint must answer HTTP 401 with error "invalid_client".
  // That tells Claude to register again. The SDK answers 400 for this case, so it is changed to 401 here.
  app.post("/token", (_req: Request, res: Response, next: NextFunction) => {
    const sendJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if ((body as { error?: unknown } | null)?.error === "invalid_client") res.status(401);
      return sendJson(body);
    }) as typeof res.json;
    next();
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      resourceServerUrl: config.resourceUrl,
      scopesSupported: [SCOPE],
      resourceName: "MCP File Server",
    })
  );

  // Anything else: a plain JSON answer, never a stack trace.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ error: "invalid_request", error_description: "The request could not be read." });
      return;
    }
    console.error("OAuth request failed:", err instanceof Error ? err.message : "unknown error");
    res.status(500).json({ error: "server_error" });
  });

  return { app, provider };
}