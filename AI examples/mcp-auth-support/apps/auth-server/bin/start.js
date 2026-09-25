/**
 * bin/start.js
 * Punto de entrada standalone del Authorization Server simulado.
 *
 * Se ejecuta como PROCESO INDEPENDIENTE del servidor MCP (paquete separado
 * en el monorepo):
 *   pnpm --filter @mcp-soporte-cliente/auth-server start
 *
 * El servidor MCP (packages/mcp-server/lib/oauthClient.js) lo consulta por
 * HTTP en process.env.AUTH_SERVER_URL (por defecto http://localhost:4001).
 */

import { startAuthServer } from "../lib/authServer.js";

const port = Number(process.env.AUTH_SERVER_PORT) || 4001;

const { url } = await startAuthServer({ port });
process.stderr.write(`Authorization Server simulado escuchando en ${url}\n`);
process.stderr.write(`Endpoint de introspección: POST ${url}/oauth/introspect\n`);

