import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AhClient } from "../client.js";
import { withJsonTool } from "./helpers.js";

export function registerBonusTools(server: McpServer, c: AhClient): void {
  server.registerTool(
    "ah_get_bonus_offers",
    {
      title: "Get Albert Heijn Weekly Bonus Offers",
      description:
        "Browse active national Bonus folder discounts, promotions (e.g. 1+1 gratis, 2e halve prijs), and validity windows. The folder is far larger than one page: walk `page` with `limit` to see more of it. Cached for up to 30 minutes.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        page: z.number().int().min(0).default(0).describe("Page number (default 0)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(30)
          .describe("Offers per page (default 30, max 100)"),
      }),
    },
    withJsonTool(({ page, limit }) => c.getBonusOffers("", page, limit))
  );

  server.registerTool(
    "ah_get_personal_bonus",
    {
      title: "Get Personal Bonus Box Offers",
      description:
        "Retrieve the 5 personalized weekly Bonus Box promotions for the logged-in Albert Heijn member. Cached for up to 30 minutes.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    withJsonTool(() => c.getPersonalBonus())
  );

  server.registerTool(
    "ah_get_clearance_bargains",
    {
      title: "Get Store Clearance Bargains (Overblijvers)",
      description:
        "Fetch today-only dynamic clearance markdowns (*vandaag-af* / 35% discount items) for a given store ID. Cached for up to 30 minutes.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        store_id: z
          .number()
          .int()
          .describe("Store ID number (from ah_search_stores)"),
      }),
    },
    withJsonTool(({ store_id }) => c.getClearanceBargains(store_id))
  );

  server.registerTool(
    "ah_get_predictive_favorites",
    {
      title: "Get Predictive Favorites",
      description:
        "Fetch predictive favorite recommendations and frequently reordered products predicted by Albert Heijn. Cached for up to 30 minutes.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    withJsonTool(() => c.getPredictiveFavorites())
  );

  server.registerTool(
    "ah_activate_personal_bonus",
    {
      title: "Activate Personal Bonus Offers",
      description:
        "Activate selected weekly Bonus Box promotions for a given Bonus card number.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        bonus_card_number: z
          .string()
          .describe("13-digit Albert Heijn Bonus card number"),
        selected_bonus_ids: z
          .array(z.number().int())
          .describe("Array of bonus offer IDs to activate"),
      }),
    },
    withJsonTool(async ({ bonus_card_number, selected_bonus_ids }) => ({
      status: "ok",
      result: await c.activatePersonalBonus(bonus_card_number, selected_bonus_ids),
    }))
  );
}
