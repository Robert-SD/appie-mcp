import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { AhClient } from "../src/client.js";
import { resetSharedCache } from "../src/cache.js";
import { clearAnonymousTokenCache, saveTokens } from "../src/auth.js";
import { createServer } from "../src/index.js";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("shared response cache - one live instance per process", () => {
  let tmpDir: string;
  let originalTokensFile: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  let searchCalls: number;
  let tokenMints: number;

  const search = (c: AhClient) => c.searchProducts({ query: "halfvolle melk", size: 3 });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "appie-shared-cache-"));
    originalTokensFile = process.env.APPIE_TOKENS_FILE;
    process.env.APPIE_TOKENS_FILE = path.join(tmpDir, "tokens.json");
    delete process.env.APPIE_MCP_CACHE;
    originalFetch = globalThis.fetch;
    searchCalls = 0;
    tokenMints = 0;

    saveTokens({
      access_token: "test_access_token_12345",
      refresh_token: "test_refresh_token_12345",
      expires_in: 7200,
      saved_at: new Date().toISOString(),
    });

    resetSharedCache();
    clearAnonymousTokenCache();

    globalThis.fetch = async (input: any) => {
      const url = String(input);
      if (url.includes("/mobile-auth/v1/auth/token/anonymous")) {
        tokenMints += 1;
        // AH answers every mint with a brand-new token.
        return json({ access_token: `anon_${tokenMints}`, expires_in: 3600 });
      }
      if (url.includes("/mobile-services/product/search/v2")) {
        searchCalls += 1;
        return json({ products: [{ id: 1, title: "Halfvolle melk" }], page: { totalElements: 1 } });
      }
      return json({ ok: true });
    };
  });

  afterEach(() => {
    if (originalTokensFile !== undefined) {
      process.env.APPIE_TOKENS_FILE = originalTokensFile;
    } else {
      delete process.env.APPIE_TOKENS_FILE;
    }
    globalThis.fetch = originalFetch;
    resetSharedCache();
    clearAnonymousTokenCache();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("reuses an entry across separately constructed clients", async () => {
    await search(new AhClient("https://api.ah.nl"));

    // A second client (a per-request construction) must not start cold.
    const second = new AhClient("https://api.ah.nl");
    await search(second);

    assert.equal(searchCalls, 1, "the second call must not reach the network");
    const stats = second.cacheStats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
    assert.equal(stats.entries, 1);
  });

  it("mints the anonymous token once for repeated calls", async () => {
    // No token file: anonymous browsing.
    process.env.APPIE_TOKENS_FILE = path.join(tmpDir, "absent.json");
    clearAnonymousTokenCache();
    resetSharedCache();

    const client = new AhClient("https://api.ah.nl");
    await search(client);
    await search(client);

    assert.equal(tokenMints, 1, "the anonymous token must be minted once, not per call");
    assert.equal(searchCalls, 1);
    assert.equal(client.cacheStats().hits, 1);
  });

  it("keeps hitting when the anonymous token is reminted between calls", async () => {
    process.env.APPIE_TOKENS_FILE = path.join(tmpDir, "absent.json");
    clearAnonymousTokenCache();
    resetSharedCache();

    const client = new AhClient("https://api.ah.nl");
    await search(client);

    // Force a second mint: the new bearer token must not invalidate the cache.
    clearAnonymousTokenCache();
    await search(client);

    assert.equal(tokenMints, 2, "a fresh token was minted for the second call");
    assert.equal(searchCalls, 1, "a rotated bearer token must not wipe the cache");
    assert.equal(client.cacheStats().hits, 1);
  });

  it("keeps hitting when a member access token is refreshed mid-session", async () => {
    const client = new AhClient("https://api.ah.nl");
    await search(client);

    // A rotation keeps the same member; only the short-lived access token moves.
    saveTokens({
      access_token: "rotated_access_token_67890",
      refresh_token: "test_refresh_token_12345",
      expires_in: 7200,
      saved_at: new Date().toISOString(),
    });
    await search(client);

    assert.equal(searchCalls, 1, "an access-token rotation must not wipe the cache");
    assert.equal(client.cacheStats().hits, 1);
  });

  it("does not share entries between clients on different hosts", async () => {
    await search(new AhClient("https://api.ah.nl"));
    await search(new AhClient("https://staging.api.ah.nl"));

    assert.equal(searchCalls, 2, "a different host must not read the first client's entry");
  });

  it("reports exactly one stored entry for repeated identical calls", async () => {
    const client = new AhClient("https://api.ah.nl");
    for (let i = 0; i < 5; i++) {
      await search(client);
    }

    const stats = client.cacheStats();
    assert.equal(searchCalls, 1);
    assert.equal(stats.entries, 1);
    assert.equal(stats.hits, 4);
    assert.equal(stats.evictions, 0);
  });

  it("reports the tool handlers' hits through the ah_cache_stats tool", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const mcp = new Client({ name: "cache-test", version: "1.0.0" }, { capabilities: {} });
    await mcp.connect(clientTransport);

    const call = (name: string, args: Record<string, unknown>) =>
      mcp.callTool({ name, arguments: args }) as Promise<{ content: Array<{ text: string }> }>;

    await call("ah_search_products", { query: "halfvolle melk", limit: 3 });
    await call("ah_search_products", { query: "halfvolle melk", limit: 3 });

    const stats = JSON.parse((await call("ah_cache_stats", {})).content[0].text);

    assert.equal(searchCalls, 1, "the repeated tool call must not reach the network");
    assert.equal(stats.hits, 1, "ah_cache_stats must see the tool handlers' hits");
    assert.equal(stats.misses, 1);
    assert.equal(stats.entries, 1);
    assert.equal(stats.hitRate, 0.5);

    await mcp.close();
  });
});
