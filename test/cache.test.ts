import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TtlCache, cacheKey, stableStringify, resetSharedCache } from "../src/cache.js";
import { AhClient, CACHE_TTL } from "../src/client.js";
import { saveTokens, clearAnonymousTokenCache } from "../src/auth.js";

describe("cache.ts - TtlCache", () => {
  it("stores a value and returns it before the TTL expires", () => {
    let now = 1_000;
    const cache = new TtlCache({ now: () => now });

    cache.set("a", { value: 42 }, 1000);
    assert.deepEqual(cache.get("a"), { value: 42 });

    now += 999;
    assert.deepEqual(cache.get("a"), { value: 42 });
  });

  it("expires an entry once the TTL has passed", () => {
    let now = 1_000;
    const cache = new TtlCache({ now: () => now });

    cache.set("a", "stale", 100);
    now += 101;

    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.stats().misses, 1);
  });

  it("evicts the least recently used entry when the cap is reached", () => {
    const cache = new TtlCache({ maxEntries: 2 });

    cache.set("a", 1, 10_000);
    cache.set("b", 2, 10_000);
    cache.get("a"); // 'a' becomes the most recent entry
    cache.set("c", 3, 10_000);

    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), 1);
    assert.equal(cache.get("c"), 3);
    assert.equal(cache.stats().evictions, 1);
  });

  it("invalidates every entry under a key prefix", () => {
    const cache = new TtlCache();

    cache.set("GET /mobile-services/bonusbox/v1 1", "a", 10_000);
    cache.set("GET /mobile-services/bonusbox/v1 2", "b", 10_000);
    cache.set("GET /mobile-services/recipe/v2 3", "c", 10_000);

    const removed = cache.invalidate("GET /mobile-services/bonusbox");

    assert.equal(removed, 2);
    assert.equal(cache.get("GET /mobile-services/bonusbox/v1 1"), undefined);
    assert.equal(cache.get("GET /mobile-services/recipe/v2 3"), "c");
  });

  it("coalesces concurrent identical loads into a single upstream call", async () => {
    const cache = new TtlCache();
    let loads = 0;

    const loader = async () => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 5));
      return "value";
    };

    const results = await Promise.all([
      cache.wrap("k", 10_000, loader),
      cache.wrap("k", 10_000, loader),
      cache.wrap("k", 10_000, loader),
    ]);

    assert.equal(loads, 1);
    assert.deepEqual(results, ["value", "value", "value"]);
  });

  it("never caches a failed load", async () => {
    const cache = new TtlCache();
    let attempts = 0;

    const loader = async () => {
      attempts += 1;
      throw new Error("upstream exploded");
    };

    await assert.rejects(() => cache.wrap("k", 10_000, loader));
    await assert.rejects(() => cache.wrap("k", 10_000, loader));

    assert.equal(attempts, 2);
    assert.equal(cache.get("k"), undefined);
    assert.equal(cache.stats().sets, 0);
  });

  it("reports hit and miss statistics", () => {
    const cache = new TtlCache();
    cache.set("a", 1, 10_000);

    cache.get("a");
    cache.get("a");
    cache.get("missing");

    const stats = cache.stats();
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 1);
    assert.equal(stats.entries, 1);
    assert.equal(stats.hitRate, 0.667);
  });

  it("is inert when disabled", async () => {
    const cache = new TtlCache({ enabled: false });
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return "value";
    };

    await cache.wrap("k", 10_000, loader);
    await cache.wrap("k", 10_000, loader);

    assert.equal(loads, 2);
    assert.equal(cache.stats().enabled, false);
  });

  it("builds stable keys regardless of parameter order", () => {
    assert.equal(
      stableStringify({ b: 1, a: 2 }),
      stableStringify({ a: 2, b: 1 })
    );
    assert.equal(
      cacheKey("GET /x", [{ b: 1, a: 2 }]),
      cacheKey("GET /x", [{ a: 2, b: 1 }])
    );
    assert.notEqual(cacheKey("GET /x", [1]), cacheKey("GET /x", [2]));
  });
});

