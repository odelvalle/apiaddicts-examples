/**
 * lib/data.js
 * Estado en memoria que simula la base de datos del sistema de soporte.
 * En producción, esto se sustituiría por llamadas a servicios reales.
 */

// Clientes por tenant
export const customers = new Map([
  ["cust-001", { id: "cust-001", tenantId: "tenant-A", name: "Ana García",  email: "ana.garcia@example.com",  phone: "+34 600 111 001", tier: "premium"  }],
  ["cust-002", { id: "cust-002", tenantId: "tenant-A", name: "Luis Martín", email: "luis.martin@example.com", phone: "+34 600 111 002", tier: "standard" }],
  ["cust-003", { id: "cust-003", tenantId: "tenant-B", name: "Sara López",  email: "sara.lopez@example.com",  phone: "+34 600 111 003", tier: "premium"  }],
]);

// Pedidos por tenant
export const orders = new Map([
  ["ord-001", { id: "ord-001", customerId: "cust-001", tenantId: "tenant-A", amount: 120.50, status: "delivered", date: "2025-06-01" }],
  ["ord-002", { id: "ord-002", customerId: "cust-001", tenantId: "tenant-A", amount:  45.00, status: "shipped",   date: "2025-06-15" }],
  ["ord-003", { id: "ord-003", customerId: "cust-003", tenantId: "tenant-B", amount: 200.00, status: "delivered", date: "2025-06-10" }],
]);

// Estado mutable generado durante las demostraciones
let _ticketCounter = 1000;
export const tickets   = new Map();
export const approvals = new Map();
export const emailLog  = [];

export function nextTicketId() {
  return `TKT-${++_ticketCounter}`;
}

// Templates de email permitidos (allowlist).
// No se acepta contenido libre para evitar riesgos reputacionales o de phishing.
export const EMAIL_TEMPLATES = {
  "refund-approved":      "Estimado/a {customerName}, su reembolso de {amount}€ ha sido aprobado.",
  "ticket-created":       "Estimado/a {customerName}, hemos registrado su incidencia con referencia {ticketId}.",
  "order-status-update":  "Estimado/a {customerName}, su pedido {orderId} tiene el estado: {status}.",
};
