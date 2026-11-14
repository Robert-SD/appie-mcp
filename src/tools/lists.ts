import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AhClient } from "../client.js";
import { withJsonTool } from "./helpers.js";

export function registerListTools(server: McpServer, c: AhClient): void {
  server.registerTool(
    "ah_get_shopping_list",
    {
      title: "Get Albert Heijn Shopping List",
      description:
        "Get the user's primary in-app shopping list ('Boodschappenlijst'): items, free-text notes, and checked states. Always fetched live, never cached.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    withJsonTool(() => c.getShoppingList())
  );

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
              text: z
                .string()
                .optional()
                .describe("Free-text grocery name, e.g. 'eieren' or 'havermelk'"),
              product_id: z.number().optional().describe("Optional product ID number"),
            })
          )
          .min(1)
          .describe("List of items to add"),
      }),
    },
    withJsonTool(async ({ items }) => {
      const mapped = items.map((i) => ({
        text: i.text,
        productId: i.product_id,
        type: (i.product_id ? "PRODUCT" : "FREE_TEXT") as "PRODUCT" | "FREE_TEXT",
      }));
      return {
        status: "ok",
        result: await c.addShoppingListItems(mapped),
      };
    })
  );

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
    withJsonTool(async ({ item_id }) => ({
      status: "ok",
      result: await c.removeShoppingListItem(item_id),
    }))
  );

  server.registerTool(
    "ah_get_favorite_lists",
    {
      title: "Get Albert Heijn Favorite Lists (Mijn Lijstjes)",
      description:
        "Get user's saved custom favorite lists (e.g. 'Weekly Staples', 'Party') with item counts.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    withJsonTool(() => c.getFavoriteLists())
  );

  server.registerTool(
    "ah_check_favorite_list_item",
    {
      title: "Check / Uncheck Favorite List Item",
      description:
        "Tick an item off as collected (checked=true) or un-tick it in a favorite list.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        list_id: z.string().describe("Favorite list ID"),
        item_id: z.string().describe("Item ID"),
        checked: z
          .boolean()
          .default(true)
          .describe("true to check, false to uncheck"),
      }),
    },
    withJsonTool(async ({ list_id, item_id, checked }) => ({
      status: "ok",
      result: await c.setFavoriteListItemChecked(list_id, item_id, checked),
    }))
  );
}
