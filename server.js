/**
 * server.js
 * Servidor MCP para el sistema de soporte al cliente.
 *
 * Expone 6 tools al agente, cada una con controles de seguridad:
 *   - getCustomerProfile       → rol AGENT, tenant isolation, PII masking
 *   - getCustomerOrders        → rol AGENT, tenant isolation, límite de resultados
 *   - createSupportTicket      → rol SUPPORT, categorías enum, longitud controlada
 *   - calculateRefundEligibility → rol AGENT, solo lectura
 *   - requestRefundApproval    → rol FINANCE, human-in-the-loop, límite de importe
 *   - sendCustomerEmail        → rol SUPPORT, templates allowlist, sin contenido libre
 *
 * Transporte: stdio (compatible con Claude Desktop y MCP Inspector).
 *
 * NOTA SOBRE AUTENTICACIÓN:
 * En este demo, el token del llamante se pasa como parámetro de cada tool
 * para facilitar las demostraciones en MCP Inspector.
 * En producción con transporte HTTP, el token llegaría en el header
 * Authorization y sería validado antes de que el agente vea la llamada.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { resolveCallerContext } from "./lib/auth.js";
import {
  getCustomerProfile,
  getCustomerOrders,
  createSupportTicket,
  calculateRefundEligibility,
  requestRefundApproval,
  sendCustomerEmail,
} from "./lib/tools.js";

const server = new McpServer({
  name:    "soporte-cliente",
  version: "1.0.0",
});

// ── Helper: convierte cualquier error en respuesta MCP de error ───────────────
function toMcpError(err) {
  return {
    content: [{ type: /** @type {"text"} */ ("text"), text: JSON.stringify({ error: err.name ?? "Error", message: err.message }) }],
    isError: true,
  };
}

// ── Helper: extrae callerToken y resuelve el contexto antes de llamar a la tool
function withAuth(fn) {
  return async ({ callerToken, ...params }) => {
    try {
      const callerCtx = resolveCallerContext(callerToken);
      const result    = await fn(callerCtx, params);
      return { content: [{ type: /** @type {"text"} */ ("text"), text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return toMcpError(err);
    }
  };
}

// ── Registro de tools ─────────────────────────────────────────────────────────

server.registerTool(
  "getCustomerProfile",
  {
    description: "Obtiene el perfil básico de un cliente. " +
      "Devuelve id, nombre, tier y email parcialmente enmascarado. " +
      "Requiere rol AGENT y que el cliente pertenezca al mismo tenant.",
    inputSchema: {
      callerToken: z.string().describe("Token de autenticación (p.ej. token-agent-A)"),
      customerId:  z.string().describe("ID del cliente en formato cust-XXX"),
    },
  },
  withAuth(getCustomerProfile)
);

server.registerTool(
  "getCustomerOrders",
  {
    description: "Lista los pedidos de un cliente. Máximo 20 por llamada. " +
      "Requiere rol AGENT y que el cliente pertenezca al mismo tenant.",
    inputSchema: {
      callerToken: z.string().describe("Token de autenticación"),
      customerId:  z.string().describe("ID del cliente"),
      limit:       z.number().int().min(1).max(20).optional()
                     .describe("Número máximo de pedidos a devolver (1-20, por defecto 10)"),
    },
  },
  withAuth(getCustomerOrders)
);

server.registerTool(
  "createSupportTicket",
  {
    description: "Crea un ticket de soporte para un cliente. " +
      "La categoría debe ser una de: billing, shipping, product, account, other. " +
      "Requiere rol SUPPORT.",
    inputSchema: {
      callerToken:  z.string().describe("Token de autenticación"),
      customerId:   z.string().describe("ID del cliente"),
      category:     z.enum(["billing", "shipping", "product", "account", "other"])
                      .describe("Categoría del ticket"),
      description:  z.string().min(10).max(500)
                      .describe("Descripción del problema (10-500 caracteres)"),
    },
  },
  withAuth(createSupportTicket)
);

server.registerTool(
  "calculateRefundEligibility",
  {
    description: "Consulta si un pedido es elegible para reembolso y el importe máximo permitido. " +
      "Solo lectura — no ejecuta ninguna acción. " +
      "Requiere rol AGENT.",
    inputSchema: {
      callerToken: z.string().describe("Token de autenticación"),
      orderId:     z.string().describe("ID del pedido en formato ord-XXX"),
    },
  },
  withAuth(calculateRefundEligibility)
);

server.registerTool(
  "requestRefundApproval",
  {
    description: "Solicita la aprobación de un reembolso. " +
      "IMPORTANTE: esta tool NO ejecuta el reembolso. Genera una solicitud pendiente " +
      "que debe ser aprobada por un humano antes de procesarse. " +
      "Importe máximo: 500 €. Requiere rol FINANCE.",
    inputSchema: {
      callerToken: z.string().describe("Token de autenticación"),
      orderId:     z.string().describe("ID del pedido"),
      amount:      z.number().positive().max(500)
                     .describe("Importe a reembolsar en euros (máximo 500 €)"),
      reason:      z.string().min(10).max(250)
                     .describe("Motivo del reembolso (10-250 caracteres)"),
    },
  },
  withAuth(requestRefundApproval)
);

server.registerTool(
  "sendCustomerEmail",
  {
    description: "Envía un email a un cliente usando una plantilla autorizada. " +
      "No se acepta contenido libre — solo templates registrados: " +
      "refund-approved, ticket-created, order-status-update. " +
      "Requiere rol SUPPORT.",
    inputSchema: {
      callerToken: z.string().describe("Token de autenticación"),
      customerId:  z.string().describe("ID del cliente destinatario"),
      templateId:  z.enum(["refund-approved", "ticket-created", "order-status-update"])
                     .describe("Plantilla de email a usar"),
      params:      z.record(z.string().max(200))
                     .describe("Variables a sustituir en la plantilla"),
    },
  },
  withAuth(sendCustomerEmail)
);

// ── Arranque ──────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("MCP Server 'soporte-cliente' v1.0.0 arrancado\n");
