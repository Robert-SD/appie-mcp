#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import * as dotenv from "dotenv";
import { AhClient } from "./client.js";
import {
  getTokensFilePath,
  loadTokens,
  loginCli,
  refreshTokens,
} from "./auth.js";

// Load local .env if present
dotenv.config();

const client = new AhClient();

export function toolError(error: any) {
  return {
    content: [{ type: "text" as const, text: `Error: ${error.message}` }],
    isError: true,
  };
}

async function showStatus(): Promise<void> {
  let tokens = loadTokens();
  if (!tokens && (process.env.APPIE_REFRESH_TOKEN || process.env.AH_REFRESH_TOKEN)) {
    try {
      tokens = await refreshTokens();
    } catch {
      // Ignore
    }
  }

  console.log("=" .repeat(60));
  console.log("📋 ALBERT HEIJN (APPIE) MCP STATUS");
  console.log("=" .repeat(60));
  console.log(`Token storage: ${getTokensFilePath()}`);

  if (!tokens) {
    console.log("⚠️ No user session found. Operating in anonymous / public search mode.");
    console.log("\nRun 'npx appie-mcp login' to connect your personal Albert Heijn account.");
  } else {
    console.log(`Access Token:  ${tokens.access_token ? "✅ Present" : "❌ Missing"}`);
    console.log(`Refresh Token: ${tokens.refresh_token ? "✅ Active (Permanent)" : "❌ None"}`);
    console.log(`Last Saved:    ${tokens.saved_at || "Unknown"}`);
  }

  console.log("\nVerifying live API connection...");
  const cacheStats = client.cacheStats();
  console.log(
    `Response cache: ${cacheStats.enabled ? "enabled" : "disabled"} — ` +
      `max ${cacheStats.maxEntries} entries. ` +
      `Call ah_cache_stats for live hit/miss counters of the running server.`
  );
  try {
    const prof = await client.getProfile();
    console.log(`Customer Name: ${prof.name || "Anonymous / Public"}`);
    if (prof.bonusCardNumber) {
      console.log(`Bonus Card:    ${prof.bonusCardNumber}`);
    }
    console.log("✅ Connection healthy and operational!");
  } catch (err: any) {
    console.log(`⚠️ Note: ${err.message}`);
    console.log("Testing public product search...");
    try {
      const search = await client.searchProducts({ query: "koffie", size: 1 });
      console.log(`✅ Public API operational (${search.total} products accessible)`);
    } catch (searchErr: any) {
      console.log(`❌ API check failed: ${searchErr.message}`);
    }
  }
}

