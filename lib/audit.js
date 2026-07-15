/**
 * lib/audit.js
 * Observabilidad: registro de auditoría para cada llamada a una tool.
 *
 * PATRÓN CLAVE: Lo que no se puede reconstruir no se puede gobernar.
 * Cada evento incluye: quién llamó, desde qué tenant, qué tool,
 * qué parámetros (con PII enmascarada), qué decisión y qué resultado.
 *
 * IMPORTANTE: Nunca logar datos sensibles sin enmascarar.
 * Los logs con PII, tokens o secretos pueden convertirse en otro vector de riesgo.
 */

import { randomUUID } from "node:crypto";

export function createCorrelationId() {
  return randomUUID();
}

// Nombres de campo cuyo valor se enmascara en los logs
const SENSITIVE_KEYS = new Set([
  "email", "phone", "token", "callerToken", "password", "secret", "apiKey",
]);

export function maskSensitiveData(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = SENSITIVE_KEYS.has(k.toLowerCase())
      ? "[ENMASCARADO]"
      : typeof v === "object" && v !== null
        ? maskSensitiveData(v)
        : v;
  }
  return result;
}

/**
 * Registra un evento de auditoría en stderr.
 * stdout se reserva para el canal MCP (protocolo JSON-RPC).
 */
export function auditLog({ correlationId, tool, callerCtx, params, status, error }) {
  const entry = {
    timestamp:    new Date().toISOString(),
    correlationId,
    tool,
    userId:       callerCtx?.userId   ?? "anonymous",
    tenantId:     callerCtx?.tenantId ?? "unknown",
    params:       maskSensitiveData(params),
    status,       // "ok" | "error" | "rejected"
    errorMessage: error?.message ?? null,
  };
  // En producción: enviar a sistema centralizado (OpenTelemetry, ELK, Splunk…)
  process.stderr.write(JSON.stringify({ audit: entry }) + "\n");
  return entry;
}
