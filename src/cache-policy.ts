import { cacheKey } from "./cache.js";

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

export interface CacheRule {
  ttl: number;
  shouldCache?: (payload: any) => boolean;
}

export interface RequestCacheInput {
  method?: string;
  body?: any;
  query?: Record<string, any>;
}

/**
 * A product payload is cacheable only when it actually carries a product.
 */
export function isCacheableProductPayload(payload: any): boolean {
  if (Array.isArray(payload)) return payload.length > 0;
  if (Array.isArray(payload?.products)) return payload.products.length > 0;
  return Boolean(
    payload?.productCard?.id ?? payload?.productCard?.webshopId ?? payload?.id
  );
}

const GRAPHQL_CACHE_POLICIES: Record<string, CacheRule> = {
  FetchPosReceiptsDetails: {
    ttl: CACHE_TTL.receiptDetail,
    shouldCache: (payload) => Boolean(payload?.data?.posReceiptDetails),
  },
  BargainItems: {
    ttl: CACHE_TTL.offers,
    // Missing/empty store clearance answers with null or errors; keep retryable.
    shouldCache: (payload) =>
      !payload?.errors?.length &&
      Array.isArray(payload?.data?.bargainItems) &&
      payload.data.bargainItems.length > 0,
  },
  FetchProductDetails: {
    ttl: CACHE_TTL.productDetail,
    shouldCache: (payload) =>
      !payload?.errors?.length && Boolean(payload?.data?.product?.id),
  },
  FetchProductAlternatives: {
    ttl: CACHE_TTL.productDetail,
    shouldCache: (payload) =>
      !payload?.errors?.length &&
      Array.isArray(payload?.data?.productAlternatives?.products),
  },
  FetchCategories: {
    ttl: CACHE_TTL.catalog,
    shouldCache: (payload) =>
      !payload?.errors?.length &&
      Array.isArray(payload?.data?.productTopLevelTaxonomies) &&
      payload.data.productTopLevelTaxonomies.length > 0,
  },
  FetchSubCategories: {
    ttl: CACHE_TTL.catalog,
    shouldCache: (payload) =>
      !payload?.errors?.length &&
      Array.isArray(payload?.data?.productTaxonomyById) &&
      payload.data.productTaxonomyById.length > 0,
  },
  StoresSearch: {
    ttl: CACHE_TTL.catalog,
    shouldCache: (payload) =>
      !payload?.errors?.length &&
      Array.isArray(payload?.data?.storesSearch?.result),
  },
  FetchBonusPromotionWithProducts: {
    ttl: CACHE_TTL.offers,
    shouldCache: (payload) =>
      !payload?.errors?.length && Array.isArray(payload?.data?.bonusPromotions),
  },
  FetchRecipes: {
    ttl: CACHE_TTL.catalog,
    shouldCache: (payload) =>
      !payload?.errors?.length &&
      Array.isArray(payload?.data?.recipeSearchV2?.result) &&
      payload.data.recipeSearchV2.result.length > 0,
  },
  FetchRecipeDetails: {
    ttl: CACHE_TTL.catalog,
    shouldCache: (payload) =>
      !payload?.errors?.length && Boolean(payload?.data?.recipe?.id),
  },
};

const REST_POST_CACHE_POLICIES: Record<string, CacheRule> = {
  "/mobile-services/v2/recommendations/dontforgetlane": {
    ttl: CACHE_TTL.offers,
    shouldCache: (payload) =>
      Array.isArray(payload?.productCards) && payload.productCards.length > 0,
  },
};

// Ordered from most specific prefix to least specific.
const REST_GET_CACHE_POLICIES: Array<{ prefix: string; rule: CacheRule }> = [
  {
    prefix: "/mobile-services/product/search/v2/suggestions",
    rule: { ttl: CACHE_TTL.search },
  },
  {
    prefix: "/mobile-services/product/search/v2/products",
    rule: {
      ttl: CACHE_TTL.productDetail,
      shouldCache: isCacheableProductPayload,
    },
  },
  {
    prefix: "/mobile-services/product/search/v2",
    rule: { ttl: CACHE_TTL.search },
  },
  {
    prefix: "/mobile-services/bonuspage/v3/metadata",
    rule: { ttl: CACHE_TTL.offers },
  },
  {
    prefix: "/mobile-services/bonuspage/v1/personal",
    rule: { ttl: CACHE_TTL.offers },
  },
];

/**
 * Resolve the cache rule for a request, or `null` when it must stay live.
 */
export function cachePolicyFor(
  endpoint: string,
  options: RequestCacheInput
): CacheRule | null {
  const method = (options.method || "GET").toUpperCase();

  if (method !== "GET") {
    if (endpoint === "/graphql") {
      const operationName = options.body?.operationName;
      return typeof operationName === "string"
        ? GRAPHQL_CACHE_POLICIES[operationName] ?? null
        : null;
    }
    return REST_POST_CACHE_POLICIES[endpoint] ?? null;
  }

  if (endpoint.startsWith("http")) return null;

  for (const entry of REST_GET_CACHE_POLICIES) {
    if (endpoint.startsWith(entry.prefix)) {
      return entry.rule;
    }
  }
  return null;
}

/**
 * Compute a host- and principal-scoped cache key for an upstream request.
 */
export function cacheKeyFor(
  baseUrl: string,
  endpoint: string,
  options: RequestCacheInput,
  scope: string
): string {
  const method = (options.method || "GET").toUpperCase();

  if (method === "GET") {
    const query = Object.entries(options.query ?? {})
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(
        ([k, v]) =>
          [k, Array.isArray(v) ? v.map(String) : String(v)] as [
            string,
            string | string[],
          ]
      )
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return cacheKey(`${method} ${endpoint}`, [baseUrl, scope, query]);
  }

  const body = options.body ?? {};
  if (endpoint === "/graphql") {
    return cacheKey(`${method} ${endpoint}`, [
      baseUrl,
      scope,
      body.operationName ?? "",
      // Document text is included so identical operationNames with different fields do not collide.
      typeof body.query === "string" ? body.query : "",
      body.variables ?? {},
    ]);
  }
  return cacheKey(`${method} ${endpoint}`, [baseUrl, scope, body]);
}
