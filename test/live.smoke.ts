import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryTokenStore, clearAnonymousTokenCache, setTokenStore } from "../src/auth.js";
import { resetSharedCache } from "../src/cache.js";
import { AhClient } from "../src/client.js";

/**
 * Opt-in live smoke test against api.ah.nl using an anonymous token.
 * Run with: npm run test:smoke
 */
describe("live smoke tests (api.ah.nl)", () => {
  beforeEach(() => {
    setTokenStore(new MemoryTokenStore());
    clearAnonymousTokenCache();
    resetSharedCache();
  });

  it("searchRecipes returns live Allerhande recipes and getRecipeDetails loads ingredients and steps", async () => {
    const client = new AhClient();

    const recipes = await client.searchRecipes("soep", 0, 5);
    assert.ok(recipes.length > 0, "expected at least one live recipe for 'soep'");
    assert.ok(recipes[0].id);
    assert.ok(recipes[0].title);

    const details = await client.getRecipeDetails(recipes[0].id);
    assert.ok(!("error" in details), `expected recipe details for ${recipes[0].id}`);
    assert.ok(details.ingredients.length > 0, "expected recipe ingredients");
    assert.ok((details.instructions?.length ?? 0) > 0, "expected recipe instructions");
    assert.ok(details.url?.startsWith("https://www.ah.nl/"), "expected full ah.nl recipe URL");

    const missing = await client.getRecipeDetails(999999999);
    assert.deepStrictEqual(missing, {
      error: "Not Found",
      message: "Recipe not found for ID: 999999999",
    });
  });

  it("catalog endpoints (search, getProduct, alternatives, bulk, categories, subCategories, suggestions) work live", async () => {
    const client = new AhClient();

    const search = await client.searchProducts({ query: "halfvolle melk", size: 3 });
    assert.ok(search.products.length > 0, "expected live search results");

    const firstId = search.products[0].id;
    const product = await client.getProduct(firstId);
    assert.equal(Number(product.id), Number(firstId));
    assert.ok(product.title.length > 0);

    const bulk = await client.getProductsBulk([firstId]);
    assert.ok(bulk.length >= 1, "expected bulk lookup to return at least 1 product");

    const alts = await client.getProductAlternatives(firstId);
    assert.ok(Array.isArray(alts));

    const categories = await client.getCategories();
    assert.ok(categories.length > 0, "expected top-level categories");

    const subs = await client.getSubCategories(categories[0].id);
    assert.ok(Array.isArray(subs) && subs.length > 0, "expected sub-categories");

    const suggestions = await client.getSearchSuggestions("melk", 5);
    assert.ok(suggestions.length > 0, "expected search suggestions");
  });

  it("storesSearch, clearance bargains, predictive favorites, cart, and bonus offers work live", async () => {
    const client = new AhClient();

    const amsterdamStores = await client.searchStores("Amsterdam");
    assert.ok(amsterdamStores.length > 0, "expected live stores for Amsterdam");
    assert.ok(amsterdamStores[0].id);

    const postalStores = await client.searchStores("1011");
    assert.ok(postalStores.length > 0, "expected live stores for postal code 1011");

    const bargains = await client.getClearanceBargains(Number(amsterdamStores[0].id));
    assert.ok(Array.isArray(bargains));

    const bonusOffers = await client.getBonusOffers("", 0, 5);
    assert.ok(bonusOffers.length > 0, "expected live bonus offers");

    const predictive = await client.getPredictiveFavorites();
    assert.ok(Array.isArray(predictive));

    const cart = await client.getCart();
    assert.ok(cart && typeof cart === "object" && "basket" in cart);
  });

  it("shopping list supports adding, reading, and removing items live in an anonymous session", async () => {
    const client = new AhClient();

    const search = await client.searchProducts({ query: "melk", size: 1 });
    assert.ok(search.products.length > 0);
    const productId = Number(search.products[0].id);
    const marker = `appie-mcp-smoke-${Date.now()}`;

    await client.addShoppingListItems([
      { type: "FREE_TEXT", text: marker, quantity: 1 },
      { type: "PRODUCT", productId, quantity: 1 },
    ]);

    const afterAdd = await client.getShoppingList();
    assert.ok(
      afterAdd.items.some((i) => i.type === "FREE_TEXT" && i.text === marker),
      "expected added free-text item in shopping list"
    );
    assert.ok(
      afterAdd.items.some((i) => i.type === "PRODUCT" && Number(i.productId) === productId),
      "expected added product item in shopping list"
    );

    await client.removeShoppingListItem(`txt:${marker}`);
    await client.removeShoppingListItem(`prd:${productId}`);

    const afterRemove = await client.getShoppingList();
    assert.ok(
      !afterRemove.items.some((i) => i.type === "FREE_TEXT" && i.text === marker),
      "expected free-text item to be removed"
    );
    assert.ok(
      !afterRemove.items.some((i) => i.type === "PRODUCT" && Number(i.productId) === productId),
      "expected product item to be removed"
    );
  });
});
