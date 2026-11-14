import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AhClient } from "../client.js";
import { withJsonTool } from "./helpers.js";

export function registerAccountTools(server: McpServer, c: AhClient): void {
  server.registerTool(
    "ah_login",
    {
      title: "Check Albert Heijn Login Status",
      description:
        "Check authentication status or verify session with Albert Heijn. Returns member identity, Bonus card details, and connection status.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    withJsonTool(async () => {
      const profile = await c.getProfile();
      return {
        status: "authenticated",
        authenticated: true,
        name: profile.name,
        email: profile.email,
        bonus_card: profile.bonusCardNumber,
        has_bonus_card: profile.hasBonusCard,
      };
    })
  );

  server.registerTool(
    "ah_get_profile",
    {
      title: "Get Albert Heijn Member Profile",
      description:
        "Get customer loyalty profile, name, email, and 13-digit Bonus card number.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    withJsonTool(() => c.getProfile())
  );

  server.registerTool(
    "ah_search_stores",
    {
      title: "Search Albert Heijn Stores",
      description:
        "Search nearby Albert Heijn stores by postal code or city name to check opening hours, distance, and facilities. Cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Dutch city name or postal code (e.g. 'Amsterdam' or '1011NG')"),
      }),
    },
    withJsonTool(({ query }) => c.searchStores(query))
  );

  server.registerTool(
    "ah_get_cart",
    {
      title: "Get Online Cart",
      description:
        "Read-only view of the user's active Albert Heijn online shopping cart and order summary. Always fetched live, never cached.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    withJsonTool(() => c.getCart())
  );

  server.registerTool(
    "ah_cache_stats",
    {
      title: "Get Response Cache Statistics",
      description:
        "Report the in-process response cache: enabled state, hits, misses, hit rate, stored entries and evictions. Use to verify that cached Albert Heijn responses are reused instead of re-fetched.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    withJsonTool(async () => c.cacheStats())
  );
}
