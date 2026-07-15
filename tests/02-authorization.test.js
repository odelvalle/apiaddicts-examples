/**
 * tests/02-authorization.test.js
 * Pruebas de autorización — tenant isolation y control de roles.
 *
 * Demuestran que el sistema rechaza correctamente:
 *   - Acceso a recursos de un tenant diferente
 *   - Llamadas sin el rol requerido
 *   - Tokens inválidos o no proporcionados
 *
 * MENSAJE CLAVE: El control de acceso vive server-side.
 * El modelo NO puede elevar privilegios ni acceder a datos de otro tenant,
 * independientemente de lo que escriba en los parámetros.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveCallerContext, AuthError } from "../lib/auth.js";
import {
  getCustomerProfile,
  getCustomerOrders,
  createSupportTicket,
  calculateRefundEligibility,
  requestRefundApproval,
  sendCustomerEmail,
} from "../lib/tools.js";

const agentA = resolveCallerContext("token-agent-A");   // tenant-A, solo AGENT
const agentB = resolveCallerContext("token-agent-B");   // tenant-B, solo AGENT

// ─────────────────────────────────────────────────────────────────────────────
describe("Tenant isolation", () => {
  it("agente de tenant-A no puede ver perfil de cliente de tenant-B", async () => {
    await assert.rejects(
      () => getCustomerProfile(agentA, { customerId: "cust-003" }), // cust-003 es de tenant-B
      (err) => {
        assert.ok(err instanceof AuthError, "Debe lanzar AuthError");
        return true;
      }
    );
  });

  it("agente de tenant-B no puede ver pedidos de cliente de tenant-A", async () => {
    await assert.rejects(
      () => getCustomerOrders(agentB, { customerId: "cust-001" }), // cust-001 es de tenant-A
      AuthError
    );
  });

  it("agente de tenant-A no puede consultar elegibilidad de pedido de tenant-B", async () => {
    await assert.rejects(
      () => calculateRefundEligibility(agentA, { orderId: "ord-003" }), // ord-003 es de tenant-B
      AuthError
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Control de roles", () => {
  it("rol AGENT no puede crear tickets — requiere SUPPORT", async () => {
    await assert.rejects(
      () => createSupportTicket(agentA, {
        customerId:  "cust-001",
        category:    "billing",
        description: "Intento de crear ticket sin permiso suficiente.",
      }),
      (err) => {
        assert.ok(err instanceof AuthError);
        assert.match(err.message, /SUPPORT/, "El mensaje debe indicar el rol requerido");
        return true;
      }
    );
  });

  it("rol AGENT no puede solicitar reembolsos — requiere FINANCE", async () => {
    await assert.rejects(
      () => requestRefundApproval(agentA, {
        orderId: "ord-001",
        amount:  10,
        reason:  "Intento de solicitar reembolso sin permiso de finanzas.",
      }),
      (err) => {
        assert.ok(err instanceof AuthError);
        assert.match(err.message, /FINANCE/, "El mensaje debe indicar el rol requerido");
        return true;
      }
    );
  });

  it("rol AGENT no puede enviar emails — requiere SUPPORT", async () => {
    await assert.rejects(
      () => sendCustomerEmail(agentA, {
        customerId: "cust-001",
        templateId: "ticket-created",
        params:     { customerName: "Test", ticketId: "TKT-000" },
      }),
      AuthError
    );
  });

  it("rol SUPPORT no puede solicitar reembolsos — requiere FINANCE", async () => {
    const supportCtx = resolveCallerContext("token-support-A");
    await assert.rejects(
      () => requestRefundApproval(supportCtx, {
        orderId: "ord-001",
        amount:  20,
        reason:  "Intento de solicitar reembolso desde soporte sin rol de finanzas.",
      }),
      AuthError
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Tokens inválidos", () => {
  it("token inexistente lanza AuthError", () => {
    assert.throws(
      () => resolveCallerContext("token-inventado-que-no-existe"),
      AuthError
    );
  });

  it("token vacío lanza AuthError", () => {
    assert.throws(
      () => resolveCallerContext(""),
      AuthError
    );
  });

  it("token nulo lanza AuthError", () => {
    assert.throws(
      () => resolveCallerContext(null),
      AuthError
    );
  });

  it("token undefined lanza AuthError", () => {
    assert.throws(
      () => resolveCallerContext(undefined),
      AuthError
    );
  });
});
