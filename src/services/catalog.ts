import { GRAPHQL_QUERIES } from "../graphql-queries.js";
import {
  mapGraphqlProduct,
  mapProduct,
  parsePositiveIntId,
} from "../mappers.js";
import { AhProduct, Category } from "../types.js";
import { AhTransport } from "./transport.js";

export async function searchProducts(
  t: AhTransport,
  options: {
    query: string;
    sort?: "RELEVANCE" | "PRICE_ASC" | "PRICE_DESC";
    page?: number;
    size?: number;
    bonusOnly?: boolean;
  }
): Promise<{ products: AhProduct[]; total: number }> {
  const queryParams: Record<string, any> = {
    query: options.query,
    sortOn: options.sort || "RELEVANCE",
    page: options.page ?? 0,
    size: options.size ?? 20,
  };
  if (options.bonusOnly) {
    queryParams.filter = "bonus=Bonus";
  }

  const data = await t.request<any>("/mobile-services/product/search/v2", {
    query: queryParams,
  });

  const rawProducts = data.products || [];
  const products: AhProduct[] = rawProducts.map((p: any) => mapProduct(p));

  return {
    products,
    total: data.page?.totalElements ?? products.length,
  };
}

export async function getProduct(
  t: AhTransport,
  productId: string | number
): Promise<AhProduct> {
  const numericId = parsePositiveIntId(productId, /^wi/i, "product");
  const resp = await t.graphql<any>(
    "FetchProductDetails",
    GRAPHQL_QUERIES.FetchProductDetails,
    { productId: numericId }
  );

  if (!resp?.data?.product) {
    throw new Error(`Product not found for ID: ${productId}`);
  }
  return mapGraphqlProduct(resp.data.product);
}

export async function getProductAlternatives(
  t: AhTransport,
  productId: string | number
): Promise<AhProduct[]> {
  const numericId = parsePositiveIntId(productId, /^wi/i, "product");
  const resp = await t.graphql<any>(
    "FetchProductAlternatives",
    GRAPHQL_QUERIES.FetchProductAlternatives,
    { productId: numericId, size: 10 }
  );

  const rawList = resp?.data?.productAlternatives?.products;
  return Array.isArray(rawList) ? rawList.map(mapGraphqlProduct) : [];
}

export async function getProductsBulk(
  t: AhTransport,
  productIds: Array<string | number>
): Promise<AhProduct[]> {
  const ids = productIds
    .map((id) => String(id).trim().replace(/^wi/i, ""))
    .filter(Boolean);
  if (ids.length === 0) return [];

  const data = await t.request<any>("/mobile-services/product/search/v2/products", {
    query: { ids, sortOn: "INPUT_PRODUCT_IDS" },
  });
  const rawList = Array.isArray(data) ? data : data?.products || [];
  return rawList.map(mapProduct);
}

export async function getCategories(t: AhTransport): Promise<Category[]> {
  const resp = await t.graphql<any>(
    "FetchCategories",
    GRAPHQL_QUERIES.FetchCategories
  );
  return resp?.data?.productTopLevelTaxonomies || [];
}

export async function getSubCategories(
  t: AhTransport,
  categoryId: string | number
): Promise<Category[]> {
  const numericId = parsePositiveIntId(categoryId, null, "category");
  const resp = await t.graphql<any>(
    "FetchSubCategories",
    GRAPHQL_QUERIES.FetchSubCategories,
    { id: numericId }
  );
  const all = resp?.data?.productTaxonomyById;
  if (!Array.isArray(all)) return [];
  return all.filter((item: any) => Number(item?.id) !== numericId);
}

export async function getSearchSuggestions(
  t: AhTransport,
  query: string,
  amount: number = 10
): Promise<string[]> {
  const data = await t.request<any>(
    "/mobile-services/product/search/v2/suggestions",
    { query: { query, amount } }
  );
  return data.suggestions || [];
}