export function createServer(customClient?: AhClient): McpServer {
  const c = customClient || client;
  const server = new McpServer({
    name: "appie-mcp",
    version: "0.3.1",
  });

  // 1. Tool: Login Status / Profile Verification
  server.registerTool(
    "ah_login",
    {
      title: "Check Albert Heijn Login Status",
      description:
        "Check authentication status or verify session with Albert Heijn. Returns member identity, Bonus card details, and connection status.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const profile = await c.getProfile();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "authenticated",
                  authenticated: true,
                  name: profile.name,
                  email: profile.email,
                  bonus_card: profile.bonusCardNumber,
                  has_bonus_card: profile.hasBonusCard,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 2. Tool: Get Member Profile
  server.registerTool(
    "ah_get_profile",
    {
      title: "Get Albert Heijn Member Profile",
      description: "Get customer loyalty profile, name, email, and 13-digit Bonus card number.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const profile = await c.getProfile();
        return {
          content: [{ type: "text", text: JSON.stringify(profile, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 3. Tool: Search Products
  server.registerTool(
    "ah_search_products",
    {
      title: "Search Albert Heijn Products",
      description:
        "Search the Albert Heijn grocery catalog by keyword. Returns matching products with current prices, previous prices, active bonus discounts, unit prices, and web links. Results are cached for up to 30 minutes.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe("Grocery product keyword (e.g. 'havermelk', 'koffiebonen', 'bio bananen')"),
        sort: z
          .enum(["RELEVANCE", "PRICE_ASC", "PRICE_DESC"])
          .optional()
          .default("RELEVANCE")
          .describe("Sort order: RELEVANCE, PRICE_ASC (cheapest first), or PRICE_DESC"),
        bonus_only: z.boolean().optional().default(false).describe("Set to true to return only items on Bonus discount"),
        limit: z.number().int().min(1).max(30).default(20).describe("Maximum products to return (default 20)"),
        page: z.number().int().min(0).default(0).describe("Page number (default 0)"),
      }),
    },
    async ({ query, sort, bonus_only, limit, page }) => {
      try {
        const result = await c.searchProducts({
          query,
          sort,
          bonusOnly: bonus_only,
          size: limit,
          page,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 4. Tool: Get Product Details
  server.registerTool(
    "ah_get_product",
    {
      title: "Get Albert Heijn Product Details",
      description:
        "Get detailed information for a specific Albert Heijn product: description, nutritional values, allergens, unit sizes, and pricing. Product pages are cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        product_id: z.string().describe("Product ID (e.g. 'wi196825' or '196825')"),
      }),
    },
    async ({ product_id }) => {
      try {
        const product = await c.getProduct(product_id);
        return {
          content: [{ type: "text", text: JSON.stringify(product, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 5. Tool: Get Product Alternatives
  server.registerTool(
    "ah_get_product_alternatives",
    {
      title: "Get Product Alternatives & Substitutes",
      description: "Find direct brand alternatives, store-brand swaps, or dietary substitutes for a product. Cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        product_id: z.string().describe("Product ID (e.g. 'wi196825' or '196825')"),
      }),
    },
    async ({ product_id }) => {
      try {
        const alternatives = await c.getProductAlternatives(product_id);
        return {
          content: [{ type: "text", text: JSON.stringify(alternatives, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 6. Tool: Get Product Categories (Shelves)
  server.registerTool(
    "ah_get_categories",
    {
      title: "Get Albert Heijn Product Categories",
      description: "Get top-level supermarket product shelves and categories (e.g. Aardappel/groente/fruit, Bakkerij, Zuivel). Cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const categories = await c.getCategories();
        return {
          content: [{ type: "text", text: JSON.stringify(categories, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 7. Tool: Get Weekly Bonus Offers
  server.registerTool(
    "ah_get_bonus_offers",
    {
      title: "Get Albert Heijn Weekly Bonus Offers",
      description:
        "Browse active national Bonus folder discounts, promotions (e.g. 1+1 gratis, 2e halve prijs), and validity windows. The folder is far larger than one page: walk `page` with `limit` to see more of it. Cached for up to 30 minutes.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        page: z.number().int().min(0).default(0).describe("Page number (default 0)"),
        limit: z.number().int().min(1).max(100).default(30).describe(
          "Offers per page (default 30, max 100)"
        ),
      }),
    },
    async ({ page, limit }) => {
      try {
        const offers = await c.getBonusOffers("", page, limit);
        return {
          content: [{ type: "text", text: JSON.stringify(offers, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 8. Tool: Get Personal Bonus Box
  server.registerTool(
    "ah_get_personal_bonus",
    {
      title: "Get Personal Bonus Box Offers",
      description: "Retrieve the 5 personalized weekly Bonus Box promotions for the logged-in Albert Heijn member. Cached for up to 30 minutes.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const box = await c.getPersonalBonus();
        return {
          content: [{ type: "text", text: JSON.stringify(box, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 9. Tool: Get Shopping List
  server.registerTool(
    "ah_get_shopping_list",
    {
      title: "Get Albert Heijn Shopping List",
      description: "Get the user's primary in-app shopping list ('Boodschappenlijst'): items, free-text notes, and checked states. Always fetched live, never cached.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const list = await c.getShoppingList();
        return {
          content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 10. Tool: Add Items to Shopping List (WRITE)
  server.registerTool(
    "ah_add_to_shopping_list",
    {
      title: "Add Items to Albert Heijn Shopping List",
      description:
        "Add one or more free-text items or products to the user's Albert Heijn shopping list. WRITES to the real AH account.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              text: z.string().optional().describe("Free-text grocery name, e.g. 'eieren' or 'havermelk'"),
              product_id: z.number().optional().describe("Optional product ID number"),
            })
          )
          .min(1)
          .describe("List of items to add"),
      }),
    },
    async ({ items }) => {
      try {
        const mapped = items.map((i) => ({
          text: i.text,
          productId: i.product_id,
          type: (i.product_id ? "PRODUCT" : "FREE_TEXT") as "PRODUCT" | "FREE_TEXT",
        }));
        const res = await c.addShoppingListItems(mapped);
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "ok", result: res }, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 11. Tool: Remove Item from Shopping List (WRITE)
  server.registerTool(
    "ah_remove_from_shopping_list",
    {
      title: "Remove Item from Albert Heijn Shopping List",
      description: "Remove an item from the primary shopping list by its item ID.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: z.object({
        item_id: z.string().describe("Shopping list item ID"),
      }),
    },
    async ({ item_id }) => {
      try {
        const res = await c.removeShoppingListItem(item_id);
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "ok", result: res }, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 12. Tool: Get Favorite Lists (Mijn Lijstjes)
  server.registerTool(
    "ah_get_favorite_lists",
    {
      title: "Get Albert Heijn Favorite Lists (Mijn Lijstjes)",
      description: "Get user's saved custom favorite lists (e.g. 'Weekly Staples', 'Party') with item counts.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const lists = await c.getFavoriteLists();
        return {
          content: [{ type: "text", text: JSON.stringify(lists, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 13. Tool: Check / Uncheck Favorite List Item (WRITE)
  server.registerTool(
    "ah_check_favorite_list_item",
    {
      title: "Check / Uncheck Favorite List Item",
      description: "Tick an item off as collected (checked=true) or un-tick it in a favorite list.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        list_id: z.string().describe("Favorite list ID"),
        item_id: z.string().describe("Item ID"),
        checked: z.boolean().default(true).describe("true to check, false to uncheck"),
      }),
    },
    async ({ list_id, item_id, checked }) => {
      try {
        const res = await c.setFavoriteListItemChecked(list_id, item_id, checked);
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "ok", result: res }, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 14. Tool: List Receipts (Kassabonnen)
  server.registerTool(
    "ah_list_receipts",
    {
      title: "List Albert Heijn Receipts",
      description:
        "List in-store cash register receipts (kassabonnen) with date, store name, and total. Pagination is real: page and size walk the whole history, and a size above 100 is fetched in 100-row windows. Always fetched live, never cached.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        page: z.number().int().min(0).default(0).describe("Page number (default 0)"),
        size: z.number().int().min(1).max(500).default(10).describe(
          "Number of receipts to return (default 10, max 500; above 100 is fetched in 100-row windows)"
        ),
      }),
    },
    async ({ page, size }) => {
      try {
        const receipts = await c.listReceipts(page, size);
        return {
          content: [{ type: "text", text: JSON.stringify(receipts, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 15. Tool: Get Receipt Details
  server.registerTool(
    "ah_get_receipt_details",
    {
      title: "Get Albert Heijn Receipt Details",
      description: "Get detailed line items, unit prices, discounts, and total amount for a specific store receipt. A closed receipt is immutable, so it is cached for 30 days.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        transaction_id: z.string().describe("Receipt transaction ID (from ah_list_receipts)"),
      }),
    },
    async ({ transaction_id }) => {
      try {
        const details = await c.getReceiptDetails(transaction_id);
        return {
          content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 16. Tool: Promo Digest (Habit-based deals)
  server.registerTool(
    "ah_get_promo_digest",
    {
      title: "Get Albert Heijn Promo Digest",
      description:
        "Answer 'of the things I frequently buy, what is on Bonus discount right now?'. Mines receipts inside the requested window — paging back to the oldest receipt that falls in it, up to 150 — and cross-references them against active offers.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        days: z.number().int().positive().max(365).default(90).describe("Days of receipt history to scan (default 90)"),
        min_times: z.number().int().positive().default(2).describe("Minimum purchase count to consider frequent (default 2)"),
        limit: z.number().int().positive().max(50).default(20).describe("Maximum offers to return (default 20)"),
      }),
    },
    async ({ days, min_times, limit }) => {
      try {
        const digest = await c.getPromoDigest({ days, minTimes: min_times, limit });
        return {
          content: [{ type: "text", text: JSON.stringify(digest, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 17. Tool: Search Allerhande Recipes
  server.registerTool(
    "ah_search_recipes",
    {
      title: "Search Allerhande Recipes",
      description: "Search the official Albert Heijn Allerhande recipe collection by dish name, ingredient, or keyword. Cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe("Recipe search keyword (e.g. 'pasta pesto', 'vegetarische ovenschotel')"),
        limit: z.number().int().min(1).max(20).default(10).describe("Number of recipes to return (default 10)"),
      }),
    },
    async ({ query, limit }) => {
      try {
        const recipes = await c.searchRecipes(query, 0, limit);
        return {
          content: [{ type: "text", text: JSON.stringify(recipes, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 18. Tool: Get Recipe Details
  server.registerTool(
    "ah_get_recipe_details",
    {
      title: "Get Allerhande Recipe Details & Ingredients",
      description: "Get full cooking steps and structured ingredient list (with product mappings) for an Allerhande recipe. Cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        recipe_id: z.string().describe("Recipe ID (e.g. '1195610')"),
      }),
    },
    async ({ recipe_id }) => {
      try {
        const details = await c.getRecipeDetails(recipe_id);
        return {
          content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 19. Tool: Search Stores
  server.registerTool(
    "ah_search_stores",
    {
      title: "Search Albert Heijn Stores",
      description: "Search nearby Albert Heijn stores by postal code or city name to check opening hours, distance, and facilities. Cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().optional().describe("Dutch city name or postal code (e.g. 'Amsterdam' or '1011NG')"),
      }),
    },
    async ({ query }) => {
      try {
        const stores = await c.searchStores(query);
        return {
          content: [{ type: "text", text: JSON.stringify(stores, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 20. Tool: Today's Clearance Bargains (Overblijvers)
  server.registerTool(
    "ah_get_clearance_bargains",
    {
      title: "Get Store Clearance Bargains (Overblijvers)",
      description: "Fetch today-only dynamic clearance markdowns (*vandaag-af* / 35% discount items) for a given store ID. Cached for up to 30 minutes.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        store_id: z.number().int().describe("Store ID number (from ah_search_stores)"),
      }),
    },
    async ({ store_id }) => {
      try {
        const bargains = await c.getClearanceBargains(store_id);
        return {
          content: [{ type: "text", text: JSON.stringify(bargains, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 21. Tool: Search Suggestions
  server.registerTool(
    "ah_get_search_suggestions",
    {
      title: "Get Search Suggestions",
      description: "Get search autocompletion suggestions and related grocery query keywords from Albert Heijn. Cached for up to 30 minutes.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe("Search query prefix or keyword"),
        limit: z.number().int().min(1).max(30).default(10).describe("Maximum suggestions to return (default 10)"),
      }),
    },
    async ({ query, limit }) => {
      try {
        const suggestions = await c.getSearchSuggestions(query, limit);
        return {
          content: [{ type: "text", text: JSON.stringify(suggestions, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 22. Tool: Predictive Favorites
  server.registerTool(
    "ah_get_predictive_favorites",
    {
      title: "Get Predictive Favorites",
      description: "Fetch predictive favorite recommendations and frequently reordered products predicted by Albert Heijn. Cached for up to 30 minutes.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const favorites = await c.getPredictiveFavorites();
        return {
          content: [{ type: "text", text: JSON.stringify(favorites, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 23. Tool: Activate Personal Bonus Box
  server.registerTool(
    "ah_activate_personal_bonus",
    {
      title: "Activate Personal Bonus Offers",
      description: "Activate selected weekly Bonus Box promotions for a given Bonus card number.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        bonus_card_number: z.string().describe("13-digit Albert Heijn Bonus card number"),
        selected_bonus_ids: z.array(z.number().int()).describe("Array of bonus offer IDs to activate"),
      }),
    },
    async ({ bonus_card_number, selected_bonus_ids }) => {
      try {
        const result = await c.activatePersonalBonus(bonus_card_number, selected_bonus_ids);
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "ok", result }, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 24. Tool: Get Products in Bulk
  server.registerTool(
    "ah_get_products_bulk",
    {
      title: "Get Products Bulk",
      description: "Fetch product details in bulk for multiple Albert Heijn product IDs (e.g. ['wi196825', 'wi187593']). Cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        product_ids: z.array(z.string()).min(1).describe("List of product IDs (e.g. ['wi196825', 'wi187593'])"),
      }),
    },
    async ({ product_ids }) => {
      try {
        const products = await c.getProductsBulk(product_ids);
        return {
          content: [{ type: "text", text: JSON.stringify(products, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 25. Tool: Get Subcategories
  server.registerTool(
    "ah_get_sub_categories",
    {
      title: "Get Subcategories",
      description: "Fetch child subcategories for a specific supermarket category ID. Cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        category_id: z.union([z.string(), z.number()]).describe("Category ID to retrieve subcategories for"),
      }),
    },
    async ({ category_id }) => {
      try {
        const subCategories = await c.getSubCategories(category_id);
        return {
          content: [{ type: "text", text: JSON.stringify(subCategories, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 26. Tool: Get Active Online Cart
  server.registerTool(
    "ah_get_cart",
    {
      title: "Get Online Cart",
      description: "Read-only view of the user's active Albert Heijn online shopping cart and order summary. Always fetched live, never cached.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const cart = await c.getCart();
        return {
          content: [{ type: "text", text: JSON.stringify(cart, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  // 27. Tool: Cache Statistics
  server.registerTool(
    "ah_cache_stats",
    {
      title: "Get Response Cache Statistics",
      description:
        "Report the in-process response cache: enabled state, hits, misses, hit rate, stored entries and evictions. Use to verify that cached Albert Heijn responses are reused instead of re-fetched.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const stats = c.cacheStats();
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
        };
      } catch (error: any) {
        return toolError(error);
      }
    }
  );

  return server;
}

async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0]?.toLowerCase();

  if (cmd === "login") {
    const manual = args.includes("--manual");
    const save = args.includes("--save");
    await loginCli({ manual, save });
  } else if (cmd === "status") {
    await showStatus();
  } else {
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
