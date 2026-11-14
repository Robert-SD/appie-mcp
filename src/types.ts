export interface TokensData {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  saved_at?: string;
  is_anonymous?: boolean;
}

export interface MemberProfile {
  name?: string;
  email?: string;
  bonusCardNumber?: string;
  hasBonusCard?: boolean;
  memberId?: string;
}

export interface AhPrice {
  now: number;
  was?: number;
  unitSizeDescription?: string;
  theme?: string;
}

export interface AhProduct {
  id: number | string;
  webProductId?: string;
  title: string;
  summary?: string;
  brand?: string;
  price: AhPrice;
  unitPriceDescription?: string;
  bonus?: boolean;
  bonusMechanism?: string;
  discountType?: string;
  images?: Array<{ url: string; width?: number; height?: number }>;
  category?: string;
  url?: string;
  availableOnline?: boolean;
}

export interface BonusOffer {
  id: string | number;
  title: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  discountType?: string;
  bonusMechanism?: string;
  segmentId?: number;
  products?: AhProduct[];
}

export interface ShoppingListItem {
  id?: string | number;
  type: "FREE_TEXT" | "PRODUCT";
  text?: string;
  productId?: number;
  product?: AhProduct;
  quantity?: number;
  checked?: boolean;
}

export interface ShoppingList {
  id?: string;
  items: ShoppingListItem[];
  totalItems: number;
}

export interface FavoriteList {
  id: string;
  title: string;
  itemCount: number;
  items?: ShoppingListItem[];
}

export interface ReceiptLine {
  description: string;
  quantity: number;
  price: number;
  discount?: number;
  unitPrice?: number;
}

export interface Receipt {
  transactionId: string;
  transactionDate: string;
  total: number;
  totalDiscount?: number;
  storeId?: number;
  storeName?: string;
  lines?: ReceiptLine[];
}

export interface RecipeIngredient {
  name: string;
  amount?: number;
  unit?: string;
  productId?: number;
  available?: boolean;
}

export interface Recipe {
  id: number | string;
  title: string;
  servings?: number;
  prepTimeMinutes?: number;
  ovenTimeMinutes?: number;
  waitTimeMinutes?: number;
  ingredients: RecipeIngredient[];
  instructions?: string[];
  imageUrl?: string;
  url?: string;
}

export interface StoreInfo {
  id: number;
  name: string;
  street: string;
  postalCode: string;
  city: string;
  distanceKm?: number;
  isOpenNow?: boolean;
  openingHours?: Record<string, string>;
  facilities?: string[];
}
