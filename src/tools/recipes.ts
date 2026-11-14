import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AhClient } from "../client.js";
import { withJsonTool } from "./helpers.js";

export function registerRecipeTools(server: McpServer, c: AhClient): void {
  server.registerTool(
    "ah_search_recipes",
    {
      title: "Search Allerhande Recipes",
      description:
        "Search the official Albert Heijn Allerhande recipe collection by dish name, ingredient, or keyword. Cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Recipe search keyword (e.g. 'pasta pesto', 'vegetarische ovenschotel')"
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(10)
          .describe("Number of recipes to return (default 10)"),
      }),
    },
    withJsonTool(({ query, limit }) => c.searchRecipes(query, 0, limit))
  );

  server.registerTool(
    "ah_get_recipe_details",
    {
      title: "Get Allerhande Recipe Details & Ingredients",
      description:
        "Get full cooking steps and structured ingredient list (with product mappings) for an Allerhande recipe. Cached for up to 24 hours.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        recipe_id: z.string().describe("Recipe ID (e.g. '1195610')"),
      }),
    },
    withJsonTool(({ recipe_id }) => c.getRecipeDetails(recipe_id))
  );
}
