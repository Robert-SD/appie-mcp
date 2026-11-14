import { GRAPHQL_QUERIES } from "../graphql-queries.js";
import { mapFavoriteList, mapShoppingListItems } from "../mappers.js";
import { FavoriteList, ShoppingList } from "../types.js";
import { getProfile } from "./stores.js";
import { AhTransport } from "./transport.js";

export async function getShoppingList(t: AhTransport): Promise<ShoppingList> {
  try {
    const data = await t.request<any>("/mobile-services/shoppinglist/v2/items");
    const items = mapShoppingListItems(data.items || []);
    return {
      id: data.id,
      items,
      totalItems: items.length,
    };
  } catch (err: any) {
    if (err.status === 404) {
      try {
        const profile = await getProfile(t);
        if (profile.bonusCardNumber) {
          const data = await t.request<any>(
            `https://api.ah.nl/handscanner/v1/lists?bonusCardNumber=${profile.bonusCardNumber}`
          );
          const list = (data.lists || [])[0] || {};
          const items = mapShoppingListItems(list.items || []);
          return {
            id: list.id,
            items,
            totalItems: items.length,
          };
        }
      } catch {
        // Ignore fallback error and throw original error
      }
    }
    throw err;
  }
}

export async function addShoppingListItems(
  t: AhTransport,
  items: Array<{
    type?: "FREE_TEXT" | "PRODUCT";
    text?: string;
    productId?: number;
    quantity?: number;
  }>
): Promise<any> {
  const payload = {
    items: items.map((i) => {
      const isProduct = Boolean(i.productId) || i.type === "PRODUCT";
      const cleanProductId =
        i.productId !== undefined
          ? Number(String(i.productId).replace(/^wi/i, ""))
          : undefined;
      return {
        type: "SHOPPABLE",
        originCode: isProduct ? "PRD" : "TXT",
        ...(i.text ? { description: i.text, searchTerm: i.text } : {}),
        ...(cleanProductId !== undefined ? { productId: cleanProductId } : {}),
        quantity: i.quantity || 1,
        strikeThrough: false,
      };
    }),
  };
  const res = await t.request<any>("/mobile-services/shoppinglist/v2/items", {
    method: "PATCH",
    body: payload,
  });
  t.invalidateCache("GET /mobile-services/shoppinglist");
  return res;
}

export async function removeShoppingListItem(
  t: AhTransport,
  itemId: string | number
): Promise<any> {
  const needle = String(itemId).trim();
  const list = await getShoppingList(t);
  const match = list.items.find(
    (i) =>
      String(i.id) === needle ||
      (i.productId !== undefined &&
        (String(i.productId) === needle || `prd:${i.productId}` === needle)) ||
      (i.text !== undefined && (i.text === needle || `txt:${i.text}` === needle))
  );

  if (!match) {
    throw new Error(`Shopping list item not found: ${itemId}`);
  }

  const removalItem =
    match.type === "PRODUCT" && match.productId !== undefined
      ? {
          listItemId: 0,
          type: "SHOPPABLE",
          originCode: "PRD",
          productId: match.productId,
          quantity: 0,
          strikeThrough: false,
        }
      : {
          listItemId: 0,
          type: "SHOPPABLE",
          originCode: "TXT",
          description: match.text || "",
          searchTerm: match.text || "",
          quantity: 0,
          strikeThrough: false,
        };

  const res = await t.request<any>("/mobile-services/shoppinglist/v2/items", {
    method: "PATCH",
    body: { items: [removalItem] },
  });
  t.invalidateCache("GET /mobile-services/shoppinglist");
  return res;
}

export async function getFavoriteLists(t: AhTransport): Promise<FavoriteList[]> {
  const resp = await t.graphql<any>(
    "FetchFavoriteLists",
    GRAPHQL_QUERIES.FetchFavoriteLists,
    { ids: [], productIds: [] }
  );

  const data = resp?.data?.favoriteListV2;
  return Array.isArray(data) ? data.map(mapFavoriteList) : [];
}

export async function addFavoriteListItem(
  t: AhTransport,
  listId: string,
  item: { productId: number; quantity?: number; originCode?: string }
): Promise<any> {
  const resp = await t.graphql<any>(
    "AddProductsToFavoriteList",
    GRAPHQL_QUERIES.AddProductsToFavoriteList,
    {
      favoriteListId: String(listId).toUpperCase(),
      products: [{ productId: item.productId, quantity: item.quantity || 1 }],
    }
  );

  const res = resp?.data?.favoriteListProductsAddV2;
  if (res?.status && res.status !== "SUCCESS") {
    throw new Error(
      `Failed to add item to favorite list: ${res.errorMessage || res.status}`
    );
  }
  return res;
}

export async function setFavoriteListItemChecked(
  t: AhTransport,
  _listId: string,
  itemId: string,
  checked: boolean = true
): Promise<any> {
  return await t.request<any>(`/mobile-services/lists/v3/lists/items/${itemId}`, {
    method: "PATCH",
    body: { checked },
  });
}

export async function removeFavoriteListItem(
  t: AhTransport,
  listId: string,
  itemId: string
): Promise<any> {
  const resp = await t.graphql<any>(
    "DeleteProductsFromFavoriteList",
    GRAPHQL_QUERIES.DeleteProductsFromFavoriteList,
    {
      favoriteListId: String(listId).toUpperCase(),
      itemIds: [itemId],
    }
  );

  const res = resp?.data?.favoriteListProductsDeleteV2;
  if (res?.status && res.status !== "SUCCESS") {
    throw new Error(
      `Failed to remove item from favorite list: ${res.errorMessage || res.status}`
    );
  }
  return res;
}
