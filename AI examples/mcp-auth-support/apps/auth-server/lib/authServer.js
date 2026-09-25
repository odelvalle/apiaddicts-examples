/**
 * lib/apiManager.js
 * "API Manager" / Authorization Server simulado — servicio EXTERNO al servidor MCP.
 *
 * Implementa el flujo OAuth 2.0 Authorization Code + PKCE (RFC 6749 + RFC 7636):
 *   GET  /oauth/authorize   → sirve un formulario de login (usuario/contraseña)
 *   POST /oauth/login       → valida credenciales, emite un `code` de un solo uso
 *   POST /oauth/token       → intercambia el `code` (+ code_verifier) por un access_token
 *   POST /oauth/introspect  → introspección del access_token (RFC 7662)
 *   POST /oauth/revoke      → revocación de tokens (RFC 7009)
 *
 * PATRÓN CLAVE: el MCP server (resource server) nunca ve contraseñas ni la
 * tabla de usuarios — solo recibe un access_token opaco y lo valida vía
 * introspección. La autenticación del usuario ocurre enteramente en este
 * proceso externo, como en un IdP real (Auth0, Keycloak, Okta…).
 */

import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

// Redirect URI "out-of-band" (RFC 8252): para clientes sin servidor propio
// (apps nativas, CLIs, tests), el Authorization Server devuelve el `code`
// directamente en la respuesta en lugar de redirigir a una URL.
export const OOB_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

// Allowlist de clientes registrados — evita "open redirect" con redirect_uri arbitrarios.
const CLIENTS = {
  "demo-mcp-client": { redirectUris: [OOB_REDIRECT_URI, "http://localhost:4300/callback"] },
};

// Usuarios de demostración — equivalente al directorio de identidades de un IdP real.
// El MCP server nunca tiene acceso a esta tabla.
const USERS = {
  "agent.a":   { password: "demo1234", sub: "user-101", tenant_id: "tenant-A", scope: "agent:read" },
  "support.a": { password: "demo1234", sub: "user-102", tenant_id: "tenant-A", scope: "agent:read support:write" },
  "finance.a": { password: "demo1234", sub: "user-103", tenant_id: "tenant-A", scope: "agent:read finance:refund" },
  "agent.b":   { password: "demo1234", sub: "user-201", tenant_id: "tenant-B", scope: "agent:read" },
};

const AUTH_CODE_TTL_MS = 60_000; // los códigos de autorización viven poco y se usan una sola vez

// Estado en memoria del Authorization Server.
const authCodes    = new Map(); // code  -> { sub, tenant_id, scope, clientId, redirectUri, codeChallenge, exp, used }
const accessTokens = new Map(); // token -> { sub, tenant_id, scope, exp, revoked }

// Leídos en cada llamada (no cacheados) para poder ajustarlos desde los tests.
function getTokenTtlMs() {
  return Number(process.env.API_MANAGER_TOKEN_TTL_MS) || 3_600_000; // 1h por defecto
}
function getIntrospectDelayMs() {
  return Number(process.env.API_MANAGER_INTROSPECT_DELAY_MS) || 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExpired(exp) {
  return typeof exp === "number" && exp < Date.now();
}

// Comparación en tiempo constante — evita timing attacks sobre la contraseña.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function base64UrlSha256(input) {
  return createHash("sha256").update(input).digest("base64url");
}

