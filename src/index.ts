#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as dotenv from "dotenv";
import { runCliCommand } from "./cli.js";
import { AhClient } from "./client.js";
import { registerAccountTools } from "./tools/account.js";
import { registerBonusTools } from "./tools/bonus.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { toolError } from "./tools/helpers.js";
import { registerListTools } from "./tools/lists.js";
import { registerReceiptTools } from "./tools/receipts.js";
import { registerRecipeTools } from "./tools/recipes.js";

// Load local .env if present
dotenv.config();

export { toolError };

function loadPackageVersion(): string {
  try {
    const raw = fs.readFileSync(
      new URL("../package.json", import.meta.url),
      "utf-8"
    );
    return JSON.parse(raw).version || "0.4.0";
  } catch {
    return "0.4.0";
  }
}

const SERVER_VERSION = loadPackageVersion();
const client = new AhClient();

export function createServer(customClient?: AhClient): McpServer {
  const c = customClient || client;
  const server = new McpServer({
    name: "appie-mcp",
    version: SERVER_VERSION,
  });

  registerAccountTools(server, c);
  registerCatalogTools(server, c);
  registerBonusTools(server, c);
  registerListTools(server, c);
  registerReceiptTools(server, c);
  registerRecipeTools(server, c);

  return server;
}

async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main(): Promise<void> {
  const handled = await runCliCommand(process.argv.slice(2), client);
  if (!handled) {
    await startServer();
  }
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    const scriptPath = fs.realpathSync(path.resolve(process.argv[1]));
    const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
    return scriptPath === modulePath;
  } catch {
    return false;
  }
}

if (isDirectExecution() && !process.env.NODE_TEST_CONTEXT) {
  main().catch((err) => {
    process.stderr.write(`Fatal error: ${err.message}\n`);
    process.exit(1);
  });
}
