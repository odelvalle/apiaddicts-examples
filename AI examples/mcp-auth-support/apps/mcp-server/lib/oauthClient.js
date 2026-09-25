/**
 * lib/oauthClient.js
 * Cliente HTTP hacia el Authorization Server externo — introspección de tokens OAuth 2.0.
 *
 * PATRÓN CLAVE: fail-closed. Si el servicio de autorización no responde a tiempo
 * o la conexión falla, se deniega el acceso. Nunca se asume "válido por defecto".
 */

const DEFAULT_BASE_URL   = "http://localhost:4001";
const DEFAULT_TIMEOUT_MS = 2000;

function getBaseUrl() {
  return process.env.AUTH_SERVER_URL || DEFAULT_BASE_URL;
}

// Leído en cada llamada (no cacheado) para permitir ajustarlo en tests.
function getTimeoutMs() {
  return Number(process.env.AUTH_SERVER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
}

export class OAuthServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = "OAuthServiceError";
  }
}

/**
 * Llama al endpoint de introspección (RFC 7662) del Authorization Server externo.
 * Devuelve { active: false } o { active: true, sub, tenant_id, scope }.
 * Lanza OAuthServiceError si el servicio no responde o se agota el timeout.
 */
export async function introspectToken(token) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), getTimeoutMs());

  try {
    const response = await fetch(`${getBaseUrl()}/oauth/introspect`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ token }),
      signal:  controller.signal,
    });

    if (!response.ok) {
      throw new OAuthServiceError(`Authorization Server respondió con estado ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new OAuthServiceError("Timeout esperando la respuesta del Authorization Server");
    }
    if (err instanceof OAuthServiceError) throw err;
    throw new OAuthServiceError(`No se pudo contactar con el Authorization Server: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }
}
