import { AUTH_CONFIG, authFetch, getValidAccessToken, loadTokens } from "./auth.js";
import { CacheStats, TtlCache, cacheKey, getSharedCache } from "./cache.js";
import {
  AhProduct,
  BonusOffer,
  FavoriteList,
  MemberProfile,
  Receipt,
  Recipe,
  ShoppingList,
  ShoppingListItem,
  StoreInfo,
} from "./types.js";

/**
/**
 * Cache TTLs in milliseconds. Only immutable or slow-moving upstream data is
 * cached — user state (profile, cart, shopping lists, receipt overview) is
 * always fetched live.
 */
export const CACHE_TTL = {
  /** Search results and promo prices: offers churn daily. */
  search: 30 * 60 * 1000,
  /** Product detail: a product's page is stable for a day. */
  productDetail: 24 * 60 * 60 * 1000,
  /** Categories, stores, recipes: near-static reference data. */
  catalog: 24 * 60 * 60 * 1000,
  /** Bonus folder, personal bonus box, clearance, predictive favorites. */
  offers: 30 * 60 * 1000,
  /** A closed receipt is immutable; 30 days covers post-purchase corrections. */
  receiptDetail: 30 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Albert Heijn's receipt feed is offset/limit paginated and rejects a limit
 * above 100, so larger windows have to be walked in server-sized chunks.
 */
const AH_RECEIPTS_MAX_LIMIT = 100;

/**
 * How far the promo digest may walk back: pages of 50 receipts, bounded because
 * every receipt in the window costs one details call.
 */
const AH_DIGEST_PAGE_SIZE = 50;
const AH_DIGEST_MAX_RECEIPTS = 150;

export class AhClient {
  private readonly baseUrl: string;
  private readonly cache: TtlCache;
  private lastAuthScope: string | null = null;

  constructor(baseUrl: string = AUTH_CONFIG.api_base, cache?: TtlCache) {
    this.baseUrl = baseUrl;
    this.cache = cache ?? getSharedCache();
  }

  cacheStats(): CacheStats {
    return this.cache.stats();
  }

  /**
   * Fingerprint of the principal in use. It keeps a re-login (a new token
   * file) from serving the previous account's cached data, and it clears the
   * cache when the principal actually changes. The raw credential never
   * appears in the key: only its digest does.
   *
   * Scope is keyed on the stored member session, never on the bearer token
   * handed to this call: an anonymous session mints a throwaway token per
   * request, so keying on it changed the scope — and wiped the whole cache —
   * before every single lookup, leaving `hits` permanently at 0. A member's
   * refresh token survives access-token rotation, so the scope stays stable
   * until a genuinely different account logs in.
   */
  private authScope(): string {
    const tokens = loadTokens();
    const principal = tokens?.refresh_token || tokens?.access_token;
    const scope = principal ? cacheKey("auth", [principal]).split(" ").pop()! : "anonymous";
    if (this.lastAuthScope !== null && this.lastAuthScope !== scope) {
      this.cache.clear();
    }
    this.lastAuthScope = scope;
    return scope;
  }

  /**
   * TTL for an endpoint, or `null` when the response must never be cached.
   * Allowlist by route: a new endpoint is uncached until it is classified.
   *
   * `shouldCache` rejects a *successful* response that carries a domain-level
   * failure (a null receipt, an empty product card). Such a payload must stay
   * retryable instead of being replayed for the whole TTL.
   */
  private cachePolicyFor(
    endpoint: string,
    options: { method?: string; body?: any; query?: Record<string, any> }
  ): { ttl: number; shouldCache?: (payload: any) => boolean } | null {
    const method = (options.method || "GET").toUpperCase();

    if (method !== "GET") {
      if (endpoint !== "/graphql") return null;
      const operationName = options.body?.operationName;
      if (operationName === "FetchPosReceiptsDetails") {
        return {
          ttl: CACHE_TTL.receiptDetail,
          shouldCache: (payload: any) => Boolean(payload?.data?.posReceiptDetails),
        };
      }
      if (operationName === "GetBargainItems") {
        return {
          ttl: CACHE_TTL.offers,
          // An unknown store answers with a null store; that must stay
          // retryable instead of being replayed as "no bargains".
          shouldCache: (payload: any) => Boolean(payload?.data?.store),
        };
      }
      // FetchMember (profile) and FetchPosReceiptsPage (receipt overview) are
      // live-only: they carry personal data or a list that changes.
      return null;
    }

    if (endpoint.startsWith("http")) return null;

    if (endpoint.startsWith("/mobile-services/product/search/v2/suggestions")) {
      return { ttl: CACHE_TTL.search };
    }
    if (endpoint.startsWith("/mobile-services/product/search/v2")) {
      return { ttl: CACHE_TTL.search };
    }
    if (endpoint.startsWith("/mobile-services/product/detail/v4/products")) {
      return {
        ttl: CACHE_TTL.productDetail,
        shouldCache: AhClient.isCacheableProductPayload,
      };
    }
    if (endpoint.startsWith("/mobile-services/v1/product-shelves/categories")) {
      return { ttl: CACHE_TTL.catalog };
    }
    if (endpoint.startsWith("/mobile-services/recipe/v2")) {
      return { ttl: CACHE_TTL.catalog };
    }
    if (endpoint.startsWith("/mobile-services/store/v1/stores")) {
      return { ttl: CACHE_TTL.catalog };
    }
    if (endpoint.startsWith("/mobile-services/bonus-group/v1/segments/")) {
      return { ttl: CACHE_TTL.offers };
    }
    if (endpoint.startsWith("/mobile-services/bonusbox/v1")) {
      return { ttl: CACHE_TTL.offers };
    }
    if (endpoint.startsWith("/favorieten/predictive-list")) {
      return { ttl: CACHE_TTL.offers };
    }

    // Shopping list, favorite lists, cart and every unknown route stay live.
    return null;
  }

  /**
   * A product payload is cacheable only when it actually carries a product.
   * The detail route answers `{ productCard }`, the alternatives route an
   * array, and the bulk route an array or `{ products: [...] }` — a payload
   * that carries none of these is a failed lookup, not a product.
   */
  private static isCacheableProductPayload(payload: any): boolean {
    if (Array.isArray(payload)) return payload.length > 0;
    if (Array.isArray(payload?.products)) return payload.products.length > 0;
    return Boolean(
      payload?.productCard?.id ?? payload?.productCard?.webshopId ?? payload?.id
    );
  }

  private cacheKeyFor(
    endpoint: string,
    options: { method?: string; body?: any; query?: Record<string, any> },
    scope: string
  ): string {
    const method = (options.method || "GET").toUpperCase();
    // The cache is shared by every client in the process, so the host is part
    // of the digest: two clients pointed at different bases must never trade
    // entries. Invalidation stays prefix-based on `<METHOD> <path>`.
    const host = this.baseUrl;

    if (method === "GET") {
      const query = Object.entries(options.query ?? {})
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => [k, String(v)] as [string, string])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return cacheKey(`${method} ${endpoint}`, [host, scope, query]);
    }

    const body = options.body ?? {};
    return cacheKey(`${method} ${endpoint}`, [
      host,
      scope,
      body.operationName ?? "",
      // The document text is part of the key: two documents can share an
      // operation name and variables while requesting different fields.
      typeof body.query === "string" ? body.query : "",
      body.variables ?? {},
    ]);
  }

  async request<T = any>(
    endpoint: string,
    options: { method?: string; body?: any; query?: Record<string, any> } = {}
  ): Promise<T> {
    const policy = this.cachePolicyFor(endpoint, options);
    if (policy === null) {
      return await this.performRequest<T>(endpoint, options);
    }

    const token = await getValidAccessToken();
    const scope = this.authScope();
    const key = this.cacheKeyFor(endpoint, options, scope);
    return await this.cache.wrap<T>(
      key,
      policy.ttl,
      () => this.performRequest<T>(endpoint, options, token),
      policy.shouldCache
    );
  }

  private async performRequest<T = any>(
    endpoint: string,
    options: { method?: string; body?: any; query?: Record<string, any> } = {},
    token?: string
  ): Promise<T> {
    const authToken = token ?? (await getValidAccessToken());
    const method = options.method || "GET";

    let urlStr = endpoint.startsWith("http") ? endpoint : `${this.baseUrl}${endpoint}`;
    if (options.query) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null && v !== "") {
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
      bodyStr = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }

    const resp = await authFetch(urlStr, {
      method,
      headers,
      body: bodyStr,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const err = new Error(`Albert Heijn API error (${resp.status}) at ${endpoint}: ${errText}`);
      (err as any).status = resp.status;
      throw err;
    }

    return (await resp.json()) as T;
  }

  /**
   * 1. Member Profile & Bonus Card
   */
  async getProfile(): Promise<MemberProfile> {
    const graphqlQuery = {
      query: `query FetchMember {
        member {
          id
          emailAddress
          name {
            first
            last
          }
          loyaltyCards {
            loyaltyCards {
              cardNumber
              type
              barcodeNumber
            }
          }
        }
      }`,
      operationName: "FetchMember",
    };

    const resp = await this.request<any>("/graphql", {
      method: "POST",
      body: graphqlQuery,
    });

    const member = resp.data?.member;
    if (!member) {
      return {};
    }

    const cards = member.loyaltyCards?.loyaltyCards || [];
    const bonusCard = cards.find((c: any) => c.type === "BONUS") || cards[0];
    const fullName = [member.name?.first, member.name?.last].filter(Boolean).join(" ").trim() || undefined;

    return {
      name: fullName,
      email: member.emailAddress || undefined,
      bonusCardNumber: bonusCard?.cardNumber || bonusCard?.barcodeNumber || undefined,
      hasBonusCard: Boolean(bonusCard?.cardNumber || bonusCard?.barcodeNumber),
      memberId: member.id !== undefined && member.id !== null ? String(member.id) : undefined,
    };
  }

  /**
   * 2. Catalog & Product Search
   */
  async searchProducts(options: {
    query: string;
    sort?: "RELEVANCE" | "PRICE_ASC" | "PRICE_DESC";
    page?: number;
    size?: number;
    bonusOnly?: boolean;
  }): Promise<{ products: AhProduct[]; total: number }> {
    const queryParams: Record<string, any> = {
      query: options.query,
      sortOn: options.sort || "RELEVANCE",
      page: options.page ?? 0,
      size: options.size ?? 20,
    };
    if (options.bonusOnly) {
      queryParams.filter = "bonus=Bonus";
    }

    const data = await this.request<any>("/mobile-services/product/search/v2", {
      query: queryParams,
    });

    const rawProducts = data.products || [];
    const products: AhProduct[] = rawProducts.map((p: any) => this.mapProduct(p));

    return {
      products,
      total: data.page?.totalElements ?? products.length,
    };
  }

  async getProduct(productId: string | number): Promise<AhProduct> {
    const cleanId = String(productId).replace(/^wi/, "");
    const data = await this.request<any>(`/mobile-services/product/detail/v4/products/${cleanId}`);
    return this.mapProduct(data.productCard || data);
  }

  async getProductAlternatives(productId: string | number): Promise<AhProduct[]> {
    const cleanId = String(productId).replace(/^wi/, "");
    const data = await this.request<any[]>(
      `/mobile-services/product/detail/v4/products/${cleanId}/alternatives`
    );
    if (!Array.isArray(data)) return [];
    return data.map((p: any) => this.mapProduct(p));
  }

  async getProductsBulk(productIds: Array<string | number>): Promise<AhProduct[]> {
    const ids = productIds.map((id) => String(id).replace(/^wi/, "")).join(",");
    const data = await this.request<any>(
      `/mobile-services/product/detail/v4/products/bulk`,
      { query: { productIds: ids } }
    );
    const rawList = Array.isArray(data) ? data : data.products || [];
    return rawList.map((p: any) => this.mapProduct(p));
  }

  async getCategories(): Promise<any[]> {
    return await this.request<any[]>("/mobile-services/v1/product-shelves/categories");
  }

  async getSubCategories(categoryId: string | number): Promise<any[]> {
    return await this.request<any[]>(
      `/mobile-services/v1/product-shelves/categories/${categoryId}/sub-categories`
    );
  }

  /**
   * 3. Bonus Deals & Promotions
   */
  async getBonusOffers(query: string = "", page: number = 0, size: number = 30): Promise<AhProduct[]> {
    const res = await this.searchProducts({
      query,
      bonusOnly: true,
      page,
      size,
    });
    return res.products;
  }

  async getBonusGroupProducts(segmentId: number | string): Promise<AhProduct[]> {
    const data = await this.request<any>(
      `/mobile-services/bonus-group/v1/segments/${segmentId}/products`
    );
    const rawProducts = data.products || (Array.isArray(data) ? data : []);
    return rawProducts.map((p: any) => this.mapProduct(p));
  }

  async getPersonalBonus(): Promise<any[]> {
    const data = await this.request<any>("/mobile-services/bonusbox/v1");
    return data.bonusBox || data.offers || (Array.isArray(data) ? data : []);
  }

  async getClearanceBargains(storeId: number): Promise<any[]> {
    const graphqlQuery = {
      query: `query GetBargainItems($storeId: Int!) {
        store(id: $storeId) {
          id
          bargainItems {
            productId
            title
            wasPrice
            nowPrice
            discountPercentage
            expirationDate
            stockStatus
          }
        }
      }`,
      operationName: "GetBargainItems",
      variables: { storeId },
    };

    const resp = await this.request<any>("/graphql", {
      method: "POST",
      body: graphqlQuery,
    });
    return resp.data?.store?.bargainItems || [];
  }

  /**
   * 4. Shopping Lists (Main & Favorites)
   */
  async getShoppingList(): Promise<ShoppingList> {
    try {
      const data = await this.request<any>("/mobile-services/shoppinglist/v2");
      const rawItems = data.items || [];
      const items: ShoppingListItem[] = rawItems.map((item: any) => ({
        id: item.id || item.listItemId,
        type: item.type || (item.product ? "PRODUCT" : "FREE_TEXT"),
        text: item.text || item.product?.title,
        productId: item.productId || item.product?.id,
        product: item.product ? this.mapProduct(item.product) : undefined,
        quantity: item.quantity || 1,
        checked: Boolean(item.checked),
      }));

      return {
        id: data.id,
        items,
        totalItems: items.length,
      };
    } catch (err: any) {
      if (err.status === 404) {
        try {
          const profile = await this.getProfile();
          if (profile.bonusCardNumber) {
            const data = await this.request<any>(
              `https://api.ah.nl/handscanner/v1/lists?bonusCardNumber=${profile.bonusCardNumber}`
            );
            const list = (data.lists || [])[0] || {};
            const rawItems = list.items || [];
            const items: ShoppingListItem[] = rawItems.map((item: any) => ({
              id: item.id || item.listItemId,
              type: item.type || (item.product ? "PRODUCT" : "FREE_TEXT"),
              text: item.text || item.product?.title,
              productId: item.productId || item.product?.id,
              product: item.product ? this.mapProduct(item.product) : undefined,
              quantity: item.quantity || 1,
              checked: Boolean(item.checked),
            }));
            return {
              id: list.id,
              items,
              totalItems: items.length,
            };
          }
        } catch {
          // ignore fallback error and throw original error
        }
      }
      throw err;
    }
  }

  async addShoppingListItems(
    items: Array<{ type?: "FREE_TEXT" | "PRODUCT"; text?: string; productId?: number; quantity?: number }>
  ): Promise<any> {
    const payload = {
      items: items.map((i) => ({
        type: i.type || (i.productId ? "PRODUCT" : "FREE_TEXT"),
        text: i.text,
        productId: i.productId,
        quantity: i.quantity || 1,
      })),
    };
    const res = await this.request<any>("/mobile-services/shoppinglist/v2/items", {
      method: "POST",
      body: payload,
    });
    this.cache.invalidate("GET /mobile-services/shoppinglist");
    return res;
  }

  async removeShoppingListItem(itemId: string | number): Promise<any> {
    const res = await this.request<any>(`/mobile-services/shoppinglist/v2/items/${itemId}`, {
      method: "DELETE",
    });
    this.cache.invalidate("GET /mobile-services/shoppinglist");
    return res;
  }

  async getFavoriteLists(): Promise<FavoriteList[]> {
    const data = await this.request<any[]>("/mobile-services/lists/v3/lists");
    if (!Array.isArray(data)) return [];
    return data.map((l: any) => ({
      id: l.id,
      title: l.title || l.name,
      itemCount: l.itemCount || l.items?.length || 0,
      items: l.items?.map((item: any) => ({
        id: item.id,
        type: "PRODUCT",
        text: item.product?.title || item.title,
        productId: item.productId || item.product?.id,
        checked: Boolean(item.checked),
        quantity: item.quantity || 1,
      })),
    }));
  }

  async addFavoriteListItem(
    listId: string,
    item: { productId: number; quantity?: number; originCode?: string }
  ): Promise<any> {
    const res = await this.request<any>(`/mobile-services/lists/v3/lists/${listId}/items`, {
      method: "POST",
      body: {
        originCode: item.originCode || "SEARCH",
        productId: item.productId,
        quantity: item.quantity || 1,
      },
    });
    this.cache.invalidate("GET /mobile-services/lists/v3");
    return res;
  }

  async setFavoriteListItemChecked(
    listId: string,
    itemId: string,
    checked: boolean = true
  ): Promise<any> {
    const res = await this.request<any>(
      `/mobile-services/lists/v3/lists/${listId}/items/${itemId}`,
      {
        method: "PATCH",
        body: { checked },
      }
    );
    this.cache.invalidate("GET /mobile-services/lists/v3");
    return res;
  }

  async removeFavoriteListItem(listId: string, itemId: string): Promise<any> {
    const res = await this.request<any>(
      `/mobile-services/lists/v3/lists/${listId}/items/${itemId}`,
      {
        method: "DELETE",
      }
    );
    this.cache.invalidate("GET /mobile-services/lists/v3");
    return res;
  }

  /**
   * 5. Digital Receipts (Kassabonnen)
   */
  async listReceipts(page: number = 0, size: number = 10): Promise<Receipt[]> {
    const wanted = Math.max(1, Math.trunc(size));
    const first = Math.max(0, Math.trunc(page)) * wanted;
    const receipts: Receipt[] = [];

    for (let fetched = 0; fetched < wanted; ) {
      const limit = Math.min(wanted - fetched, AH_RECEIPTS_MAX_LIMIT);
      const resp = await this.request<any>("/graphql", {
        method: "POST",
        body: {
          query: `query FetchPosReceiptsPage($pagination: OffsetLimitPagination!) {
        posReceiptsPage(pagination: $pagination) {
          pagination {
            totalElements
          }
          posReceipts {
            id
            dateTime
            storeAddress {
              street
              houseNumber
              postalCode
              city
            }
            totalAmount {
              amount
            }
          }
        }
      }`,
          variables: { pagination: { offset: first + fetched, limit } },
          operationName: "FetchPosReceiptsPage",
        },
      });

      const rawList = resp.data?.posReceiptsPage?.posReceipts;
      if (!Array.isArray(rawList) || rawList.length === 0) break;

      receipts.push(
        ...rawList.map((r: any) => {
          const addr = r.storeAddress;
          const storeName = addr
            ? `AH ${addr.street || ""}${addr.houseNumber ? " " + addr.houseNumber : ""}${addr.city ? ", " + addr.city : ""}`.trim()
            : undefined;

          return {
            transactionId: r.id,
            transactionDate: r.dateTime,
            total: r.totalAmount?.amount ?? 0,
            storeName: storeName || undefined,
          };
        })
      );

      fetched += rawList.length;
      if (rawList.length < limit) break;
    }

    return receipts;
  }

  /**
   * Receipts newer than `cutoff`, oldest last. The digest used to read a fixed
   * window of 30 receipts, so a 365-day ask really only saw the newest 30 trips;
   * this walks pages until the cutoff is crossed or `AH_DIGEST_MAX_RECEIPTS`
   * bounds the walk, because every receipt costs one details call.
   */
  private async listReceiptsInWindow(cutoff: number): Promise<Receipt[]> {
    const collected: Receipt[] = [];

    for (let page = 0; collected.length < AH_DIGEST_MAX_RECEIPTS; page++) {
      const batch = await this.listReceipts(page, AH_DIGEST_PAGE_SIZE);
      if (batch.length === 0) break;

      collected.push(...batch);
      const oldest = new Date(batch[batch.length - 1].transactionDate).getTime();
      if (oldest < cutoff) break;
      if (batch.length < AH_DIGEST_PAGE_SIZE) break;
    }

    return collected.slice(0, AH_DIGEST_MAX_RECEIPTS);
  }

  async getReceiptDetails(transactionId: string): Promise<Receipt> {
    const graphqlQuery = {
      query: `query FetchPosReceiptsDetails($id: String!) {
        posReceiptDetails(id: $id) {
          total {
            amount
          }
          subtotalProducts {
            amount {
              amount
            }
          }
          subtotalDiscount {
            amount
          }
          transaction {
            dateTime
          }
          products {
            name
            quantity
            amount {
              amount
            }
            price {
              amount
            }
          }
        }
      }`,
      variables: { id: transactionId },
      operationName: "FetchPosReceiptsDetails",
    };

    const resp = await this.request<any>("/graphql", {
      method: "POST",
      body: graphqlQuery,
    });

    const details = resp.data?.posReceiptDetails;
    if (!details) {
      throw new Error(`Receipt details not found for transaction ID: ${transactionId}`);
    }

    const rawProducts = details.products || [];
    const lines = rawProducts.map((p: any) => {
      const lineTotal = p.amount?.amount ?? 0;
      const unitPrice =
        p.price?.amount ?? (p.quantity && p.quantity > 1 ? lineTotal / p.quantity : lineTotal);
      return {
        description: p.name || "",
        quantity: p.quantity ?? 1,
        price: lineTotal,
        unitPrice: unitPrice,
      };
    });

    return {
      transactionId,
      transactionDate: details.transaction?.dateTime || "",
      total: details.total?.amount ?? 0,
      totalDiscount: details.subtotalDiscount?.amount,
      lines,
    };
  }

  /**
   * 6. Habit-Based Deals (Promo Digest)
   * Mines recent receipts for frequently bought products, and reports those currently on sale.
   */
  async getPromoDigest(options: {
    days?: number;
    minTimes?: number;
    limit?: number;
  } = {}): Promise<any> {
    const days = options.days || 90;
    const minTimes = options.minTimes || 2;
    const limit = options.limit || 25;

    const cutoff = Date.now() - days * 86400 * 1000;
    const receipts = await this.listReceiptsInWindow(cutoff);
    const itemCounts = new Map<string, { count: number; name: string }>();

    for (const r of receipts) {
      const rTime = new Date(r.transactionDate).getTime();
      if (rTime < cutoff) continue;
      try {
        const details = await this.getReceiptDetails(r.transactionId);
        for (const line of details.lines || []) {
          const key = line.description.trim().toLowerCase();
          if (!key || line.price <= 0) continue;
          const prev = itemCounts.get(key) || { count: 0, name: line.description };
          prev.count += 1;
          itemCounts.set(key, prev);
        }
      } catch {
        // Skip inaccessible receipts
      }
    }

    const frequent = Array.from(itemCounts.values())
      .filter((x) => x.count >= minTimes)
      .sort((a, b) => b.count - a.count);

    const bonusOffers = await this.getBonusOffers();
    const digestResults: any[] = [];

    for (const item of frequent) {
      if (digestResults.length >= limit) break;
      // Search for live product pricing & promotions
      try {
        const searchRes = await this.searchProducts({ query: item.name, size: 3 });
        const match = searchRes.products.find((p) => p.bonus);
        if (match) {
          digestResults.push({
            frequentItem: item.name,
            purchasedTimes: item.count,
            matchedProduct: match.title,
            currentPrice: match.price.now,
            regularPrice: match.price.was,
            discountType: match.discountType,
            bonusMechanism: match.bonusMechanism,
          });
        }
      } catch {
        // Skip
      }
    }

    return {
      frequentProductsFound: frequent.length,
      currentOffersFound: digestResults.length,
      offers: digestResults,
    };
  }

  /**
   * 7. Allerhande Recipes
   */
  async searchRecipes(query: string, page: number = 0, size: number = 10): Promise<Recipe[]> {
    try {
      const data = await this.request<any>("/mobile-services/recipe/v2/search", {
        query: { query, page, size },
      });
      const rawList = data.recipes || (Array.isArray(data) ? data : []);
      return rawList.map((r: any) => ({
        id: r.id,
        title: r.title || r.name,
        servings: r.servings,
        prepTimeMinutes: r.prepTime || r.cookingTime,
        imageUrl: r.image?.url || r.imageUrl,
        ingredients: (r.ingredients || []).map((ing: any) => ({
          name: ing.name || ing.ingredient,
          amount: ing.amount,
          unit: ing.unit,
          productId: ing.productId,
        })),
      }));
    } catch (error: any) {
      if (
        error?.status === 404 ||
        error?.message?.includes("(404)") ||
        error?.message?.toLowerCase().includes("not found")
      ) {
        return [];
      }
      throw error;
    }
  }

  async getRecipeDetails(recipeId: string | number): Promise<Recipe | { error: string; message: string }> {
    try {
      const data = await this.request<any>(`/mobile-services/recipe/v2/${recipeId}`);
      return {
        id: data.id || recipeId,
        title: data.title || data.name,
        servings: data.servings,
        prepTimeMinutes: data.prepTime || data.cookingTime,
        imageUrl: data.image?.url || data.imageUrl,
        instructions: data.instructions || data.steps || [],
        ingredients: (data.ingredients || []).map((ing: any) => ({
          name: ing.name || ing.ingredient,
          amount: ing.amount,
          unit: ing.unit,
          productId: ing.productId,
          available: ing.available,
        })),
      };
    } catch (error: any) {
      if (
        error?.status === 404 ||
        error?.message?.includes("(404)") ||
        error?.message?.toLowerCase().includes("not found")
      ) {
        return {
          error: "Not Found",
          message: `Recipe not found for ID: ${recipeId}`,
        };
      }
      throw error;
    }
  }

  /**
   * 8. Store Locator
   */
  async searchStores(postalCodeOrCity?: string): Promise<StoreInfo[]> {
    const data = await this.request<any[]>("/mobile-services/store/v1/stores", {
      query: postalCodeOrCity ? { query: postalCodeOrCity } : undefined,
    });
    if (!Array.isArray(data)) return [];
    return data.map((s: any) => ({
      id: s.id,
      name: s.name || s.address?.street,
      street: s.address?.street || s.street,
      postalCode: s.address?.postalCode || s.postalCode,
      city: s.address?.city || s.city,
      distanceKm: s.distance,
      isOpenNow: s.isOpenNow,
      facilities: s.facilities || [],
    }));
  }

  /**
   * 9. Active Online Cart
   */
  async getCart(): Promise<any> {
    return await this.request<any>("/mobile-services/order/v1/cart");
  }

  /**
   * 10. Suggestions, Predictive Favorites & Bonus Box Activation
   */
  async getSearchSuggestions(query: string, amount: number = 10): Promise<string[]> {
    const data = await this.request<any>(
      "/mobile-services/product/search/v2/suggestions",
      { query: { query, amount } }
    );
    return data.suggestions || [];
  }

  async getPredictiveFavorites(): Promise<any[]> {
    const data = await this.request<any>("/favorieten/predictive-list");
    return Array.isArray(data) ? data : data.items || [];
  }

  async activatePersonalBonus(bonusCardNumber: string, selectedBonusIds: number[]): Promise<any> {
    const res = await this.request<any>("https://api.ah.nl/handscanner/v1/bonuses", {
      method: "PATCH",
      body: {
        bonusCardNumber,
        selectedBonusIds,
      },
    });
    this.cache.invalidate("GET /mobile-services/bonusbox");
    this.cache.invalidate("GET /favorieten/predictive-list");
    return res;
  }

  mapProduct(raw: any): AhProduct {
    const current = raw.currentPrice ?? raw.price?.now;
    const regular = raw.priceBeforeBonus ?? raw.price?.was ?? raw.previousPrice;
    const isDiscounted =
      current !== null &&
      current !== undefined &&
      regular !== null &&
      regular !== undefined &&
      current !== regular;

    return {
      id: raw.webshopId || raw.id || raw.webProductId,
      webProductId: raw.webshopId
        ? `wi${raw.webshopId}`
        : raw.webProductId
        ? `wi${raw.webProductId}`
        : undefined,
      title: raw.title || raw.name || "",
      summary:
        raw.summary ||
        raw.descriptionHighlights ||
        raw.descriptionFull ||
        raw.description,
      brand: raw.brand,
      price: {
        now: (isDiscounted ? current : (current ?? regular)) ?? 0,
        was: isDiscounted ? regular : undefined,
        unitSizeDescription:
          raw.salesUnitSize ||
          raw.price?.unitSizeDescription ||
          raw.unitSizeDescription,
        theme: raw.price?.theme,
      },
      unitPriceDescription:
        raw.unitPriceDescription || raw.price?.unitPriceDescription,
      bonus: Boolean(raw.isBonus || raw.bonus || raw.shield?.bonus || isDiscounted),
      bonusMechanism: raw.bonusMechanism || raw.shield?.text,
      discountType: raw.discountType || raw.price?.discountType,
      images: raw.images || (raw.image ? [raw.image] : []),
      category: raw.mainCategory || raw.category || raw.taxonomy?.name,
      availableOnline: raw.availableOnline,
    };
  }
}
