/**
 * lib/demoClient.js
 * Cliente de demostración del flujo Authorization Code + PKCE.
 *
 * Simula lo que haría una app cliente real: genera el code_verifier/challenge,
 * inicia sesión (POST /oauth/login) y canjea el code por un access_token
 * (POST /oauth/token). Usa el redirect_uri "out-of-band" (RFC 8252): el
 * Authorization Server devuelve el `code` directamente en la respuesta, sin
 * necesidad de un servidor propio que capture la redirección.
 *
 * Lo usan tanto los tests como bin/login.js (CLI de demo).
 */

import { randomBytes, createHash, randomUUID } from "node:crypto";
import { OOB_REDIRECT_URI } from "./apiManager.js";

const DEMO_CLIENT_ID = "demo-mcp-client";

function base64UrlSha256(input) {
  return createHash("sha256").update(input).digest("base64url");
}

/**
 * Ejecuta el flujo completo (login + token exchange) y devuelve el access_token.
 * Lanza un Error si las credenciales son incorrectas o el intercambio falla.
 */
export async function login({ baseUrl, username, password, scope }) {
  const codeVerifier  = randomBytes(32).toString("base64url");
  const codeChallenge = base64UrlSha256(codeVerifier);
  const state         = randomUUID();

  const loginResponse = await fetch(`${baseUrl}/oauth/login`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username, password,
      client_id:     DEMO_CLIENT_ID,
      redirect_uri:  OOB_REDIRECT_URI,
      state, scope,
      code_challenge:        codeChallenge,
      code_challenge_method: "S256",
    }),
  });

  if (!loginResponse.ok) {
    const body = await loginResponse.json().catch(() => ({}));
    throw new Error(body.message || `Login rechazado (${loginResponse.status})`);
  }
  const { code } = await loginResponse.json();

  const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type:    "authorization_code",
      code,
      redirect_uri:  OOB_REDIRECT_URI,
      client_id:     DEMO_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenResponse.ok) {
    const body = await tokenResponse.json().catch(() => ({}));
    throw new Error(body.message || `Intercambio de code fallido (${tokenResponse.status})`);
  }
  return tokenResponse.json(); // { access_token, token_type, expires_in, scope }
}

/** Revoca un access_token (RFC 7009). Útil para simular un logout o un incidente. */
export async function revokeToken({ baseUrl, token }) {
  await fetch(`${baseUrl}/oauth/revoke`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ token }),
  });
}
