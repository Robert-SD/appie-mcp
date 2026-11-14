import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AhClient } from "../client.js";
import { withJsonTool } from "./helpers.js";

export function registerCatalogTools(server: McpServer, c: AhClient): void {
  server.registerTool(
    "ah_search_products",
    {
      title: "Search Albert Heijn Products",
      description:
        "Search the Albert Heijn grocery catalog by keyword. Returns matching products with current prices, previous prices, active bonus discounts, unit prices, and web links. Results are cached for up to 30 minutes.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Grocery product keyword (e.g. 'havermelk', 'koffiebonen', 'bio bananen')"
          ),
        sort: z
          .enum(["RELEVANCE", "PRICE_ASC", "PRICE_DESC"])
          .optional()
          .default("RELEVANCE")
          .describe("Sort order: RELEVANCE, PRICE_ASC (cheapest first), or PRICE_DESC"),
        bonus_only: z
          .boolean()
          .optional()
          .default(false)
          .describe("Set to true to return only items on Bonus discount"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(20)
          .describe("Maximum products to return (default 20)"),
        page: z.number().int().min(0).default(0).describe("Page number (default 0)"),
      }),
    },
    withJsonTool(({ query, sort, bonus_only, limit, page }) =>
      c.searchProducts({
        query,
        sort,
        bonusOnly: bonus_only,
        size: limit,
        page,
      })
    )
  );

  server.registerTool(
    "ah_get_product",
    {
      title: "Get Albert Heijn Product Details",
      description:
        "Get detailed information for a specific Albert Heijn product: description, nutritional values, allergens, unit sizes, and pricing. Product pages are cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        product_id: z
          .string()
          .describe("Product ID (e.g. 'wi196825' or '196825')"),
      }),
    },
    withJsonTool(({ product_id }) => c.getProduct(product_id))
  );

  server.registerTool(
    "ah_get_product_alternatives",
    {
      title: "Get Product Alternatives & Substitutes",
      description:
        "Find direct brand alternatives, store-brand swaps, or dietary substitutes for a product. Cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        product_id: z
          .string()
          .describe("Product ID (e.g. 'wi196825' or '196825')"),
      }),
    },
    withJsonTool(({ product_id }) => c.getProductAlternatives(product_id))
  );

  server.registerTool(
    "ah_get_categories",
    {
      title: "Get Albert Heijn Product Categories",
      description:
        "Get top-level supermarket product shelves and categories (e.g. Aardappel/groente/fruit, Bakkerij, Zuivel). Cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    withJsonTool(() => c.getCategories())
  );

  server.registerTool(
    "ah_get_products_bulk",
    {
      title: "Get Products Bulk",
      description:
        "Fetch product details in bulk for multiple Albert Heijn product IDs (e.g. ['wi196825', 'wi187593']). Cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        product_ids: z
          .array(z.string())
          .min(1)
          .describe("List of product IDs (e.g. ['wi196825', 'wi187593'])"),
      }),
    },
    withJsonTool(({ product_ids }) => c.getProductsBulk(product_ids))
  );

  server.registerTool(
    "ah_get_sub_categories",
    {
      title: "Get Subcategories",
      description:
        "Fetch child subcategories for a specific supermarket category ID. Cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        category_id: z
          .union([z.string(), z.number()])
          .describe("Category ID to retrieve subcategories for"),
      }),
    },
    withJsonTool(({ category_id }) => c.getSubCategories(category_id))
  );

  server.registerTool(
    "ah_get_search_suggestions",
    {
      title: "Get Search Suggestions",
      description:
        "Get search autocompletion suggestions and related grocery query keywords from Albert Heijn. Cached for up to 30 minutes.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe("Search query prefix or keyword"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(10)
          .describe("Maximum suggestions to return (default 10)"),
      }),
    },
    withJsonTool(({ query, limit }) => c.getSearchSuggestions(query, limit))
  );
}
