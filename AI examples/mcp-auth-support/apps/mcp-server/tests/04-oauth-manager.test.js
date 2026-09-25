/**
 * tests/04-oauth-manager.test.js
 * Pruebas de integración con el API Manager externo: flujo Authorization Code
 * + PKCE (login) e introspección OAuth 2.0 (RFC 7662).
 *
 * Demuestran que la autenticación no vive en el proceso del MCP server:
 *   - Login con credenciales inválidas es rechazado por el Authorization Server
 *   - Token expirado / revocado → rechazado según la respuesta de introspección
 *   - Scopes OAuth se traducen a roles de negocio en el resource server
 *   - Servicio de autorización caído → fail-closed (se deniega el acceso)
 *   - Servicio de autorización lento (timeout) → fail-closed
 *
 * MENSAJE CLAVE: si el API Manager no puede confirmar que un token es válido,
 * el acceso se deniega. Nunca se asume "válido por defecto".
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { resolveCallerContext, AuthError, ROLES } from "../lib/auth.js";
import { startApiManager, login, revokeToken } from "@mcp-soporte-cliente/api-manager";
import { createSupportTicket } from "../lib/tools.js";

let apiManager;

before(async () => {
  apiManager = await startApiManager();
  process.env.API_MANAGER_URL = apiManager.url;
});

after(async () => {
  await apiManager.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Login OAuth (Authorization Code + PKCE)", () => {
  it("rechaza credenciales incorrectas antes de emitir ningún code", async () => {
    await assert.rejects(
      () => login({ baseUrl: apiManager.url, username: "agent.a", password: "contraseña-incorrecta" }),
      /incorrectos/i
    );
  });

  it("credenciales válidas devuelven un access_token utilizable", async () => {
    const result = await login({ baseUrl: apiManager.url, username: "agent.a", password: "demo1234" });

    assert.ok(result.access_token, "Debe devolver un access_token");
    assert.equal(result.token_type, "Bearer");

    const ctx = await resolveCallerContext(result.access_token);
    assert.equal(ctx.tenantId, "tenant-A");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Introspección OAuth — tokens no activos", () => {
  it("token expirado (TTL agotado) es rechazado", async () => {
    const originalTtl = process.env.API_MANAGER_TOKEN_TTL_MS;
    process.env.API_MANAGER_TOKEN_TTL_MS = "50"; // el access_token expira casi al emitirse

    try {
      const { access_token } = await login({ baseUrl: apiManager.url, username: "agent.a", password: "demo1234" });
      await new Promise((resolve) => setTimeout(resolve, 100)); // esperar a que expire

      await assert.rejects(() => resolveCallerContext(access_token), AuthError);
    } finally {
      if (originalTtl === undefined) delete process.env.API_MANAGER_TOKEN_TTL_MS;
      else process.env.API_MANAGER_TOKEN_TTL_MS = originalTtl;
    }
  });

  it("token revocado es rechazado", async () => {
    const { access_token } = await login({ baseUrl: apiManager.url, username: "support.a", password: "demo1234" });

    // El token es válido hasta que se revoca explícitamente (p.ej. logout o incidente de seguridad)
    await resolveCallerContext(access_token);

    await revokeToken({ baseUrl: apiManager.url, token: access_token });

    await assert.rejects(() => resolveCallerContext(access_token), AuthError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Mapeo de scopes OAuth a roles de negocio", () => {
  it("scope 'agent:read' se traduce solo al rol AGENT, no a SUPPORT/FINANCE", async () => {
    const { access_token } = await login({ baseUrl: apiManager.url, username: "agent.a", password: "demo1234" });
    const ctx = await resolveCallerContext(access_token);

    assert.deepEqual(ctx.roles, [ROLES.AGENT]);

    // Al no tener el scope 'support:write', la tool debe rechazar por rol insuficiente
    await assert.rejects(
      () => createSupportTicket(ctx, {
        customerId:  "cust-001",
        category:    "billing",
        description: "Intento de crear ticket con un token de scope insuficiente.",
      }),
      AuthError
    );
  });

  it("scope 'finance:refund' habilita el rol FINANCE", async () => {
    const { access_token } = await login({ baseUrl: apiManager.url, username: "finance.a", password: "demo1234" });
    const ctx = await resolveCallerContext(access_token);
    assert.ok(ctx.roles.includes(ROLES.FINANCE));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Fail-closed cuando el API Manager no está disponible", () => {
  it("deniega el acceso si el servicio de autorización no responde", async () => {
    const down = await startApiManager();
    const { access_token } = await login({ baseUrl: down.url, username: "agent.a", password: "demo1234" });

    const originalUrl = process.env.API_MANAGER_URL;
    process.env.API_MANAGER_URL = down.url;
    await down.close(); // el servicio deja de responder a partir de aquí

    await assert.rejects(
      () => resolveCallerContext(access_token),
      (err) => {
        assert.ok(err instanceof AuthError);
        assert.match(err.message, /no disponible/i);
        return true;
      }
    );

    process.env.API_MANAGER_URL = originalUrl;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Fail-closed cuando el API Manager tarda demasiado", () => {
  let originalTimeout, originalDelay;

  beforeEach(() => {
    originalTimeout = process.env.API_MANAGER_TIMEOUT_MS;
    originalDelay   = process.env.API_MANAGER_INTROSPECT_DELAY_MS;
  });

  afterEach(() => {
    if (originalTimeout === undefined) delete process.env.API_MANAGER_TIMEOUT_MS;
    else process.env.API_MANAGER_TIMEOUT_MS = originalTimeout;
    if (originalDelay === undefined) delete process.env.API_MANAGER_INTROSPECT_DELAY_MS;
    else process.env.API_MANAGER_INTROSPECT_DELAY_MS = originalDelay;
  });

  it("deniega el acceso si la introspección excede el timeout configurado", async () => {
    // Token obtenido con el API Manager respondiendo con normalidad…
    const { access_token } = await login({ baseUrl: apiManager.url, username: "agent.a", password: "demo1234" });

    // …y luego simulamos un IdP lento: introspección retrasada por encima del timeout del cliente
    process.env.API_MANAGER_INTROSPECT_DELAY_MS = "300";
    process.env.API_MANAGER_TIMEOUT_MS = "100";

    await assert.rejects(
      () => resolveCallerContext(access_token),
      (err) => {
        assert.ok(err instanceof AuthError);
        assert.match(err.message, /no disponible/i);
        return true;
      }
    );
  });
});
