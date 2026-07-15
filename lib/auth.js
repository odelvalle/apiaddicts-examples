/**
 * lib/auth.js
 * Autorización y resolución de contexto de llamante.
 *
 * PATRÓN CLAVE: El control de acceso vive en el servidor, no en el modelo.
 * El agente nunca puede escalar permisos escribiendo texto en los parámetros;
 * lo único que cuenta es el token validado server-side.
 *
 * En producción: token = JWT firmado, validado contra JWKS del IdP.
 * En este demo:  tokens simulados en un mapa en memoria.
 */

export const ROLES = {
  AGENT:   "AGENT",    // Consultas de solo lectura
  SUPPORT: "SUPPORT",  // Creación de tickets de soporte
  FINANCE: "FINANCE",  // Solicitud de reembolsos
};

// Identidades simuladas — cada token representa un usuario autenticado
// con un tenant y un conjunto de roles asignado por el sistema de IdM.
const IDENTITIES = {
  "token-agent-A":   { userId: "user-101", tenantId: "tenant-A", roles: [ROLES.AGENT] },
  "token-support-A": { userId: "user-102", tenantId: "tenant-A", roles: [ROLES.AGENT, ROLES.SUPPORT] },
  "token-finance-A": { userId: "user-103", tenantId: "tenant-A", roles: [ROLES.AGENT, ROLES.FINANCE] },
  "token-agent-B":   { userId: "user-201", tenantId: "tenant-B", roles: [ROLES.AGENT] },
};

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
    this.code = "UNAUTHORIZED";
  }
}

/** Resuelve el contexto del llamante a partir de un token. */
export function resolveCallerContext(token) {
  if (!token || typeof token !== "string") {
    throw new AuthError("Token no proporcionado o inválido");
  }
  const ctx = IDENTITIES[token];
  if (!ctx) throw new AuthError("Token inválido o expirado");
  return { ...ctx }; // copia defensiva — nunca se devuelve la referencia original
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
