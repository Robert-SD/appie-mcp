import { AUTH_CONFIG, authFetch, getValidAccessToken, loadTokens } from "./auth.js";
import { CacheStats, TtlCache, cacheKey, getSharedCache } from "./cache.js";
import { CACHE_TTL, cacheKeyFor, cachePolicyFor } from "./cache-policy.js";
import { mapProduct } from "./mappers.js";
import * as bonus from "./services/bonus.js";
import * as catalog from "./services/catalog.js";
import * as lists from "./services/lists.js";
import * as receipts from "./services/receipts.js";
import * as recipes from "./services/recipes.js";
import * as stores from "./services/stores.js";
import { AhTransport, GraphqlOptions, RequestOptions } from "./services/transport.js";
import {
  AhProduct,
  CartSummary,
  Category,
  ClearanceBargain,
  FavoriteList,
  MemberProfile,
  PromoDigestResult,
  Receipt,
  Recipe,
  ShoppingList,
  StoreInfo,
} from "./types.js";

export { CACHE_TTL };

export class AhClient {
  private readonly baseUrl: string;
  private readonly cache: TtlCache;
  private lastAuthScope: string | null = null;
  private readonly transport: AhTransport;

  constructor(baseUrl: string = AUTH_CONFIG.api_base, cache?: TtlCache) {
    this.baseUrl = baseUrl;
    this.cache = cache ?? getSharedCache();
    this.transport = {
      request: (endpoint, options) => this.request(endpoint, options),
      graphql: (operationName, query, variables, options) =>
        this.graphql(operationName, query, variables, options),
      invalidateCache: (prefix) => this.cache.invalidate(prefix),
    };
  }

  cacheStats(): CacheStats {
    return this.cache.stats();
  }

  /**
   * Fingerprint of the principal in use so re-logins never serve another
   * account's cache, while ephemeral anonymous tokens stay stable across calls.
   */
  private async authScope(): Promise<string> {
    const tokens = await loadTokens();
    const principal = tokens?.refresh_token || tokens?.access_token;
    const scope = principal
      ? cacheKey("auth", [principal]).split(" ").pop()!
      : "anonymous";
    if (this.lastAuthScope !== null && this.lastAuthScope !== scope) {
      this.cache.clear();
    }
    this.lastAuthScope = scope;
    return scope;
  }

  async request<T = any>(
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const policy = cachePolicyFor(endpoint, options);
    if (policy === null) {
      return await this.performRequest<T>(endpoint, options);
    }

    const token = await getValidAccessToken();
    const scope = await this.authScope();
    const key = cacheKeyFor(this.baseUrl, endpoint, options, scope);
    return await this.cache.wrap<T>(
      key,
      policy.ttl,
      () => this.performRequest<T>(endpoint, options, token),
      policy.shouldCache
    );
  }

