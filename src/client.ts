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
  private async authScope(): Promise<string> {
    const tokens = await loadTokens();
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
      if (endpoint === "/mobile-services/v2/recommendations/dontforgetlane") {
        return {
          ttl: CACHE_TTL.offers,
          shouldCache: (payload: any) =>
            Array.isArray(payload?.productCards) && payload.productCards.length > 0,
        };
      }
      if (endpoint !== "/graphql") return null;
      const operationName = options.body?.operationName;
      if (operationName === "FetchPosReceiptsDetails") {
        return {
          ttl: CACHE_TTL.receiptDetail,
          shouldCache: (payload: any) => Boolean(payload?.data?.posReceiptDetails),
        };
      }
      if (operationName === "BargainItems") {
        return {
          ttl: CACHE_TTL.offers,
          // Missing/empty store clearance answers with null or errors; keep retryable.
          shouldCache: (payload: any) =>
            !payload?.errors?.length &&
            Array.isArray(payload?.data?.bargainItems) &&
            payload.data.bargainItems.length > 0,
        };
      }
      if (operationName === "FetchProductDetails") {
        return {
          ttl: CACHE_TTL.productDetail,
          shouldCache: (payload: any) =>
            !payload?.errors?.length && Boolean(payload?.data?.product?.id),
        };
      }
      if (operationName === "FetchProductAlternatives") {
        return {
          ttl: CACHE_TTL.productDetail,
          shouldCache: (payload: any) =>
            !payload?.errors?.length &&
            Array.isArray(payload?.data?.productAlternatives?.products),
        };
      }
      if (operationName === "FetchCategories") {
        return {
          ttl: CACHE_TTL.catalog,
          shouldCache: (payload: any) =>
            !payload?.errors?.length &&
            Array.isArray(payload?.data?.productTopLevelTaxonomies) &&
            payload.data.productTopLevelTaxonomies.length > 0,
        };
      }
      if (operationName === "FetchSubCategories") {
        return {
          ttl: CACHE_TTL.catalog,
          shouldCache: (payload: any) =>
            !payload?.errors?.length &&
            Array.isArray(payload?.data?.productTaxonomyById) &&
            payload.data.productTaxonomyById.length > 0,
        };
      }
      if (operationName === "StoresSearch") {
        return {
          ttl: CACHE_TTL.catalog,
          shouldCache: (payload: any) =>
            !payload?.errors?.length &&
            Array.isArray(payload?.data?.storesSearch?.result),
        };
      }
      if (operationName === "FetchBonusPromotionWithProducts") {
        return {
          ttl: CACHE_TTL.offers,
          shouldCache: (payload: any) =>
            !payload?.errors?.length &&
            Array.isArray(payload?.data?.bonusPromotions),
        };
      }
      if (operationName === "FetchRecipes") {
        return {
          ttl: CACHE_TTL.catalog,
          shouldCache: (payload: any) =>
            !payload?.errors?.length &&
            Array.isArray(payload?.data?.recipeSearchV2?.result) &&
            payload.data.recipeSearchV2.result.length > 0,
        };
      }
      if (operationName === "FetchRecipeDetails") {
        return {
          ttl: CACHE_TTL.catalog,
          shouldCache: (payload: any) =>
            !payload?.errors?.length && Boolean(payload?.data?.recipe?.id),
        };
      }
      // FetchMember, FetchPosReceiptsPage, FetchMyListBasket, FetchFavoriteLists
      // carry personal or mutable user state and stay live-only.
      return null;
    }

    if (endpoint.startsWith("http")) return null;

    if (endpoint.startsWith("/mobile-services/product/search/v2/suggestions")) {
      return { ttl: CACHE_TTL.search };
    }
    if (endpoint.startsWith("/mobile-services/product/search/v2/products")) {
      return {
        ttl: CACHE_TTL.productDetail,
        shouldCache: AhClient.isCacheableProductPayload,
      };
    }
    if (endpoint.startsWith("/mobile-services/product/search/v2")) {
      return { ttl: CACHE_TTL.search };
    }
    if (endpoint.startsWith("/mobile-services/bonuspage/v3/metadata")) {
      return { ttl: CACHE_TTL.offers };
    }
    if (endpoint.startsWith("/mobile-services/bonuspage/v1/personal")) {
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
        .map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)] as [string, string | string[]])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return cacheKey(`${method} ${endpoint}`, [host, scope, query]);
    }

    const body = options.body ?? {};
    if (endpoint === "/graphql") {
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
    return cacheKey(`${method} ${endpoint}`, [host, scope, body]);
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
    const scope = await this.authScope();
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

  private async graphql<T = any>(
    operationName: string,
    query: string,
    variables?: Record<string, any>
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
      throw new Error(
        `Albert Heijn GraphQL error at ${operationName}: ${AhClient.formatGraphQlErrors(resp.errors)}`
      );
    }
    return resp as T;
  }

  async getProduct(productId: string | number): Promise<AhProduct> {
    const numericId = Number(String(productId).trim().replace(/^wi/i, ""));
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new Error(`Invalid product ID: ${productId}`);
    }

    const resp = await this.graphql<any>(
      "FetchProductDetails",
      `query FetchProductDetails($productId: Int!) {
        product(id: $productId) {
          id
          title
          brand
          category
          summary
          highlights
          additionalInformation
          icons
          salesUnitSize
          priceV2 {
            now { amount }
            was { amount }
            unitInfo { description price { amount formattedV2 } }
            discount { description promotionType }
            promotionLabel { tiers { mechanism description } }
          }
          availability {
            online { status }
            isOrderable
          }
          imagePack {
            large { url width height }
            medium { url width height }
            small { url width height }
          }
        }
      }`,
      { productId: numericId }
    );

    if (!resp?.data?.product) {
      throw new Error(`Product not found for ID: ${productId}`);
    }
    return this.mapGraphqlProduct(resp.data.product);
  }

  async getProductAlternatives(productId: string | number): Promise<AhProduct[]> {
    const numericId = Number(String(productId).trim().replace(/^wi/i, ""));
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new Error(`Invalid product ID: ${productId}`);
    }

    const resp = await this.graphql<any>(
      "FetchProductAlternatives",
      `query FetchProductAlternatives($productId: Int!, $size: PageSize!) {
        productAlternatives(id: $productId, size: $size) {
          products {
            id
            title
            brand
            category
            summary
            icons
            salesUnitSize
            priceV2 {
              now { amount }
              was { amount }
              unitInfo { description price { amount formattedV2 } }
              discount { description promotionType }
              promotionLabel { tiers { mechanism description } }
            }
            availability {
              online { status }
              isOrderable
            }
            imagePack {
              large { url width height }
              medium { url width height }
              small { url width height }
            }
          }
        }
      }`,
      { productId: numericId, size: 10 }
    );

    const rawList = resp?.data?.productAlternatives?.products;
    if (!Array.isArray(rawList)) return [];
    return rawList.map((p: any) => this.mapGraphqlProduct(p));
  }

  async getProductsBulk(productIds: Array<string | number>): Promise<AhProduct[]> {
    const ids = productIds.map((id) => String(id).trim().replace(/^wi/i, "")).filter(Boolean);
    if (ids.length === 0) return [];

    const data = await this.request<any>(
      "/mobile-services/product/search/v2/products",
      { query: { ids, sortOn: "INPUT_PRODUCT_IDS" } }
    );
    const rawList = Array.isArray(data) ? data : data?.products || [];
    return rawList.map((p: any) => this.mapProduct(p));
  }

  async getCategories(): Promise<any[]> {
    const resp = await this.graphql<any>(
      "FetchCategories",
      `query FetchCategories {
        productTopLevelTaxonomies {
          id
          name
          slug
          active
          totalProductCount
          topLevelImage
        }
      }`
    );
    return resp?.data?.productTopLevelTaxonomies || [];
  }

  async getSubCategories(categoryId: string | number): Promise<any[]> {
    const numericId = Number(String(categoryId).trim());
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new Error(`Invalid category ID: ${categoryId}`);
    }

    const resp = await this.graphql<any>(
      "FetchSubCategories",
      `query FetchSubCategories($id: Int!) {
        productTaxonomyById(id: $id) {
          id
          name
          slug
          active
          totalProductCount
          children
        }
      }`,
      { id: numericId }
    );
    const all = resp?.data?.productTaxonomyById;
    if (!Array.isArray(all)) return [];
    return all.filter((t: any) => Number(t?.id) !== numericId);
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

  private async getCurrentBonusPeriod(): Promise<{ startDate: string; endDate: string }> {
    const data = await this.request<any>("/mobile-services/bonuspage/v3/metadata");
    const period = data?.periods?.[0];
    if (!period?.bonusStartDate || !period?.bonusEndDate) {
      throw new Error("Could not determine current Albert Heijn bonus period");
    }
    return {
      startDate: period.bonusStartDate,
      endDate: period.bonusEndDate,
    };
  }

  async getBonusGroupProducts(segmentId: number | string): Promise<AhProduct[]> {
    const { startDate, endDate } = await this.getCurrentBonusPeriod();
    const resp = await this.graphql<any>(
      "FetchBonusPromotionWithProducts",
      `query FetchBonusPromotionWithProducts(
        $id: String
        $periodStart: String
        $periodEnd: String
        $filterUnavailableProducts: Boolean
        $forcePromotionVisibility: Boolean = true
        $showAllPromotionSegments: Boolean = true
      ) {
        bonusPromotions(
          input: {
            id: $id
            periodStart: $periodStart
            periodEnd: $periodEnd
            filterUnavailableProducts: $filterUnavailableProducts
            forcePromotionVisibility: $forcePromotionVisibility
            showAllPromotionSegments: $showAllPromotionSegments
          }
        ) {
          id
          title
          productCount
          products {
            id
            title
            brand
            category
            salesUnitSize
            icons
            availability { isOrderable online { status } }
            priceV2(
              periodStart: $periodStart
              periodEnd: $periodEnd
              filterUnavailableProducts: $filterUnavailableProducts
              forcePromotionVisibility: true
            ) {
              now { amount }
              was { amount }
              promotionLabel {
                tiers {
                  mechanism
                  description
                }
              }
            }
            imagePack {
              large { url width height }
              medium { url width height }
              small { url width height }
            }
          }
        }
      }`,
      {
        id: String(segmentId),
        periodStart: startDate,
        periodEnd: endDate,
        filterUnavailableProducts: true,
        forcePromotionVisibility: true,
        showAllPromotionSegments: true,
      }
    );

    const rawProducts = resp?.data?.bonusPromotions?.[0]?.products;
    if (!Array.isArray(rawProducts)) return [];
    return rawProducts.map((p: any) => this.mapGraphqlProduct(p));
  }

  async getPersonalBonus(): Promise<any[]> {
    const { startDate } = await this.getCurrentBonusPeriod();
    const data = await this.request<any>("/mobile-services/bonuspage/v1/personal", {
      query: { bonusStartDate: startDate },
    });
    const entries =
      data?.bonusGroupOrProducts ||
      data?.bonusBox ||
      data?.offers ||
      (Array.isArray(data) ? data : []);
    return entries.map((entry: any) => {
      if (entry?.product) return this.mapProduct(entry.product);
      if (entry?.bonusGroup) return entry.bonusGroup;
      return entry;
    });
  }

  async getClearanceBargains(storeId: number): Promise<any[]> {
    const resp = await this.request<any>("/graphql", {
      method: "POST",
      body: {
        operationName: "BargainItems",
        variables: { storeId: String(storeId) },
        query: `query BargainItems($storeId: String!) {
          bargainItems(storeId: $storeId) {
            product {
              id
              title
              brand
              salesUnitSize
            }
            categoryTitle
            markdown {
              markdownType
              markdownExpirationDate
              markdownPercentage
            }
            stock
            bargainPrice {
              priceWas
              priceNow
            }
          }
        }`,
      },
    });

    if (Array.isArray(resp?.errors) && resp.errors.length > 0) {
      const onlyBargainPath = resp.errors.every(
        (e: any) => Array.isArray(e?.path) && e.path.length === 1 && e.path[0] === "bargainItems"
      );
      if (onlyBargainPath && resp?.data == null) {
        return [];
      }
      throw new Error(
        `Albert Heijn GraphQL error at BargainItems: ${AhClient.formatGraphQlErrors(resp.errors)}`
      );
    }

    const items = resp?.data?.bargainItems;
    if (!Array.isArray(items)) return [];
    return items.map((item: any) => ({
      productId: item.product?.id,
      title: item.product?.title,
      brand: item.product?.brand,
      unitSize: item.product?.salesUnitSize,
      category: item.categoryTitle,
      wasPrice: item.bargainPrice?.priceWas,
      nowPrice: item.bargainPrice?.priceNow,
      discountPercentage: item.markdown?.markdownPercentage,
      markdownType: item.markdown?.markdownType,
      expirationDate: item.markdown?.markdownExpirationDate,
      stock: item.stock,
    }));
  }

  /**
   * 4. Shopping Lists (Main & Favorites)
   */
  private mapShoppingListItems(rawItems: any[]): ShoppingListItem[] {
    return rawItems.map((item: any) => {
      const rawProd = item.productDetails?.product || item.product;
      const product = rawProd ? this.mapProduct(rawProd) : undefined;
      const productId = item.productId || rawProd?.webshopId || rawProd?.id;
      const isProduct =
        item.originCode === "PRD" || item.type === "PRODUCT" || Boolean(productId);
      const text =
        item.text ||
        item.description ||
        item.vagueTermDetails?.searchTermValue ||
        rawProd?.title;
      const rawId =
        item.id ||
        (typeof item.listItemId === "number" && item.listItemId > 0
          ? String(item.listItemId)
          : undefined) ||
        (productId ? `prd:${productId}` : text ? `txt:${text}` : undefined);

      return {
        id: rawId,
        type: isProduct ? "PRODUCT" : "FREE_TEXT",
        text,
        productId,
        product,
        quantity: item.quantity ?? 1,
        checked: Boolean(item.strikedthrough ?? item.checked),
      };
    });
  }

  async getShoppingList(): Promise<ShoppingList> {
    try {
      const data = await this.request<any>("/mobile-services/shoppinglist/v2/items");
      const items = this.mapShoppingListItems(data.items || []);
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
            const items = this.mapShoppingListItems(list.items || []);
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
    const res = await this.request<any>("/mobile-services/shoppinglist/v2/items", {
      method: "PATCH",
      body: payload,
    });
    this.cache.invalidate("GET /mobile-services/shoppinglist");
    return res;
  }

  async removeShoppingListItem(itemId: string | number): Promise<any> {
    const needle = String(itemId).trim();
    const list = await this.getShoppingList();
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

    const res = await this.request<any>("/mobile-services/shoppinglist/v2/items", {
      method: "PATCH",
      body: { items: [removalItem] },
    });
    this.cache.invalidate("GET /mobile-services/shoppinglist");
    return res;
  }

  async getFavoriteLists(): Promise<FavoriteList[]> {
    const resp = await this.graphql<any>(
      "FetchFavoriteLists",
      `query FetchFavoriteLists($ids: [String!]!, $productIds: [Int!]!) {
        favoriteListV2(ids: $ids, productIds: $productIds) {
          id
          description
          totalSize
          imageUrl
          items {
            id
            productId
            quantity
          }
        }
      }`,
      { ids: [], productIds: [] }
    );

    const data = resp?.data?.favoriteListV2;
    if (!Array.isArray(data)) return [];
    return data.map((l: any) => ({
      id: l.id,
      title: l.description || l.title || l.name,
      itemCount: l.totalSize ?? l.itemCount ?? l.items?.length ?? 0,
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
    const resp = await this.graphql<any>(
      "AddProductsToFavoriteList",
      `mutation AddProductsToFavoriteList($favoriteListId: String!, $products: [FavoriteListProductMutation!]!) {
        favoriteListProductsAddV2(id: $favoriteListId, products: $products) {
          status
          errorMessage
        }
      }`,
      {
        favoriteListId: String(listId).toUpperCase(),
        products: [{ productId: item.productId, quantity: item.quantity || 1 }],
      }
    );

    const res = resp?.data?.favoriteListProductsAddV2;
    if (res?.status && res.status !== "SUCCESS") {
      throw new Error(`Failed to add item to favorite list: ${res.errorMessage || res.status}`);
    }
    return res;
  }

  async setFavoriteListItemChecked(
    _listId: string,
    itemId: string,
    checked: boolean = true
  ): Promise<any> {
    const res = await this.request<any>(
      `/mobile-services/lists/v3/lists/items/${itemId}`,
      {
        method: "PATCH",
        body: { checked },
      }
    );
    return res;
  }

  async removeFavoriteListItem(listId: string, itemId: string): Promise<any> {
    const resp = await this.graphql<any>(
      "DeleteProductsFromFavoriteList",
      `mutation DeleteProductsFromFavoriteList($favoriteListId: String!, $itemIds: [String!]!) {
        favoriteListProductsDeleteV2(id: $favoriteListId, itemIds: $itemIds) {
          status
          errorMessage
        }
      }`,
      {
        favoriteListId: String(listId).toUpperCase(),
        itemIds: [itemId],
      }
    );

    const res = resp?.data?.favoriteListProductsDeleteV2;
    if (res?.status && res.status !== "SUCCESS") {
      throw new Error(`Failed to remove item from favorite list: ${res.errorMessage || res.status}`);
    }
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
   * 7. Allerhande Recipes (via GraphQL gateway)
   */
  private static pickLargestRecipeImage(
    images?: Array<{ url?: string; width?: number; height?: number }>
  ): string | undefined {
    if (!Array.isArray(images)) return undefined;
    let bestUrl: string | undefined;
    let bestArea = -1;
    for (const img of images) {
      if (!img?.url) continue;
      const area = (img.width ?? 0) * (img.height ?? 0);
      if (area >= bestArea) {
        bestArea = area;
        bestUrl = img.url;
      }
    }
    return bestUrl;
  }

  private static toRecipeUrl(
    href?: string | null,
    id?: number | string,
    slug?: string | null
  ): string | undefined {
    if (href) {
      return href.startsWith("http") ? href : `https://www.ah.nl${href}`;
    }
    if (id !== undefined && id !== null && slug) {
      return `https://www.ah.nl/allerhande/recept/R-R${id}/${slug}`;
    }
    return undefined;
  }

  private static formatGraphQlErrors(errors: any[]): string {
    return errors.map((e) => e?.message || JSON.stringify(e)).join("; ");
  }

  async searchRecipes(query: string, page: number = 0, size: number = 10): Promise<Recipe[]> {
    const safePage = Math.max(0, Math.trunc(page));
    const safeSize = Math.max(1, Math.trunc(size));

    const resp = await this.request<any>("/graphql", {
      method: "POST",
      body: {
        operationName: "FetchRecipes",
        variables: {
          searchText: query,
          start: safePage * safeSize,
          size: safeSize,
          sortBy: "MOST_RELEVANT",
          filters: [],
          priorityRecipeIds: [],
          boostFavoriteRecipeIds: [],
          recipeIds: [],
          ingredients: [],
        },
        query: `query FetchRecipes(
          $searchText: String
          $start: Int
          $size: PageSize
          $sortBy: RecipeSearchSortOption
          $filters: [RecipeSearchQueryFilter!]
          $priorityRecipeIds: [Int!]
          $boostFavoriteRecipeIds: [Int!]
          $recipeIds: [Int!]!
          $ingredients: [String!]
        ) {
          recipeSearchV2(
            searchText: $searchText
            start: $start
            size: $size
            sortBy: $sortBy
            filters: $filters
            priorityRecipeIds: $priorityRecipeIds
            boostFavoriteRecipeIds: $boostFavoriteRecipeIds
            recipeIds: $recipeIds
            ingredients: $ingredients
          ) {
            page {
              total
              hasNextPage
            }
            result {
              id
              title
              slug
              time {
                cook
                oven
                wait
              }
              serving {
                number
              }
              images(renditions: [S, M, D445X297, D890X594]) {
                width
                height
                url
              }
            }
          }
        }`,
      },
    });

    if (Array.isArray(resp?.errors) && resp.errors.length > 0) {
      throw new Error(
        `Albert Heijn GraphQL error at FetchRecipes: ${AhClient.formatGraphQlErrors(resp.errors)}`
      );
    }

    const rawList = resp?.data?.recipeSearchV2?.result;
    if (!Array.isArray(rawList)) {
      throw new Error("Unexpected response shape from FetchRecipes: missing recipeSearchV2.result");
    }

    return rawList.map((r: any) => ({
      id: r.id,
      title: r.title,
      servings: r.serving?.number ?? undefined,
      prepTimeMinutes: r.time?.cook ?? r.time?.oven ?? undefined,
      ovenTimeMinutes: r.time?.oven ?? undefined,
      waitTimeMinutes: r.time?.wait ?? undefined,
      imageUrl: AhClient.pickLargestRecipeImage(r.images),
      url: AhClient.toRecipeUrl(undefined, r.id, r.slug),
      ingredients: [],
    }));
  }

  async getRecipeDetails(
    recipeId: string | number
  ): Promise<Recipe | { error: string; message: string }> {
    const numericId = Number(String(recipeId).trim().replace(/^R-R/i, ""));
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new Error(`Invalid recipe ID: ${recipeId}`);
    }

    const resp = await this.request<any>("/graphql", {
      method: "POST",
      body: {
        operationName: "FetchRecipeDetails",
        variables: { id: numericId },
        query: `query FetchRecipeDetails($id: Int!) {
          recipe(id: $id) {
            id
            title
            href
            cookTime
            ovenTime
            waitTime
            servings {
              number
            }
            images {
              width
              height
              url
            }
            ingredients {
              id
              name {
                singular
                plural
              }
              quantity
              quantityUnit {
                singular
                plural
              }
              text
            }
            preparation {
              steps
            }
          }
        }`,
      },
    });

    const data = resp?.data?.recipe;
    if (data === null) {
      const onlyRecipePathError =
        !resp?.errors?.length ||
        resp.errors.every(
          (e: any) => Array.isArray(e?.path) && e.path.length === 1 && e.path[0] === "recipe"
        );
      if (onlyRecipePathError) {
        return {
          error: "Not Found",
          message: `Recipe not found for ID: ${recipeId}`,
        };
      }
    }

    if (Array.isArray(resp?.errors) && resp.errors.length > 0) {
      throw new Error(
        `Albert Heijn GraphQL error at FetchRecipeDetails: ${AhClient.formatGraphQlErrors(resp.errors)}`
      );
    }

    if (!data) {
      throw new Error("Unexpected response shape from FetchRecipeDetails: missing data.recipe");
    }

    return {
      id: data.id ?? numericId,
      title: data.title,
      servings: data.servings?.number ?? undefined,
      prepTimeMinutes: data.cookTime ?? data.ovenTime ?? undefined,
      ovenTimeMinutes: data.ovenTime ?? undefined,
      waitTimeMinutes: data.waitTime ?? undefined,
      imageUrl: AhClient.pickLargestRecipeImage(data.images),
      url: AhClient.toRecipeUrl(data.href, data.id ?? numericId),
      instructions: Array.isArray(data.preparation?.steps) ? data.preparation.steps : [],
      ingredients: (data.ingredients || []).map((ing: any) => {
        const amount = typeof ing.quantity === "number" ? ing.quantity : undefined;
        const usePlural = amount !== undefined && amount !== 1;
        const name =
          (usePlural
            ? ing.name?.plural || ing.name?.singular
            : ing.name?.singular || ing.name?.plural) ||
          ing.text ||
          "";
        const rawUnit = usePlural
          ? ing.quantityUnit?.plural || ing.quantityUnit?.singular
          : ing.quantityUnit?.singular || ing.quantityUnit?.plural;
        return {
          name,
          amount,
          unit: rawUnit || undefined,
        };
      }),
    };
  }

  /**
   * 8. Store Locator
   */
  async searchStores(postalCodeOrCity?: string): Promise<StoreInfo[]> {
    const trimmed = postalCodeOrCity?.trim();
    const isPostalCode = trimmed ? /^\d{4}\s?[a-zA-Z]{2}$|^\d{4}$/.test(trimmed) : false;
    const filter = isPostalCode && trimmed
      ? { postalCode: trimmed.replace(/\s+/g, "").toUpperCase() }
      : {};
    const limit = isPostalCode ? 20 : 1500;

    const resp = await this.graphql<{
      data?: { storesSearch?: { result?: any[] } };
    }>(
      "StoresSearch",
      `query StoresSearch($filter: StoresFilterInput, $limit: Int) {
        storesSearch(filter: $filter, limit: $limit) {
          pageInfo {
            total
            hasNextPage
          }
          result {
            id
            name
            phone
            storeType
            address {
              street
              houseNumber
              houseNumberExtra
              postalCode
              city
            }
            openingDays {
              dayName
              openingHour {
                openFrom
                openUntil
              }
            }
            services {
              code
              description
            }
          }
        }
      }`,
      { filter, limit }
    );

    let stores = resp?.data?.storesSearch?.result || [];
    if (trimmed && !isPostalCode) {
      const needle = trimmed.toLowerCase();
      stores = stores.filter((s: any) =>
        [s.name, s.address?.city, s.address?.street, s.address?.postalCode]
          .filter(Boolean)
          .some((field: string) => field.toLowerCase().includes(needle))
      );
    }

    return stores.map((s: any) => {
      const addr = s.address || {};
      const house = [addr.houseNumber, addr.houseNumberExtra].filter(Boolean).join("");
      const street = [addr.street, house].filter(Boolean).join(" ") || s.street;
      return {
        id: s.id,
        name: s.name || street,
        street,
        postalCode: addr.postalCode || s.postalCode,
        city: addr.city || s.city,
        distanceKm: s.distance,
        isOpenNow: this.isStoreOpenNow(s.openingDays) ?? s.isOpenNow,
        facilities: Array.isArray(s.services)
          ? s.services.map((svc: any) => svc.code || svc.description).filter(Boolean)
          : s.facilities || [],
      };
    });
  }

  private isStoreOpenNow(openingDays: any): boolean | undefined {
    if (!Array.isArray(openingDays) || openingDays.length === 0) return undefined;
    const flatDays = Array.isArray(openingDays[0]) ? openingDays[0] : openingDays;
    if (!Array.isArray(flatDays) || flatDays.length === 0) return undefined;

    const now = new Date();
    const enParts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Amsterdam",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const nlWeekday = new Intl.DateTimeFormat("nl-NL", {
      timeZone: "Europe/Amsterdam",
      weekday: "long",
    })
      .format(now)
      .toUpperCase();
    const enWeekday = enParts.find((p) => p.type === "weekday")?.value.toUpperCase() || "";
    const hhmm = `${enParts.find((p) => p.type === "hour")?.value}:${enParts.find((p) => p.type === "minute")?.value}`;

    const today = flatDays.find((d: any) => {
      const name = String(d?.dayName || "").toUpperCase();
      return name === enWeekday || name === nlWeekday;
    });
    const openFrom = today?.openingHour?.openFrom;
    const openUntil = today?.openingHour?.openUntil;
    if (!openFrom || !openUntil) return undefined;
    return hhmm >= openFrom && hhmm < openUntil;
  }

  /**
   * 9. Active Online Cart
   */
  async getCart(): Promise<any> {
    const resp = await this.graphql<{ data?: { basket?: any; order?: any } }>(
      "FetchMyListBasket",
      `query FetchMyListBasket {
        basket(input: null) {
          canChangeDelivery
          itemsInOrder {
            position
            originCode
            isClosed
            allocatedQuantity
            quantity
            product {
              id
              title
              brand
              salesUnitSize
              category
              priceV2 {
                now { amount }
                was { amount }
              }
            }
          }
          notes {
            description
            isStrikethrough
            originCode
            position
            quantity
            searchTerm
          }
          products {
            isStrikethrough
            originCode
            position
            quantity
            product {
              id
              title
              brand
              salesUnitSize
              category
              priceV2 {
                now { amount }
                was { amount }
              }
            }
          }
          summary {
            isCancellable
            quantity
            shoppingType
            lastUserChangeDateTime
            price {
              discount { amount }
              totalPrice { amount }
              priceAfterDiscount { amount }
              priceBeforeDiscount { amount }
            }
          }
        }
        order {
          delivery {
            address {
              street
              houseNumber
              houseNumberExtra
              zipCode
              city
              countryCode
            }
            date
            endTime
            startTime
            status
            id
            shiftCode
            pickupLocationId
          }
        }
      }`,
      {}
    );
    return {
      basket: resp?.data?.basket || null,
      order: resp?.data?.order || null,
    };
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
    const data = await this.request<any>(
      "/mobile-services/v2/recommendations/dontforgetlane",
      {
        method: "POST",
        body: {
          positiveCmOnly: true,
          offset: 0,
          usecaseId: "app_mylist",
          basketItems: [],
          limit: 20,
        },
      }
    );
    const cards = Array.isArray(data) ? data : data.productCards || data.items || [];
    return cards.map((p: any) => this.mapProduct(p));
  }

  async activatePersonalBonus(bonusCardNumber: string, selectedBonusIds: number[]): Promise<any> {
    const res = await this.request<any>("https://api.ah.nl/handscanner/v1/bonuses", {
      method: "PATCH",
      body: {
        bonusCardNumber,
        selectedBonusIds,
      },
    });
    this.cache.invalidate("GET /mobile-services/bonuspage/v1/personal");
    this.cache.invalidate("POST /mobile-services/v2/recommendations/dontforgetlane");
    return res;
  }

  private mapGraphqlProduct(p: any): AhProduct {
    const now = p.priceV2?.now?.amount;
    const was = p.priceV2?.was?.amount;
    const isDiscounted =
      now !== null &&
      now !== undefined &&
      was !== null &&
      was !== undefined &&
      was > now;
    const tier = p.priceV2?.promotionLabel?.tiers?.[0];
    const bonusMechanism =
      p.priceV2?.discount?.description || tier?.mechanism || tier?.description;

    return {
      id: Number(p.id) || p.id,
      webProductId: p.id !== undefined && p.id !== null ? `wi${p.id}` : undefined,
      title: p.title || "",
      summary: p.summary || p.highlights || p.additionalInformation,
      brand: p.brand,
      price: {
        now: (isDiscounted ? now : (now ?? was)) ?? 0,
        was: isDiscounted ? was : undefined,
        unitSizeDescription: p.salesUnitSize || p.priceV2?.unitInfo?.description,
      },
      unitPriceDescription: p.priceV2?.unitInfo?.price?.formattedV2,
      bonus: Boolean(isDiscounted || bonusMechanism || p.priceV2?.discount),
      bonusMechanism,
      discountType: p.priceV2?.discount?.promotionType,
      images: Array.isArray(p.imagePack)
        ? p.imagePack
            .map((img: any) => ({ url: img.large || img.medium || img.small }))
            .filter((img: any) => Boolean(img.url))
        : [],
      category: p.category,
      availableOnline:
        p.availability?.isOrderable ??
        (p.availability?.online?.status === "ORDERABLE" ? true : undefined),
    };
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
