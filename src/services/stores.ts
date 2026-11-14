import { GRAPHQL_QUERIES } from "../graphql-queries.js";
import { mapMemberProfile, mapStore } from "../mappers.js";
import { CartSummary, MemberProfile, StoreInfo } from "../types.js";
import { AhTransport } from "./transport.js";

export async function getProfile(t: AhTransport): Promise<MemberProfile> {
  const resp = await t.graphql<any>(
    "FetchMember",
    GRAPHQL_QUERIES.FetchMember
  );
  return mapMemberProfile(resp.data?.member);
}

export async function searchStores(
  t: AhTransport,
  postalCodeOrCity?: string
): Promise<StoreInfo[]> {
  const trimmed = postalCodeOrCity?.trim();
  const isPostalCode = trimmed
    ? /^\d{4}\s?[a-zA-Z]{2}$|^\d{4}$/.test(trimmed)
    : false;
  const filter =
    isPostalCode && trimmed
      ? { postalCode: trimmed.replace(/\s+/g, "").toUpperCase() }
      : {};
  const limit = isPostalCode ? 20 : 1500;

  const resp = await t.graphql<{
    data?: { storesSearch?: { result?: any[] } };
  }>("StoresSearch", GRAPHQL_QUERIES.StoresSearch, { filter, limit });

  let stores = resp?.data?.storesSearch?.result || [];
  if (trimmed && !isPostalCode) {
    const needle = trimmed.toLowerCase();
    stores = stores.filter((s: any) =>
      [s.name, s.address?.city, s.address?.street, s.address?.postalCode]
        .filter(Boolean)
        .some((field: string) => field.toLowerCase().includes(needle))
    );
  }

  return stores.map(mapStore);
}

export async function getCart(t: AhTransport): Promise<CartSummary> {
  const resp = await t.graphql<{ data?: { basket?: any; order?: any } }>(
    "FetchMyListBasket",
    GRAPHQL_QUERIES.FetchMyListBasket,
    {}
  );
  return {
    basket: resp?.data?.basket || null,
    order: resp?.data?.order || null,
  };
}
