/**
 * lib/auth.js
 * Autorización y resolución de contexto de llamante.
 *
 * PATRÓN CLAVE: El control de acceso vive en el servidor, no en el modelo.
 * El agente nunca puede escalar permisos escribiendo texto en los parámetros;
 * lo único que cuenta es el token validado externamente.
 *
 * El MCP server actúa como "resource server" OAuth 2.0: no valida tokens por
 * sí mismo, delega la verificación a un Authorization Server externo
 * (apps/auth-server/lib/authServer.js) vía el endpoint de introspección (RFC 7662).
 * Si ese servicio no responde, el acceso se deniega (fail-closed).
 */

import { introspectToken, OAuthServiceError } from "./oauthClient.js";

export const ROLES = {
  AGENT:   "AGENT",    // Consultas de solo lectura
  SUPPORT: "SUPPORT",  // Creación de tickets de soporte
  FINANCE: "FINANCE",  // Solicitud de reembolsos
};

// Mapeo scope OAuth → rol de aplicación. El Authorization Server solo conoce scopes;
// la traducción a roles de negocio vive en el resource server (este MCP).
const SCOPE_TO_ROLE = {
  "agent:read":     ROLES.AGENT,
  "support:write":  ROLES.SUPPORT,
  "finance:refund": ROLES.FINANCE,
};

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
    this.code = "UNAUTHORIZED";
  }
}

/**
 * Resuelve el contexto del llamante validando el token contra el Authorization Server
 * externo (introspección OAuth 2.0). Async porque implica una llamada de red real.
 */
export async function resolveCallerContext(token) {
  if (!token || typeof token !== "string") {
    throw new AuthError("Token no proporcionado o inválido");
  }

  let introspection;
  try {
    introspection = await introspectToken(token);
  } catch (err) {
    if (err instanceof OAuthServiceError) {
      // Fail-closed: si el servicio de autorización no responde, se deniega el acceso.
      throw new AuthError(`Servicio de autorización no disponible. Acceso denegado (fail-closed): ${err.message}`);
    }
    throw err;
  }

  if (!introspection?.active) {
    throw new AuthError("Token inválido, expirado o revocado");
  }

  const roles = (introspection.scope ?? "")
    .split(" ")
    .filter(Boolean)
    .map((scope) => SCOPE_TO_ROLE[scope])
    .filter(Boolean);

  return { userId: introspection.sub, tenantId: introspection.tenant_id, roles };
}

/** Lanza AuthError si el llamante no tiene el rol requerido. */
export function assertHasRole(callerCtx, role) {
  if (!callerCtx?.roles?.includes(role)) {
    throw new AuthError(`Permiso insuficiente. Rol requerido: '${role}'`);
  }
}

/** Lanza AuthError si el recurso no pertenece al tenant del llamante. */
export function assertTenantAccess(callerCtx, resourceTenantId) {
  if (callerCtx.tenantId !== resourceTenantId) {
    throw new AuthError(
      `Acceso denegado. El recurso pertenece a un tenant diferente.`
    );
  }
}
