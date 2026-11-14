import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cacheKeyFor, cachePolicyFor } from "../src/cache-policy.js";
import { mapWithConcurrency } from "../src/concurrency.js";
import {
  mapGraphqlProduct,
  mapStore,
  parsePositiveIntId,
} from "../src/mappers.js";

describe("mappers & pure helpers", () => {
  it("parsePositiveIntId strips optional prefixes and validates positive integers", () => {
    assert.equal(parsePositiveIntId("wi196825", /^wi/i, "product"), 196825);
    assert.equal(parsePositiveIntId("R-R1195610", /^R-R/i, "recipe"), 1195610);
    assert.equal(parsePositiveIntId("42", null, "category"), 42);
    assert.throws(() => parsePositiveIntId("wi0", /^wi/i, "product"), /Invalid product ID/);
    assert.throws(() => parsePositiveIntId("abc", /^R-R/i, "recipe"), /Invalid recipe ID/);
  });

  it("mapGraphqlProduct extracts string URLs and dimensions from imagePack objects", () => {
    const product = mapGraphqlProduct({
      id: "196825",
      title: "AH Halfvolle melk",
      brand: "AH",
      salesUnitSize: "1 l",
      priceV2: {
        now: { amount: 1.09 },
        was: { amount: 1.39 },
        unitInfo: { price: { formattedV2: "€ 1.09 / l" } },
        discount: { description: "Bonus", promotionType: "BONUS" },
      },
      availability: { isOrderable: true, online: { status: "ORDERABLE" } },
      imagePack: [
        {
          large: { url: "https://static.ah.nl/large.jpg", width: 800, height: 800 },
          medium: { url: "https://static.ah.nl/med.jpg", width: 400, height: 400 },
        },
        {
          medium: "https://static.ah.nl/string-fallback.jpg",
        },
      ],
    });

    assert.equal(product.id, 196825);
    assert.equal(product.webProductId, "wi196825");
    assert.equal(product.price.now, 1.09);
    assert.equal(product.price.was, 1.39);
    assert.equal(product.unitPriceDescription, "€ 1.09 / l");
    assert.equal(product.bonus, true);
    assert.deepEqual(product.images, [
      { url: "https://static.ah.nl/large.jpg", width: 800, height: 800 },
      { url: "https://static.ah.nl/string-fallback.jpg" },
    ]);
  });

  it("mapStore formats street house numbers and service codes cleanly", () => {
    const store = mapStore({
      id: 1001,
      name: "AH Dam",
      address: {
        street: "Nieuwendijk",
        houseNumber: 120,
        houseNumberExtra: "A",
        postalCode: "1012MR",
        city: "Amsterdam",
      },
      services: [{ code: "ZELFSCAN", description: "Zelfscan" }, { description: "Bakery" }],
    });

    assert.equal(store.street, "Nieuwendijk 120A");
    assert.deepEqual(store.facilities, ["ZELFSCAN", "Bakery"]);
  });

  it("mapWithConcurrency preserves output order and bounds active workers", async () => {
    let active = 0;
    let maxActive = 0;
    const output = await mapWithConcurrency([10, 20, 30, 40, 50], 2, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return item * 2;
    });

    assert.deepEqual(output, [20, 40, 60, 80, 100]);
    assert.ok(maxActive <= 2, `expected max concurrency <= 2, got ${maxActive}`);
  });

  it("cachePolicyFor and cacheKeyFor classify routes declaratively", () => {
    assert.ok(cachePolicyFor("/mobile-services/product/search/v2/products", { method: "GET" }));
    assert.equal(cachePolicyFor("/mobile-services/shoppinglist/v2/items", { method: "GET" }), null);
    assert.ok(
      cachePolicyFor("/graphql", {
        method: "POST",
        body: { operationName: "FetchProductDetails" },
      })
    );
    assert.equal(
      cachePolicyFor("/graphql", {
        method: "POST",
        body: { operationName: "FetchMember" },
      }),
      null
    );

    const k1 = cacheKeyFor(
      "https://api.ah.nl",
      "/mobile-services/product/search/v2",
      { query: { query: "melk", size: 10 } },
      "anon"
    );
    const k2 = cacheKeyFor(
      "https://api.ah.nl",
      "/mobile-services/product/search/v2",
      { query: { size: 10, query: "melk" } },
      "anon"
    );
    assert.equal(k1, k2);
  });
});