describe("client.ts - response cache", () => {
  let tmpDir: string;
  let originalTokensFile: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  let originalCacheEnv: string | undefined;
  let calls: string[];

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "appie-cache-test-"));
    originalTokensFile = process.env.APPIE_TOKENS_FILE;
    process.env.APPIE_TOKENS_FILE = path.join(tmpDir, "tokens.json");
    originalFetch = globalThis.fetch;
    originalCacheEnv = process.env.APPIE_MCP_CACHE;
    calls = [];

    saveTokens({
      access_token: "test_access_token_12345",
      expires_in: 7200,
      saved_at: new Date().toISOString(),
    });

    // The cache is process-wide, so every case starts from a clean one.
    resetSharedCache();
    clearAnonymousTokenCache();

    globalThis.fetch = async (input: any, init: any) => {
      const url = String(input);
      calls.push(url);

      if (url.includes("/mobile-services/product/detail/v4/products/bulk")) {
        return json([{ id: 196825, title: "Test Product" }]);
      }
      if (url.includes("/mobile-services/product/detail/v4/products/") && url.includes("/alternatives")) {
        return json([{ id: 196826, title: "Alt Product" }]);
      }
      if (url.includes("/mobile-services/product/detail/v4/products/")) {
        return json({ productCard: { id: 196825, title: "Test Product" } });
      }
      if (url.includes("/mobile-services/product/search/v2")) {
        return json({ products: [], page: { totalElements: 0 } });
      }
      if (url.includes("/mobile-services/bonusbox/v1")) {
        return json({ bonusBox: [] });
      }
      if (url.includes("/mobile-services/shoppinglist/v2")) {
        return json({ id: "list-1", items: [] });
      }
      if (url.includes("/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.operationName === "FetchPosReceiptsPage") {
          return json({ data: { posReceiptsPage: { pagination: { totalElements: 0 }, posReceipts: [] } } });
        }
        if (body.operationName === "FetchPosReceiptsDetails") {
          return json({ data: { posReceiptDetails: { total: { amount: 10 }, products: [] } } });
        }
        return json({ data: {} });
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
    if (originalCacheEnv !== undefined) {
      process.env.APPIE_MCP_CACHE = originalCacheEnv;
    } else {
      delete process.env.APPIE_MCP_CACHE;
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

  it("serves a repeated product detail call from the cache", async () => {
    const client = new AhClient("https://api.ah.nl");

    await client.getProduct("wi196825");
    await client.getProduct("wi196825");

    assert.equal(calls.length, 1);
    const stats = client.cacheStats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.entries, 1);
  });

  it("caches bulk product details and product alternatives", async () => {
    const client = new AhClient("https://api.ah.nl");

    await client.getProductsBulk(["wi196825", "wi187593"]);
    await client.getProductsBulk(["wi196825", "wi187593"]);
    assert.equal(calls.length, 1, "bulk product cards are cached");

    await client.getProductAlternatives("wi196825");
    await client.getProductAlternatives("wi196825");
    assert.equal(calls.length, 2, "product alternatives are cached");
  });

  it("serves a repeated product search from the cache", async () => {
    const client = new AhClient("https://api.ah.nl");

    await client.searchProducts({ query: "havermelk", size: 5 });
    await client.searchProducts({ query: "havermelk", size: 5 });

    assert.equal(calls.length, 1);
  });

  it("does not share a cache entry between different searches", async () => {
    const client = new AhClient("https://api.ah.nl");

    await client.searchProducts({ query: "havermelk", size: 5 });
    await client.searchProducts({ query: "koffiebonen", size: 5 });

    assert.equal(calls.length, 2);
  });

  it("does not share a cache entry between different GraphQL documents", async () => {
    const client = new AhClient("https://api.ah.nl");

    // Same operation name, same variables, different selection sets: the
    // responses carry different fields and must not share an entry.
    await client.request("/graphql", {
      method: "POST",
      body: {
        query: "query GetBargainItems($storeId: Int!) { store { id } }",
        operationName: "GetBargainItems",
        variables: { storeId: 1 },
      },
    });
    await client.request("/graphql", {
      method: "POST",
      body: {
        query: "query GetBargainItems($storeId: Int!) { store { id name } }",
        operationName: "GetBargainItems",
        variables: { storeId: 1 },
      },
    });

    assert.equal(calls.length, 2);
  });

  it("caches receipt details but never the receipt overview list", async () => {
    const client = new AhClient("https://api.ah.nl");

    await client.listReceipts(0, 10);
    await client.listReceipts(0, 10);
    assert.equal(calls.length, 2, "receipt overview must always be fetched live");

    await client.getReceiptDetails("tx-1");
    await client.getReceiptDetails("tx-1");
    assert.equal(calls.length, 3, "receipt details are immutable and cached");
  });

  it("never caches shopping list reads", async () => {
    const client = new AhClient("https://api.ah.nl");

    await client.getShoppingList();
    await client.getShoppingList();

    assert.equal(calls.length, 2);
    assert.equal(client.cacheStats().entries, 0);
  });

  it("never caches the member profile", async () => {
    const client = new AhClient("https://api.ah.nl");

    await client.getProfile();
    await client.getProfile();

    assert.equal(calls.length, 2);
  });

  it("refetches once the TTL has expired", async () => {
    let now = 1_000_000;
    const cache = new TtlCache({ now: () => now });
    const client = new AhClient("https://api.ah.nl", cache);

    await client.searchProducts({ query: "havermelk", size: 5 });
    await client.searchProducts({ query: "havermelk", size: 5 });
    assert.equal(calls.length, 1);

    now += CACHE_TTL.search + 1;
    await client.searchProducts({ query: "havermelk", size: 5 });
    assert.equal(calls.length, 2);
  });

  it("bypasses the cache entirely when APPIE_MCP_CACHE is off", async () => {
    process.env.APPIE_MCP_CACHE = "off";
    // The shared instance is built from the environment on first use.
    resetSharedCache();
    const client = new AhClient("https://api.ah.nl");

    await client.getProduct("wi196825");
    await client.getProduct("wi196825");

    assert.equal(calls.length, 2);
    assert.equal(client.cacheStats().enabled, false);
  });

  it("invalidates the personal bonus box after a bonus activation", async () => {
    const client = new AhClient("https://api.ah.nl");

    await client.getPersonalBonus();
    await client.getPersonalBonus();
    assert.equal(calls.length, 1);

    await client.activatePersonalBonus("1234567890123", [1, 2]);
    await client.getPersonalBonus();

    assert.equal(calls.length, 3);
  });

  it("coalesces parallel identical calls into one upstream request", async () => {
    const client = new AhClient("https://api.ah.nl");

    await Promise.all([
      client.getProduct("wi196825"),
      client.getProduct("wi196825"),
      client.getProduct("wi196825"),
    ]);

    assert.equal(calls.length, 1);
  });

  it("scopes cache entries to the authenticated principal", async () => {
    const client = new AhClient("https://api.ah.nl");

    await client.getProduct("wi196825");
    await client.getProduct("wi196825");
    assert.equal(calls.length, 1);

    // A re-login under another account must not read the previous cache.
    saveTokens({
      access_token: "another_account_token_99999",
      expires_in: 7200,
      saved_at: new Date().toISOString(),
    });
    await client.getProduct("wi196825");

    assert.equal(calls.length, 2);
  });

  it("does not cache a receipt that cannot be resolved", async () => {
    const client = new AhClient("https://api.ah.nl");
    globalThis.fetch = async () =>
      json({ data: { posReceiptDetails: null } });

    await assert.rejects(() => client.getReceiptDetails("tx-missing"));
    await assert.rejects(() => client.getReceiptDetails("tx-missing"));

    assert.equal(client.cacheStats().entries, 0);
  });

  it("does not cache an unknown store's clearance list", async () => {
    const client = new AhClient("https://api.ah.nl");
    globalThis.fetch = async () => json({ data: { store: null } });

    await client.getClearanceBargains(4242);
    await client.getClearanceBargains(4242);

    assert.equal(client.cacheStats().entries, 0);
  });

  it("falls back to the default size cap when the configured one is invalid", () => {
    const cache = new TtlCache({ maxEntries: Number("1k") });
    assert.equal(cache.stats().maxEntries, 500);
  });
});
