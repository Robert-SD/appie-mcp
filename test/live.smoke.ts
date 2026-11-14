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
});
