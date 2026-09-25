/**
 * lib/tools.js
 * Lógica de negocio de cada tool, separada del protocolo MCP.
 *
 * Separar la lógica del transporte permite testarla sin levantar el servidor.
 * Cada función aplica el mismo patrón de seguridad:
 *   1. Validar schema estricto de entrada (Zod .strict() rechaza campos extra)
 *   2. Verificar rol del llamante
 *   3. Verificar tenant isolation
 *   4. Aplicar reglas de negocio con límites server-side
 *   5. Registrar en audit log con correlationId
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ROLES, AuthError, assertHasRole, assertTenantAccess } from "./auth.js";
import { createCorrelationId, auditLog } from "./audit.js";
import {
  customers, orders, tickets, nextTicketId,
  approvals, emailLog, EMAIL_TEMPLATES,
} from "./data.js";

// ── Límites de negocio (validados server-side, nunca delegados al modelo) ─────
const MAX_REFUND_AMOUNT   = 500;  // €
const MAX_ORDERS_PER_CALL = 20;

// Formato esperado de IDs de cliente y pedido
const CUSTOMER_ID_RE = /^cust-[a-zA-Z0-9-]+$/;
const ORDER_ID_RE    = /^ord-[a-zA-Z0-9-]+$/;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Enmascara email: ana.garcia@example.com → a***@example.com
function maskEmail(email) {
  const [local, domain] = email.split("@");
  return `${local[0]}***@${domain}`;
}

// ── getCustomerProfile ────────────────────────────────────────────────────────
// Riesgo: PII — solo se devuelven campos necesarios, email enmascarado en respuesta.
const GetCustomerProfileSchema = z.object({
  customerId: z.string().regex(CUSTOMER_ID_RE, "customerId inválido"),
}).strict(); // .strict() rechaza cualquier campo adicional no declarado

export async function getCustomerProfile(callerCtx, rawParams) {
  const correlationId = createCorrelationId();
  try {
    const { customerId } = GetCustomerProfileSchema.parse(rawParams);

    assertHasRole(callerCtx, ROLES.AGENT);

    const customer = customers.get(customerId);
    if (!customer) throw new Error(`Cliente '${customerId}' no encontrado`);

    // Tenant isolation: el recurso debe pertenecer al mismo tenant que el llamante
    assertTenantAccess(callerCtx, customer.tenantId);

    // Principio de mínima exposición: solo se devuelven los campos necesarios
    const result = {
      id:    customer.id,
      name:  customer.name,
      tier:  customer.tier,
      email: maskEmail(customer.email), // PII parcialmente enmascarada
      // phone y otros campos sensibles no se exponen
    };

    auditLog({ correlationId, tool: "getCustomerProfile", callerCtx, params: rawParams, status: "ok" });
    return result;
  } catch (err) {
    auditLog({
      correlationId, tool: "getCustomerProfile", callerCtx, params: rawParams,
      status: err instanceof AuthError ? "rejected" : "error", error: err,
    });
    throw err;
  }
}

// ── getCustomerOrders ─────────────────────────────────────────────────────────
const GetCustomerOrdersSchema = z.object({
  customerId: z.string().regex(CUSTOMER_ID_RE, "customerId inválido"),
  limit:      z.number().int().min(1).max(MAX_ORDERS_PER_CALL).default(10),
}).strict();

export async function getCustomerOrders(callerCtx, rawParams) {
  const correlationId = createCorrelationId();
  try {
    const { customerId, limit } = GetCustomerOrdersSchema.parse(rawParams);

    assertHasRole(callerCtx, ROLES.AGENT);

    const customer = customers.get(customerId);
    if (!customer) throw new Error(`Cliente '${customerId}' no encontrado`);

    assertTenantAccess(callerCtx, customer.tenantId);

    const result = [...orders.values()]
      .filter(o => o.customerId === customerId)
      .slice(0, limit)
      .map(({ id, amount, status, date }) => ({ id, amount, status, date }));

    auditLog({ correlationId, tool: "getCustomerOrders", callerCtx, params: rawParams, status: "ok" });
    return { orders: result, total: result.length };
  } catch (err) {
    auditLog({
      correlationId, tool: "getCustomerOrders", callerCtx, params: rawParams,
      status: err instanceof AuthError ? "rejected" : "error", error: err,
    });
    throw err;
  }
}

// ── createSupportTicket ───────────────────────────────────────────────────────
// Riesgo medio: escritura auditada con categoría enum — evita campos genéricos.
const TICKET_CATEGORIES = ["billing", "shipping", "product", "account", "other"];

const CreateSupportTicketSchema = z.object({
  customerId:  z.string().regex(CUSTOMER_ID_RE, "customerId inválido"),
  category:    z.enum(TICKET_CATEGORIES),
  description: z.string().min(10).max(500),
}).strict();

export async function createSupportTicket(callerCtx, rawParams) {
  const correlationId = createCorrelationId();
  try {
    const { customerId, category, description } = CreateSupportTicketSchema.parse(rawParams);

    assertHasRole(callerCtx, ROLES.SUPPORT);

    const customer = customers.get(customerId);
    if (!customer) throw new Error(`Cliente '${customerId}' no encontrado`);

    assertTenantAccess(callerCtx, customer.tenantId);

    const ticketId = nextTicketId();
    tickets.set(ticketId, {
      id:            ticketId,
      customerId,
      tenantId:      callerCtx.tenantId,
      category,
      description,
      status:        "open",
      createdBy:     callerCtx.userId,
      createdAt:     new Date().toISOString(),
      correlationId, // trazabilidad: enlaza con el audit log
    });

    auditLog({ correlationId, tool: "createSupportTicket", callerCtx, params: rawParams, status: "ok" });
    return { ticketId, status: "open" };
  } catch (err) {
    auditLog({
      correlationId, tool: "createSupportTicket", callerCtx, params: rawParams,
      status: err instanceof AuthError ? "rejected" : "error", error: err,
    });
    throw err;
  }
}

// ── calculateRefundEligibility ────────────────────────────────────────────────
// PATRÓN: separar consulta de acción.
// Esta tool es read-only: informa si un reembolso es posible, no lo ejecuta.
const CalcRefundSchema = z.object({
  orderId: z.string().regex(ORDER_ID_RE, "orderId inválido"),
}).strict();

export async function calculateRefundEligibility(callerCtx, rawParams) {
  const correlationId = createCorrelationId();
  try {
    const { orderId } = CalcRefundSchema.parse(rawParams);

    assertHasRole(callerCtx, ROLES.AGENT);

    const order = orders.get(orderId);
    if (!order) throw new Error(`Pedido '${orderId}' no encontrado`);

    assertTenantAccess(callerCtx, order.tenantId);

    const eligible    = order.status === "delivered";
    const maxRefund   = eligible ? Math.min(order.amount, MAX_REFUND_AMOUNT) : 0;

    auditLog({ correlationId, tool: "calculateRefundEligibility", callerCtx, params: rawParams, status: "ok" });
    return {
      orderId,
      eligible,
      reason:           eligible
        ? "Pedido entregado, apto para reembolso"
        : `Estado '${order.status}' no apto para reembolso`,
      maxRefundAmount:  maxRefund,
    };
  } catch (err) {
    auditLog({
      correlationId, tool: "calculateRefundEligibility", callerCtx, params: rawParams,
      status: err instanceof AuthError ? "rejected" : "error", error: err,
    });
    throw err;
  }
}

// ── requestRefundApproval ─────────────────────────────────────────────────────
// PATRÓN: human-in-the-loop.
// Esta tool inicia el flujo de aprobación pero NO ejecuta el reembolso.
// La ejecución real solo ocurre cuando un humano aprueba fuera del agente.
// No existe una tool 'issueRefund' autónoma — eso es intencional.
const RequestRefundSchema = z.object({
  orderId: z.string().regex(ORDER_ID_RE, "orderId inválido"),
  amount:  z.number().positive().max(MAX_REFUND_AMOUNT),
  reason:  z.string().min(10).max(250),
}).strict();

export async function requestRefundApproval(callerCtx, rawParams) {
  const correlationId = createCorrelationId();
  try {
    const { orderId, amount, reason } = RequestRefundSchema.parse(rawParams);

    // Los reembolsos requieren rol FINANCE — no basta con AGENT o SUPPORT
    assertHasRole(callerCtx, ROLES.FINANCE);

    const order = orders.get(orderId);
    if (!order) throw new Error(`Pedido '${orderId}' no encontrado`);

    assertTenantAccess(callerCtx, order.tenantId);

    if (order.status !== "delivered") {
      throw new Error(`No se puede solicitar reembolso para pedido con estado '${order.status}'`);
    }
    if (amount > order.amount) {
      throw new Error(`El importe (${amount}€) supera el valor del pedido (${order.amount}€)`);
    }

    const approvalId = randomUUID();
    approvals.set(approvalId, {
      approvalId,
      orderId,
      amount,
      reason,
      requestedBy: callerCtx.userId,
      tenantId:    callerCtx.tenantId,
      status:      "pending",
      createdAt:   new Date().toISOString(),
      correlationId,
    });

    auditLog({ correlationId, tool: "requestRefundApproval", callerCtx, params: rawParams, status: "ok" });
    return {
      approvalId,
      status:  "pending",
      message: "Solicitud creada. Pendiente de aprobación humana antes de ejecutar el reembolso.",
    };
  } catch (err) {
    auditLog({
      correlationId, tool: "requestRefundApproval", callerCtx, params: rawParams,
      status: err instanceof AuthError ? "rejected" : "error", error: err,
    });
    throw err;
  }
}

// ── sendCustomerEmail ─────────────────────────────────────────────────────────
// PATRÓN: allowlist de templates — no se acepta contenido libre.
// Evita que el agente genere cuerpos de email arbitrarios (phishing, desinformación).
const SendEmailSchema = z.object({
  customerId:  z.string().regex(CUSTOMER_ID_RE, "customerId inválido"),
  templateId:  z.string().min(1).max(64),
  params:      z.record(z.string().max(200)),
}).strict();

export async function sendCustomerEmail(callerCtx, rawParams) {
  const correlationId = createCorrelationId();
  try {
    const { customerId, templateId, params: templateParams } = SendEmailSchema.parse(rawParams);

    assertHasRole(callerCtx, ROLES.SUPPORT);

    const customer = customers.get(customerId);
    if (!customer) throw new Error(`Cliente '${customerId}' no encontrado`);

    assertTenantAccess(callerCtx, customer.tenantId);

    // Validar que el template existe en la allowlist (validación de negocio)
    const template = EMAIL_TEMPLATES[templateId];
    if (!template) {
      const allowed = Object.keys(EMAIL_TEMPLATES).join(", ");
      throw new Error(`Template '${templateId}' no permitido. Templates válidos: ${allowed}`);
    }

    // Sustituir variables del template — el contenido base siempre es el template registrado
    const body = Object.entries(templateParams).reduce(
      (text, [k, v]) => text.replaceAll(`{${k}}`, v),
      template
    );

    emailLog.push({
      to:         customer.email, // no se expone en la respuesta al agente
      templateId,
      body,
      sentBy:     callerCtx.userId,
      tenantId:   callerCtx.tenantId,
      sentAt:     new Date().toISOString(),
      correlationId,
    });

    auditLog({ correlationId, tool: "sendCustomerEmail", callerCtx, params: rawParams, status: "ok" });
    return { sent: true, templateId, correlationId };
  } catch (err) {
    auditLog({
      correlationId, tool: "sendCustomerEmail", callerCtx, params: rawParams,
      status: err instanceof AuthError ? "rejected" : "error", error: err,
    });
    throw err;
  }
}