// Todo valor reflejado en HTML se escapa — evita XSS reflejado vía query params.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// Soporta JSON (clientes programáticos / CLI) y application/x-www-form-urlencoded (formulario HTML).
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try {
        const contentType = req.headers["content-type"] || "";
        resolve(contentType.includes("application/json")
          ? (raw ? JSON.parse(raw) : {})
          : Object.fromEntries(new URLSearchParams(raw)));
      } catch {
        reject(new Error("Cuerpo de la petición no es válido"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendHtml(res, statusCode, html) {
  const payload = Buffer.from(html, "utf-8");
  res.writeHead(statusCode, { "content-type": "text/html; charset=utf-8", "content-length": payload.length });
  res.end(payload);
}

// ── GET /oauth/authorize — formulario de login ───────────────────────────────
function handleAuthorize(req, res, query) {
  const { client_id, redirect_uri, state, scope, code_challenge, code_challenge_method } = query;

  const client = CLIENTS[client_id];
  if (!client || !client.redirectUris.includes(redirect_uri)) {
    sendJson(res, 400, { error: "invalid_request", message: "client_id o redirect_uri desconocidos" });
    return;
  }
  if (code_challenge_method !== "S256") {
    sendJson(res, 400, { error: "invalid_request", message: "Solo se admite code_challenge_method=S256 (PKCE)" });
    return;
  }

  const hidden = { client_id, redirect_uri, state, scope, code_challenge, code_challenge_method };
  const hiddenInputs = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n    ");

  sendHtml(res, 200, `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Iniciar sesión</title></head>
<body>
  <h1>Autorizar acceso</h1>
  <p>La aplicación <strong>${escapeHtml(client_id)}</strong> solicita acceso con scope: <code>${escapeHtml(scope)}</code></p>
  <form method="POST" action="/oauth/login">
    ${hiddenInputs}
    <label>Usuario: <input type="text" name="username" required></label><br>
    <label>Contraseña: <input type="password" name="password" required></label><br>
    <button type="submit">Iniciar sesión y autorizar</button>
  </form>
</body></html>`);
}

// ── POST /oauth/login — valida credenciales y emite el authorization code ───
async function handleLogin(req, res) {
  const { username, password, client_id, redirect_uri, state, scope, code_challenge, code_challenge_method } =
    await readBody(req);

  const client = CLIENTS[client_id];
  if (!client || !client.redirectUris.includes(redirect_uri)) {
    sendJson(res, 400, { error: "invalid_request", message: "client_id o redirect_uri desconocidos" });
    return;
  }

  const user = USERS[username];
  if (!user || !safeEqual(user.password, password ?? "")) {
    sendJson(res, 401, { error: "access_denied", message: "Usuario o contraseña incorrectos" });
    return;
  }

  const code = randomBytes(24).toString("base64url");
  authCodes.set(code, {
    sub:           user.sub,
    tenant_id:     user.tenant_id,
    scope:         scope || user.scope,
    clientId:      client_id,
    redirectUri:   redirect_uri,
    codeChallenge: code_challenge,
    exp:           Date.now() + AUTH_CODE_TTL_MS,
    used:          false,
  });

  if (redirect_uri === OOB_REDIRECT_URI) {
    sendJson(res, 200, { code, state });
    return;
  }

  const location = `${redirect_uri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state ?? "")}`;
  res.writeHead(302, { location });
  res.end();
}

// ── POST /oauth/token — intercambia el code (+ code_verifier) por un access_token ──
async function handleToken(req, res) {
  const { grant_type, code, redirect_uri, client_id, code_verifier } = await readBody(req);

  if (grant_type !== "authorization_code") {
    sendJson(res, 400, { error: "unsupported_grant_type" });
    return;
  }

  const record = authCodes.get(code);
  if (!record || record.used || isExpired(record.exp)) {
    sendJson(res, 400, { error: "invalid_grant", message: "Code inválido, expirado o ya utilizado" });
    return;
  }
  if (record.clientId !== client_id || record.redirectUri !== redirect_uri) {
    sendJson(res, 400, { error: "invalid_grant", message: "client_id o redirect_uri no coinciden con la autorización" });
    return;
  }
  // PKCE: el verifier debe producir, tras SHA-256 + base64url, el challenge recibido en /authorize.
  if (base64UrlSha256(code_verifier ?? "") !== record.codeChallenge) {
    sendJson(res, 400, { error: "invalid_grant", message: "code_verifier no coincide con el code_challenge (PKCE)" });
    return;
  }

  record.used = true; // un code solo puede canjearse una vez — evita ataques de repetición

  const accessToken = randomBytes(32).toString("base64url");
  const ttlMs = getTokenTtlMs();
  accessTokens.set(accessToken, {
    sub:       record.sub,
    tenant_id: record.tenant_id,
    scope:     record.scope,
    exp:       Date.now() + ttlMs,
    revoked:   false,
  });

  sendJson(res, 200, {
    access_token: accessToken,
    token_type:   "Bearer",
    expires_in:   Math.floor(ttlMs / 1000),
    scope:        record.scope,
  });
}

// ── POST /oauth/introspect — RFC 7662, consumido por el resource server (MCP) ──
async function handleIntrospect(req, res) {
  const body = await readBody(req);

  const delay = getIntrospectDelayMs();
  if (delay > 0) await sleep(delay);

  const record = accessTokens.get(body?.token);
  if (!record || record.revoked || isExpired(record.exp)) {
    sendJson(res, 200, { active: false });
    return;
  }
  sendJson(res, 200, { active: true, sub: record.sub, tenant_id: record.tenant_id, scope: record.scope });
}

// ── POST /oauth/revoke — RFC 7009 ────────────────────────────────────────────
async function handleRevoke(req, res) {
  const body = await readBody(req);
  const record = accessTokens.get(body?.token);
  if (record) record.revoked = true;
  // RFC 7009: se responde 200 aunque el token no exista, para no filtrar información.
  sendJson(res, 200, {});
}

function createApiManager() {
  return createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    const handlers = {
      "GET /oauth/authorize":   () => handleAuthorize(req, res, Object.fromEntries(url.searchParams)),
      "POST /oauth/login":      () => handleLogin(req, res),
      "POST /oauth/token":      () => handleToken(req, res),
      "POST /oauth/introspect": () => handleIntrospect(req, res),
      "POST /oauth/revoke":     () => handleRevoke(req, res),
    };

    const handler = handlers[route];
    if (!handler) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    Promise.resolve(handler()).catch((err) => sendJson(res, 500, { error: "server_error", message: err.message }));
  });
}

/**
 * Arranca el API Manager simulado y devuelve su URL base y un `close()`.
 * Con `port: 0` (por defecto) el SO asigna un puerto libre — ideal para tests.
 */
export function startApiManager({ port = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const server = createApiManager();
    server.once("error", reject);
    server.listen(port, () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        url: `http://localhost:${actualPort}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

