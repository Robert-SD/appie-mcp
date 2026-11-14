import { GRAPHQL_QUERIES } from "../graphql-queries.js";
import {
  mapClearanceBargain,
  mapGraphqlProduct,
  mapProduct,
} from "../mappers.js";
import { AhProduct, ClearanceBargain } from "../types.js";
import { searchProducts } from "./catalog.js";
import { AhTransport } from "./transport.js";

export async function getBonusOffers(
  t: AhTransport,
  query: string = "",
  page: number = 0,
  size: number = 30
): Promise<AhProduct[]> {
  const res = await searchProducts(t, {
    query,
    bonusOnly: true,
    page,
    size,
  });
  return res.products;
}

async function getCurrentBonusPeriod(
  t: AhTransport
): Promise<{ startDate: string; endDate: string }> {
  const data = await t.request<any>("/mobile-services/bonuspage/v3/metadata");
  const period = data?.periods?.[0];
  if (!period?.bonusStartDate || !period?.bonusEndDate) {
    throw new Error("Could not determine current Albert Heijn bonus period");
  }
  return {
    startDate: period.bonusStartDate,
    endDate: period.bonusEndDate,
  };
}

export async function getBonusGroupProducts(
  t: AhTransport,
  segmentId: number | string
): Promise<AhProduct[]> {
  const { startDate, endDate } = await getCurrentBonusPeriod(t);
  const resp = await t.graphql<any>(
    "FetchBonusPromotionWithProducts",
    GRAPHQL_QUERIES.FetchBonusPromotionWithProducts,
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
  return Array.isArray(rawProducts) ? rawProducts.map(mapGraphqlProduct) : [];
}

export async function getPersonalBonus(t: AhTransport): Promise<any[]> {
  const { startDate } = await getCurrentBonusPeriod(t);
  const data = await t.request<any>("/mobile-services/bonuspage/v1/personal", {
    query: { bonusStartDate: startDate },
  });
  const entries =
    data?.bonusGroupOrProducts ||
    data?.bonusBox ||
    data?.offers ||
    (Array.isArray(data) ? data : []);
  return entries.map((entry: any) => {
    if (entry?.product) return mapProduct(entry.product);
    if (entry?.bonusGroup) return entry.bonusGroup;
    return entry;
  });
}

export async function getClearanceBargains(
  t: AhTransport,
  storeId: number
): Promise<ClearanceBargain[]> {
  const resp = await t.graphql<any>(
    "BargainItems",
    GRAPHQL_QUERIES.BargainItems,
    { storeId: String(storeId) },
    { allowPartialErrorPaths: ["bargainItems"] }
  );

  const items = resp?.data?.bargainItems;
  return Array.isArray(items) ? items.map(mapClearanceBargain) : [];
}

export async function getPredictiveFavorites(
  t: AhTransport
): Promise<AhProduct[]> {
  const data = await t.request<any>(
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
  const cards = Array.isArray(data)
    ? data
    : data.productCards || data.items || [];
  return cards.map(mapProduct);
}

export async function activatePersonalBonus(
  t: AhTransport,
  bonusCardNumber: string,
  selectedBonusIds: number[]
): Promise<any> {
  const res = await t.request<any>("https://api.ah.nl/handscanner/v1/bonuses", {
    method: "PATCH",
    body: {
      bonusCardNumber,
      selectedBonusIds,
    },
  });
  t.invalidateCache("GET /mobile-services/bonuspage/v1/personal");
  t.invalidateCache("POST /mobile-services/v2/recommendations/dontforgetlane");
  return res;
}
