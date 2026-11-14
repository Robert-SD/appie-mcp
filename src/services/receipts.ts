import { mapWithConcurrency } from "../concurrency.js";
import { GRAPHQL_QUERIES } from "../graphql-queries.js";
import { mapReceiptDetails, mapReceiptSummary } from "../mappers.js";
import { PromoDigestOffer, PromoDigestResult, Receipt } from "../types.js";
import { searchProducts } from "./catalog.js";
import { AhTransport } from "./transport.js";

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
const DIGEST_CONCURRENCY = 5;

export async function listReceipts(
  t: AhTransport,
  page: number = 0,
  size: number = 10
): Promise<Receipt[]> {
  const wanted = Math.max(1, Math.trunc(size));
  const first = Math.max(0, Math.trunc(page)) * wanted;
  const receipts: Receipt[] = [];

  for (let fetched = 0; fetched < wanted; ) {
    const limit = Math.min(wanted - fetched, AH_RECEIPTS_MAX_LIMIT);
    const resp = await t.graphql<any>(
      "FetchPosReceiptsPage",
      GRAPHQL_QUERIES.FetchPosReceiptsPage,
      { pagination: { offset: first + fetched, limit } }
    );

    const rawList = resp.data?.posReceiptsPage?.posReceipts;
    if (!Array.isArray(rawList) || rawList.length === 0) break;

    receipts.push(...rawList.map(mapReceiptSummary));
    fetched += rawList.length;
    if (rawList.length < limit) break;
  }

  return receipts;
}

async function listReceiptsInWindow(
  t: AhTransport,
  cutoff: number
): Promise<Receipt[]> {
  const collected: Receipt[] = [];

  for (let page = 0; collected.length < AH_DIGEST_MAX_RECEIPTS; page++) {
    const batch = await listReceipts(t, page, AH_DIGEST_PAGE_SIZE);
    if (batch.length === 0) break;

    collected.push(...batch);
    const oldest = new Date(batch[batch.length - 1].transactionDate).getTime();
    if (oldest < cutoff) break;
    if (batch.length < AH_DIGEST_PAGE_SIZE) break;
  }

  return collected.slice(0, AH_DIGEST_MAX_RECEIPTS);
}

export async function getReceiptDetails(
  t: AhTransport,
  transactionId: string
): Promise<Receipt> {
  const resp = await t.graphql<any>(
    "FetchPosReceiptsDetails",
    GRAPHQL_QUERIES.FetchPosReceiptsDetails,
    { id: transactionId }
  );

  const details = resp.data?.posReceiptDetails;
  if (!details) {
    throw new Error(
      `Receipt details not found for transaction ID: ${transactionId}`
    );
  }

  return mapReceiptDetails(details, transactionId);
}

export async function getPromoDigest(
  t: AhTransport,
  options: {
    days?: number;
    minTimes?: number;
    limit?: number;
  } = {}
): Promise<PromoDigestResult> {
  const days = options.days || 90;
  const minTimes = options.minTimes || 2;
  const limit = options.limit || 25;

  const cutoff = Date.now() - days * 86400 * 1000;
  const receipts = (await listReceiptsInWindow(t, cutoff)).filter(
    (r) => new Date(r.transactionDate).getTime() >= cutoff
  );

  const detailsList = await mapWithConcurrency(
    receipts,
    DIGEST_CONCURRENCY,
    async (r) => {
      try {
        return await getReceiptDetails(t, r.transactionId);
      } catch {
        return null;
      }
    }
  );

  const itemCounts = new Map<string, { count: number; name: string }>();
  for (const details of detailsList) {
    if (!details) continue;
    for (const line of details.lines || []) {
      const key = line.description.trim().toLowerCase();
      if (!key || line.price <= 0) continue;
      const prev = itemCounts.get(key) || { count: 0, name: line.description };
      prev.count += 1;
      itemCounts.set(key, prev);
    }
  }

  const frequent = Array.from(itemCounts.values())
    .filter((x) => x.count >= minTimes)
    .sort((a, b) => b.count - a.count);

  const searchCandidates = await mapWithConcurrency(
    frequent,
    DIGEST_CONCURRENCY,
    async (item): Promise<PromoDigestOffer | null> => {
      try {
        const searchRes = await searchProducts(t, { query: item.name, size: 3 });
        const match = searchRes.products.find((p) => p.bonus);
        if (!match) return null;
        return {
          frequentItem: item.name,
          purchasedTimes: item.count,
          matchedProduct: match.title,
          currentPrice: match.price.now,
          regularPrice: match.price.was,
          discountType: match.discountType,
          bonusMechanism: match.bonusMechanism,
        };
      } catch {
        return null;
      }
    }
  );

  const digestResults = searchCandidates
    .filter((x): x is PromoDigestOffer => x !== null)
    .slice(0, limit);

  return {
    frequentProductsFound: frequent.length,
    currentOffersFound: digestResults.length,
    offers: digestResults,
  };
}
