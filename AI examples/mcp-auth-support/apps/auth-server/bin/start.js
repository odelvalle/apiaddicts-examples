/**
 * bin/start.js
 * Punto de entrada standalone del API Manager / Authorization Server simulado.
 *
 * Se ejecuta como PROCESO INDEPENDIENTE del servidor MCP (paquete separado
 * en el monorepo):
 *   pnpm --filter @mcp-soporte-cliente/api-manager start
 *
 * El servidor MCP (packages/mcp-server/lib/oauthClient.js) lo consulta por
 * HTTP en process.env.API_MANAGER_URL (por defecto http://localhost:4001).
 */

import { startApiManager } from "../lib/apiManager.js";

const port = Number(process.env.API_MANAGER_PORT) || 4001;

const { url } = await startApiManager({ port });
process.stderr.write(`API Manager (Authorization Server simulado) escuchando en ${url}\n`);
process.stderr.write(`Endpoint de introspección: POST ${url}/oauth/introspect\n`);