  private async performRequest<T = any>(
    endpoint: string,
    options: RequestOptions = {},
    token?: string
  ): Promise<T> {
    const authToken = token ?? (await getValidAccessToken());
    const method = options.method || "GET";

    let urlStr = endpoint.startsWith("http")
      ? endpoint
      : `${this.baseUrl}${endpoint}`;
    if (options.query) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) {
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item !== undefined && item !== null && item !== "") {
              sp.append(k, String(item));
            }
          }
        } else if (v !== undefined && v !== null && v !== "") {
          sp.set(k, String(v));
        }
      }
      const qs = sp.toString();
      if (qs) {
        urlStr += (urlStr.includes("?") ? "&" : "?") + qs;
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${authToken}`,
      Accept: "application/json",
    };

    let bodyStr: string | undefined;
    if (options.body) {
      headers["Content-Type"] = "application/json";
      bodyStr =
        typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);
    }

    const resp = await authFetch(urlStr, {
      method,
      headers,
      body: bodyStr,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const err = new Error(
        `Albert Heijn API error (${resp.status}) at ${endpoint}: ${errText}`
      );
      (err as any).status = resp.status;
      throw err;
    }

    return (await resp.json()) as T;
  }

  private static formatGraphQlErrors(errors: any[]): string {
    return errors.map((e) => e?.message || JSON.stringify(e)).join("; ");
  }

  private async graphql<T = any>(
    operationName: string,
    query: string,
    variables?: Record<string, any>,
    options?: GraphqlOptions
  ): Promise<T> {
    const resp = await this.request<any>("/graphql", {
      method: "POST",
      body: {
        operationName,
        ...(variables ? { variables } : {}),
        query,
      },
    });
    if (Array.isArray(resp?.errors) && resp.errors.length > 0) {
      const allowed = options?.allowPartialErrorPaths;
      const isExpectedPartial =
        allowed?.length &&
        resp.errors.every(
          (e: any) =>
            Array.isArray(e?.path) &&
            e.path.length === 1 &&
            allowed.includes(String(e.path[0])) &&
            (resp?.data == null || resp.data[e.path[0]] == null)
        );
      if (!isExpectedPartial) {
        throw new Error(
          `Albert Heijn GraphQL error at ${operationName}: ${AhClient.formatGraphQlErrors(resp.errors)}`
        );
      }
    }
    return resp as T;
  }

  // 1. Member Profile
  getProfile = (): Promise<MemberProfile> => stores.getProfile(this.transport);

  // 2. Catalog & Product Search
  searchProducts = (options: {
    query: string;
    sort?: "RELEVANCE" | "PRICE_ASC" | "PRICE_DESC";
    page?: number;
    size?: number;
    bonusOnly?: boolean;
  }): Promise<{ products: AhProduct[]; total: number }> =>
    catalog.searchProducts(this.transport, options);

  getProduct = (productId: string | number): Promise<AhProduct> =>
    catalog.getProduct(this.transport, productId);

  getProductAlternatives = (
    productId: string | number
  ): Promise<AhProduct[]> =>
    catalog.getProductAlternatives(this.transport, productId);

  getProductsBulk = (
    productIds: Array<string | number>
  ): Promise<AhProduct[]> =>
    catalog.getProductsBulk(this.transport, productIds);

  getCategories = (): Promise<Category[]> =>
    catalog.getCategories(this.transport);

  getSubCategories = (categoryId: string | number): Promise<Category[]> =>
    catalog.getSubCategories(this.transport, categoryId);

  // 3. Bonus Deals & Promotions
  getBonusOffers = (
    query?: string,
    page?: number,
    size?: number
  ): Promise<AhProduct[]> =>
    bonus.getBonusOffers(this.transport, query, page, size);

  getBonusGroupProducts = (segmentId: number | string): Promise<AhProduct[]> =>
    bonus.getBonusGroupProducts(this.transport, segmentId);

  getPersonalBonus = (): Promise<any[]> =>
    bonus.getPersonalBonus(this.transport);

  getClearanceBargains = (storeId: number): Promise<ClearanceBargain[]> =>
    bonus.getClearanceBargains(this.transport, storeId);

  // 4. Shopping Lists (Main & Favorites)
  getShoppingList = (): Promise<ShoppingList> =>
    lists.getShoppingList(this.transport);

  addShoppingListItems = (
    items: Array<{
      type?: "FREE_TEXT" | "PRODUCT";
      text?: string;
      productId?: number;
      quantity?: number;
    }>
  ): Promise<any> => lists.addShoppingListItems(this.transport, items);

  removeShoppingListItem = (itemId: string | number): Promise<any> =>
    lists.removeShoppingListItem(this.transport, itemId);

  getFavoriteLists = (): Promise<FavoriteList[]> =>
    lists.getFavoriteLists(this.transport);

  addFavoriteListItem = (
    listId: string,
    item: { productId: number; quantity?: number; originCode?: string }
  ): Promise<any> => lists.addFavoriteListItem(this.transport, listId, item);

  setFavoriteListItemChecked = (
    listId: string,
    itemId: string,
    checked?: boolean
  ): Promise<any> =>
    lists.setFavoriteListItemChecked(this.transport, listId, itemId, checked);

  removeFavoriteListItem = (listId: string, itemId: string): Promise<any> =>
    lists.removeFavoriteListItem(this.transport, listId, itemId);

  // 5. Digital Receipts (Kassabonnen)
  listReceipts = (page?: number, size?: number): Promise<Receipt[]> =>
    receipts.listReceipts(this.transport, page, size);

  getReceiptDetails = (transactionId: string): Promise<Receipt> =>
    receipts.getReceiptDetails(this.transport, transactionId);

  // 6. Habit-Based Deals (Promo Digest)
  getPromoDigest = (options?: {
    days?: number;
    minTimes?: number;
    limit?: number;
  }): Promise<PromoDigestResult> =>
    receipts.getPromoDigest(this.transport, options);

  // 7. Allerhande Recipes
  searchRecipes = (
    query: string,
    page?: number,
    size?: number
  ): Promise<Recipe[]> => recipes.searchRecipes(this.transport, query, page, size);

  getRecipeDetails = (
    recipeId: string | number
  ): Promise<Recipe | { error: string; message: string }> =>
    recipes.getRecipeDetails(this.transport, recipeId);

  // 8. Store Locator & Cart
  searchStores = (postalCodeOrCity?: string): Promise<StoreInfo[]> =>
    stores.searchStores(this.transport, postalCodeOrCity);

  getCart = (): Promise<CartSummary> => stores.getCart(this.transport);

  // 9. Suggestions, Predictive Favorites & Bonus Box Activation
  getSearchSuggestions = (
    query: string,
    amount?: number
  ): Promise<string[]> =>
    catalog.getSearchSuggestions(this.transport, query, amount);

  getPredictiveFavorites = (): Promise<AhProduct[]> =>
    bonus.getPredictiveFavorites(this.transport);

  activatePersonalBonus = (
    bonusCardNumber: string,
    selectedBonusIds: number[]
  ): Promise<any> =>
    bonus.activatePersonalBonus(
      this.transport,
      bonusCardNumber,
      selectedBonusIds
    );

  mapProduct = (raw: any): AhProduct => mapProduct(raw);
}
