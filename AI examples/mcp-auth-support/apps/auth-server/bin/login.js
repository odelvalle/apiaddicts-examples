/**
 * bin/login.js
 * CLI de demo: ejecuta el login OAuth (Authorization Code + PKCE) contra un
 * API Manager ya arrancado y muestra el access_token resultante para poder
 * copiarlo como `callerToken` en MCP Inspector.
 *
 * Uso:
 *   pnpm --filter @mcp-soporte-cliente/api-manager login -- --username support.a --password demo1234
 */

import { parseArgs } from "node:util";
import { login } from "../index.js";

const { values } = parseArgs({
  options: {
    username: { type: "string", short: "u" },
    password: { type: "string", short: "p" },
    scope:    { type: "string", short: "s" },
    url:      { type: "string" },
  },
});

if (!values.username || !values.password) {
  process.stderr.write("Uso: login --username <user> --password <pass> [--scope \"agent:read support:write\"]\n");
  process.exit(1);
}

const baseUrl = values.url || process.env.API_MANAGER_URL || "http://localhost:4001";

try {
  const result = await login({
    baseUrl,
    username: values.username,
    password: values.password,
    scope:    values.scope,
  });
  process.stdout.write(`\naccess_token (usar como callerToken en MCP Inspector):\n${result.access_token}\n\n`);
  process.stdout.write(`scope: ${result.scope}\nexpira en: ${result.expires_in}s\n`);
} catch (err) {
  process.stderr.write(`Error de login: ${err.message}\n`);
  process.exit(1);
}
