/**
 * tests/01-functional.test.js
 * Pruebas funcionales — happy path para cada tool.
 *
 * Verifican que las tools funcionan correctamente con parámetros válidos
 * y contextos con los permisos adecuados.
 *
 * Las funciones se prueban directamente (sin levantar el servidor MCP),
 * lo que permite pruebas rápidas y aisladas de la lógica de negocio.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { resolveCallerContext } from "../lib/auth.js";
import { startApiManager, login } from "@mcp-soporte-cliente/api-manager";
import {
  getCustomerProfile,
  getCustomerOrders,
  createSupportTicket,
  calculateRefundEligibility,
  requestRefundApproval,
  sendCustomerEmail,
} from "../lib/tools.js";
import { tickets, approvals, emailLog } from "../lib/data.js";

// Contextos de prueba — se obtienen vía login OAuth (Authorization Code + PKCE)
// y se resuelven contra el API Manager simulado (introspección)
let apiManager;
let agentCtx, supportCtx, financeCtx;

before(async () => {
  apiManager = await startApiManager();
  process.env.API_MANAGER_URL = apiManager.url;

  const agentLogin   = await login({ baseUrl: apiManager.url, username: "agent.a",   password: "demo1234" });
  const supportLogin = await login({ baseUrl: apiManager.url, username: "support.a", password: "demo1234" });
  const financeLogin = await login({ baseUrl: apiManager.url, username: "finance.a", password: "demo1234" });

  agentCtx   = await resolveCallerContext(agentLogin.access_token);
  supportCtx = await resolveCallerContext(supportLogin.access_token);
  financeCtx = await resolveCallerContext(financeLogin.access_token);
});

after(async () => {
  await apiManager.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("getCustomerProfile", () => {
  it("devuelve perfil con email parcialmente enmascarado", async () => {
    const result = await getCustomerProfile(agentCtx, { customerId: "cust-001" });

    assert.equal(result.id, "cust-001");
    assert.equal(result.name, "Ana García");
    assert.equal(result.tier, "premium");
    // El email debe estar enmascarado: solo la primera letra del local-part
    assert.match(result.email, /^a\*\*\*@/, "Email debe estar enmascarado");
    // Campos sensibles no deben aparecer en la respuesta
    assert.ok(!("phone" in result), "El teléfono no debe exponerse");
  });

  it("lanza error si el cliente no existe", async () => {
    await assert.rejects(
      () => getCustomerProfile(agentCtx, { customerId: "cust-999" }),
      /no encontrado/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("getCustomerOrders", () => {
  it("devuelve pedidos del cliente con limit aplicado", async () => {
    const result = await getCustomerOrders(agentCtx, { customerId: "cust-001", limit: 1 });

    assert.equal(result.orders.length, 1);
    assert.ok(typeof result.orders[0].amount === "number");
    assert.ok(typeof result.orders[0].status === "string");
  });

  it("aplica limit por defecto (10) si no se especifica", async () => {
    const result = await getCustomerOrders(agentCtx, { customerId: "cust-001" });
    assert.ok(result.orders.length <= 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("createSupportTicket", () => {
  it("crea ticket con ID, estado y correlationId", async () => {
    const result = await createSupportTicket(supportCtx, {
      customerId:  "cust-001",
      category:    "billing",
      description: "El cargo de junio no corresponde al servicio contratado.",
    });

    assert.ok(result.ticketId.startsWith("TKT-"), "Debe tener prefijo TKT-");
    assert.equal(result.status, "open");

    // El ticket debe persistir en el estado interno
    assert.ok(tickets.has(result.ticketId));
    const stored = tickets.get(result.ticketId);
    assert.ok(stored.correlationId, "Debe tener correlationId para trazabilidad");
    assert.equal(stored.createdBy, supportCtx.userId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("calculateRefundEligibility", () => {
  it("devuelve elegible=true para pedido entregado con importe máximo", async () => {
    const result = await calculateRefundEligibility(agentCtx, { orderId: "ord-001" });

    assert.equal(result.eligible, true);
    assert.ok(result.maxRefundAmount > 0);
    assert.ok(result.maxRefundAmount <= 500, "Límite server-side de 500€");
  });

  it("devuelve elegible=false para pedido en tránsito", async () => {
    const result = await calculateRefundEligibility(agentCtx, { orderId: "ord-002" });

    assert.equal(result.eligible, false);
    assert.equal(result.maxRefundAmount, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("requestRefundApproval", () => {
  it("crea solicitud con estado 'pending' — no ejecuta el reembolso", async () => {
    const result = await requestRefundApproval(financeCtx, {
      orderId: "ord-001",
      amount:  50,
      reason:  "El cliente recibió un producto defectuoso según ticket de soporte.",
    });

    assert.equal(result.status, "pending");
    assert.ok(result.approvalId, "Debe devolver un approvalId");

    // La aprobación queda registrada internamente como pendiente
    const approval = approvals.get(result.approvalId);
    assert.equal(approval.status, "pending");
    assert.equal(approval.amount, 50);
    assert.equal(approval.requestedBy, financeCtx.userId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("sendCustomerEmail", () => {
  it("envía email con template válido y registra la acción", async () => {
    const logSizeBefore = emailLog.length;

    const result = await sendCustomerEmail(supportCtx, {
      customerId: "cust-001",
      templateId: "ticket-created",
      params:     { customerName: "Ana García", ticketId: "TKT-1001" },
    });

    assert.equal(result.sent, true);
    assert.equal(result.templateId, "ticket-created");
    assert.ok(result.correlationId, "Debe devolver correlationId");

    // El email queda registrado en el log de auditoría
    assert.equal(emailLog.length, logSizeBefore + 1);
    assert.equal(emailLog.at(-1).templateId, "ticket-created");
    // El email real del destinatario no se expone en la respuesta al agente
    assert.ok(!("to" in result));
  });
});
