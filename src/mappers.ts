import {
  AhProduct,
  ClearanceBargain,
  FavoriteList,
  MemberProfile,
  Receipt,
  Recipe,
  ShoppingListItem,
  StoreInfo,
} from "./types.js";

/**
 * Parse a positive integer ID, optionally stripping a prefix such as `wi` or `R-R`.
 */
export function parsePositiveIntId(
  rawId: string | number,
  prefixPattern: RegExp | null,
  label: string
): number {
  const cleaned = prefixPattern
    ? String(rawId).trim().replace(prefixPattern, "")
    : String(rawId).trim();
  const numericId = Number(cleaned);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error(`Invalid ${label} ID: ${rawId}`);
  }
  return numericId;
}

/**
 * Normalize REST product payload into `AhProduct`.
 */
export function mapProduct(raw: any): AhProduct {
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

/**
 * Normalize a GraphQL `Product` object into `AhProduct`.
 */
export function mapGraphqlProduct(p: any): AhProduct {
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

  const images = Array.isArray(p.imagePack)
    ? p.imagePack
        .map((img: any) => {
          const variant = img?.large || img?.medium || img?.small;
          if (!variant) return null;
          if (typeof variant === "string") return { url: variant };
          if (!variant.url) return null;
          return {
            url: variant.url,
            ...(variant.width !== undefined ? { width: variant.width } : {}),
            ...(variant.height !== undefined ? { height: variant.height } : {}),
          };
        })
        .filter((img: any): img is { url: string; width?: number; height?: number } => Boolean(img))
    : [];

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
    images,
    category: p.category,
    availableOnline:
      p.availability?.isOrderable ??
      (p.availability?.online?.status === "ORDERABLE" ? true : undefined),
  };
}

export function mapMemberProfile(member: any): MemberProfile {
  if (!member) return {};
  const cards = member.loyaltyCards?.loyaltyCards || [];
  const bonusCard = cards.find((c: any) => c.type === "BONUS") || cards[0];
  const fullName =
    [member.name?.first, member.name?.last].filter(Boolean).join(" ").trim() || undefined;

  return {
    name: fullName,
    email: member.emailAddress || undefined,
    bonusCardNumber: bonusCard?.cardNumber || bonusCard?.barcodeNumber || undefined,
    hasBonusCard: Boolean(bonusCard?.cardNumber || bonusCard?.barcodeNumber),
    memberId:
      member.id !== undefined && member.id !== null ? String(member.id) : undefined,
  };
}

export function mapClearanceBargain(item: any): ClearanceBargain {
  return {
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
  };
}

export function mapShoppingListItems(rawItems: any[]): ShoppingListItem[] {
  return rawItems.map((item: any) => {
    const rawProd = item.productDetails?.product || item.product;
    const product = rawProd ? mapProduct(rawProd) : undefined;
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

export function mapFavoriteList(raw: any): FavoriteList {
  return {
    id: raw.id,
    title: raw.description || raw.title || raw.name,
    itemCount: raw.totalSize ?? raw.itemCount ?? raw.items?.length ?? 0,
    items: raw.items?.map((item: any) => ({
      id: item.id,
      type: "PRODUCT" as const,
      text: item.product?.title || item.title,
      productId: item.productId || item.product?.id,
      checked: Boolean(item.checked),
      quantity: item.quantity || 1,
    })),
  };
}

export function mapReceiptSummary(raw: any): Receipt {
  const addr = raw.storeAddress;
  const storeName = addr
    ? `AH ${addr.street || ""}${addr.houseNumber ? " " + addr.houseNumber : ""}${
        addr.city ? ", " + addr.city : ""
      }`.trim()
    : undefined;

  return {
    transactionId: raw.id,
    transactionDate: raw.dateTime,
    total: raw.totalAmount?.amount ?? 0,
    storeName: storeName || undefined,
  };
}

export function mapReceiptDetails(details: any, transactionId: string): Receipt {
  const rawProducts = details.products || [];
  const lines = rawProducts.map((p: any) => {
    const lineTotal = p.amount?.amount ?? 0;
    const unitPrice =
      p.price?.amount ??
      (p.quantity && p.quantity > 1 ? lineTotal / p.quantity : lineTotal);
    return {
      description: p.name || "",
      quantity: p.quantity ?? 1,
      price: lineTotal,
      unitPrice,
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

function pickLargestRecipeImage(
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

function toRecipeUrl(
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

export function mapRecipeSummary(raw: any): Recipe {
  return {
    id: raw.id,
    title: raw.title,
    servings: raw.serving?.number ?? undefined,
    prepTimeMinutes: raw.time?.cook ?? raw.time?.oven ?? undefined,
    ovenTimeMinutes: raw.time?.oven ?? undefined,
    waitTimeMinutes: raw.time?.wait ?? undefined,
    imageUrl: pickLargestRecipeImage(raw.images),
    url: toRecipeUrl(undefined, raw.id, raw.slug),
    ingredients: [],
  };
}

export function mapRecipeDetails(data: any, fallbackId: number): Recipe {
  return {
    id: data.id ?? fallbackId,
    title: data.title,
    servings: data.servings?.number ?? undefined,
    prepTimeMinutes: data.cookTime ?? data.ovenTime ?? undefined,
    ovenTimeMinutes: data.ovenTime ?? undefined,
    waitTimeMinutes: data.waitTime ?? undefined,
    imageUrl: pickLargestRecipeImage(data.images),
    url: toRecipeUrl(data.href, data.id ?? fallbackId),
    instructions: Array.isArray(data.preparation?.steps)
      ? data.preparation.steps
      : [],
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

export function isStoreOpenNow(openingDays: any): boolean | undefined {
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
  const enWeekday =
    enParts.find((p) => p.type === "weekday")?.value.toUpperCase() || "";
  const hhmm = `${enParts.find((p) => p.type === "hour")?.value}:${
    enParts.find((p) => p.type === "minute")?.value
  }`;

  const today = flatDays.find((d: any) => {
    const name = String(d?.dayName || "").toUpperCase();
    return name === enWeekday || name === nlWeekday;
  });
  const openFrom = today?.openingHour?.openFrom;
  const openUntil = today?.openingHour?.openUntil;
  if (!openFrom || !openUntil) return undefined;
  return hhmm >= openFrom && hhmm < openUntil;
}

export function mapStore(s: any): StoreInfo {
  const addr = s.address || {};
  const house = [addr.houseNumber, addr.houseNumberExtra]
    .filter(Boolean)
    .join("");
  const street = [addr.street, house].filter(Boolean).join(" ") || s.street;
  return {
    id: s.id,
    name: s.name || street,
    street,
    postalCode: addr.postalCode || s.postalCode,
    city: addr.city || s.city,
    distanceKm: s.distance,
    isOpenNow: isStoreOpenNow(s.openingDays) ?? s.isOpenNow,
    facilities: Array.isArray(s.services)
      ? s.services
          .map((svc: any) => svc.code || svc.description)
          .filter(Boolean)
      : s.facilities || [],
  };
}
