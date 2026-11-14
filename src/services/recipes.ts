import { GRAPHQL_QUERIES } from "../graphql-queries.js";
import {
  mapRecipeDetails,
  mapRecipeSummary,
  parsePositiveIntId,
} from "../mappers.js";
import { Recipe } from "../types.js";
import { AhTransport } from "./transport.js";

export async function searchRecipes(
  t: AhTransport,
  query: string,
  page: number = 0,
  size: number = 10
): Promise<Recipe[]> {
  const safePage = Math.max(0, Math.trunc(page));
  const safeSize = Math.max(1, Math.trunc(size));

  const resp = await t.graphql<any>(
    "FetchRecipes",
    GRAPHQL_QUERIES.FetchRecipes,
    {
      searchText: query,
      start: safePage * safeSize,
      size: safeSize,
      sortBy: "MOST_RELEVANT",
      filters: [],
      priorityRecipeIds: [],
      boostFavoriteRecipeIds: [],
      recipeIds: [],
      ingredients: [],
    }
  );

  const rawList = resp?.data?.recipeSearchV2?.result;
  if (!Array.isArray(rawList)) {
    throw new Error(
      "Unexpected response shape from FetchRecipes: missing recipeSearchV2.result"
    );
  }

  return rawList.map(mapRecipeSummary);
}

export async function getRecipeDetails(
  t: AhTransport,
  recipeId: string | number
): Promise<Recipe | { error: string; message: string }> {
  const numericId = parsePositiveIntId(recipeId, /^R-R/i, "recipe");

  const resp = await t.graphql<any>(
    "FetchRecipeDetails",
    GRAPHQL_QUERIES.FetchRecipeDetails,
    { id: numericId },
    { allowPartialErrorPaths: ["recipe"] }
  );

  const data = resp?.data?.recipe;
  if (data === null) {
    return {
      error: "Not Found",
      message: `Recipe not found for ID: ${recipeId}`,
    };
  }
  if (!data) {
    throw new Error(
      "Unexpected response shape from FetchRecipeDetails: missing data.recipe"
    );
  }

  return mapRecipeDetails(data, numericId);
}
