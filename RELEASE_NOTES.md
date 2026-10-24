# Release Notes: appie-mcp v0.3.1

A correctness release for the v0.3.0 response cache, which was inert in
practice: `ah_cache_stats` always answered all zeros, repeated searches were
never served from the cache, and each request cost an extra anonymous-token
round trip.

---

## 🔧 Fixes in v0.3.1

- **The cache now survives the session that fills it.** `AhClient` builds its
  cache from a process-wide singleton (`getSharedCache()`) instead of a private
  instance per client, so a deployment that constructs a client per request
  still shares one warm cache. A per-request instance was born empty on every
  tool call, which is why every counter read zero immediately after a search.
- **An anonymous session no longer flushes the cache on every call.** Cache
  entries were scoped by a digest of the bearer token, and anonymous browsing
  mints a new token per request — so the scope changed, the cache was cleared,
  and every lookup missed. Scope is now the *principal*: the stored member
  session (refresh token, which survives access-token rotation), or `anonymous`
  when no session is stored. A genuine re-login under another account still
  clears the cache.
- **The anonymous token is minted once per process**, refreshed a minute before
  it expires, instead of once per request. This removes an extra ~300 ms
  round trip from every uncached call.
- **Regression tests** cover all three: two identical calls across separately
  constructed clients hit the network once, an anonymous token rotation keeps
  serving hits, and `ah_cache_stats` reports the same cache the tool handlers
  write to.

---

# Release Notes: appie-mcp v0.3.0

We are pleased to announce **appie-mcp (v0.3.0)**. This release adds a
process-local TTL cache in front of the Albert Heijn API, cutting request
volume and speeding up repeat lookups with an explicit freshness policy,
alongside comprehensive feed pagination for receipts, weekly Bonus offers,
and the promo digest.

---

## 🌟 What's New in v0.3.0

- **TTL Response Cache (`src/cache.ts`)**: A small in-memory cache with LRU
  eviction, TTL expiry, namespace invalidation and single-flight coalescing,
  hooked into the single HTTP choke point (`AhClient.request()`). No tool
  surface changed for the cached calls.
- **Allowlist Policy**: Only routes with a classified volatility are cached —
  product detail and catalog reference data for 24 hours, search results and
  Bonus/clearance offers for 30 minutes, closed receipt line items for 30 days.
  Every new route is uncached until it is classified.
- **Never Cached**: The member profile, the receipt **overview** list, shopping
  lists, favorite lists and the active cart are always fetched live, so a
  read-after-write can never serve stale personal state.
- **Invalidation on Write**: Activating a personal Bonus Box drops the cached
  Bonus Box and predictive favorites; shopping list and favorite list writes
  drop their namespaces.
- **Observability**: New read-only tool `ah_cache_stats` reports hits, misses,
  hit rate, entries and evictions. `npm run status` prints the cache
  *configuration* (enabled state and size cap) — it runs in its own process, so
  only the tool can report the running server's counters.
- **Receipt Feed Pagination (`ah_list_receipts`)**: Switched to Albert Heijn's
  GraphQL `OffsetLimitPagination` (offset, limit) to walk the full transaction
  history in 100-row server windows. Supports `page` and `size` up to 500
  without being truncated to the first 20 items.
- **Bonus Folder Pagination (`ah_get_bonus_offers`)**: Added `page` and `limit`
  (default 30, max 100) parameters, making the entire weekly Bonus folder
  (>300 distinct deals) fully browsable.
- **Full-Window Promo Digest (`ah_get_promo_digest`)**: Walks receipt history in
  50-receipt pages back to the requested cutoff date (bounded safely at 150
  receipts) so long-range digests analyze actual purchase history rather than
  stopping at 30 receipts.
- **Review Hardening**: Cache entries are scoped to the authenticated
  principal (a re-login can never read the previous account's cached data),
  a failed response is never cached, a response carrying a domain-level failure
  (a null receipt, an empty product card) stays retryable instead of being
  replayed for the whole TTL, and an invalid size cap falls back to the
  default instead of silently disabling eviction.
- **Kill Switch**: `APPIE_MCP_CACHE=off` disables the cache entirely,
  `APPIE_MCP_CACHE_MAX_ENTRIES` caps its size (default 500).
- **README Disclosure**: A new *Caching & Data Freshness* section documents
  every TTL, what is never cached, and the staleness a caller can expect.

---

# Release Notes: appie-mcp v0.2.0

We are pleased to announce **appie-mcp (v0.2.0)**. This release migrates customer profile and digital receipts endpoints from retired Albert Heijn legacy REST routes to AH's official GraphQL surface, resolving 404 NOT_FOUND errors.

---

## 🌟 What's New in v0.2.0

- **GraphQL Profile Service (`FetchMember`)**: Replaces the deprecated `/mobile-services/member/v1/profile` (which returned 404) with Albert Heijn's GraphQL `FetchMember` operation. Accurately retrieves customer name, email address, member ID, and 13-digit Bonus card number.
- **GraphQL Digital Receipts Service (`FetchPosReceiptsPage`)**: Replaces deprecated `/mobile-services/v1/receipts` (which returned 404) with GraphQL `FetchPosReceiptsPage`. Restores historical receipts lookup, store locations, and purchase totals.
- **GraphQL Receipt Line Items (`FetchPosReceiptsDetails`)**: Replaces deprecated `/mobile-services/v2/receipts/{id}` with GraphQL `FetchPosReceiptsDetails`. Resolves product names, quantities, unit prices, line totals, and discounts.
- **Habit-Based Deals Restored (`ah_get_promo_digest`)**: With receipt parsing restored, proactive sales alerts mining past frequent grocery purchases against weekly national and personal Bonus deals are fully operational.
- **Shopping List Fallback**: Added graceful fallback to the handscanner list endpoint (`handscanner/v1/lists`) if `/mobile-services/shoppinglist/v2` returns 404.

---

# Release Notes: appie-mcp v0.1.0

We are pleased to announce the initial release of **appie-mcp (v0.1.0)**, an open-source Model Context Protocol (MCP) server for **Albert Heijn (Appie)**. This server enables AI assistants (such as Claude Desktop, Cursor, Continue, and autonomous coding agents) to interact directly with Albert Heijn's supermarket services.

---

## 🌟 Highlights

- **26 Complete MCP Tools**: Full coverage of Albert Heijn APIs, covering customer profile, product catalog, weekly bonus folders, personal Bonus Box, shopping lists, digital receipts, Allerhande recipes, active cart, and store locators.
- **Automated Authentication**: One-click stealth browser login flow that launches Chrome, intercepts authentication tokens, and safely stores them with restricted permissions (`0600`).
- **Habit-Based Deals (`ah_get_promo_digest`)**: Cross-references frequent purchases from digital cash register receipts with live weekly promotions to proactively notify users when their favorites go on sale.
- **Graceful Error Handling**: 404 and empty search results in recipe lookups return friendly fallback structures instead of throwing unhandled exceptions.
- **Continuous Integration**: Automated CI workflows testing across Node.js 20.x and 22.x LTS runtimes.

---

## 🛠️ Complete Tool Directory (26 Tools)

### 1. Authentication & Member Profile
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_login` | Read | Verify Albert Heijn session status, member identity, and Bonus card connection. |
| `ah_get_profile` | Read | Retrieve customer loyalty profile, name, email, and 13-digit Bonus card number. |

### 2. Product Search & Catalog
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_search_products` | Read | Search supermarket catalog by query with sorting and bonus-only filters. |
| `ah_get_product` | Read | Inspect detailed product specifications, nutritional values, allergens, and prices. |
| `ah_get_product_alternatives` | Read | Find brand swaps, store-brand alternatives, or dietary substitutes for a product. |
| `ah_get_products_bulk` | Read | Fetch product cards in bulk for multiple product IDs (e.g. `['wi196825', 'wi187593']`). |
| `ah_get_search_suggestions` | Read | Get search query autocomplete keywords and suggestions. |
| `ah_get_predictive_favorites` | Read | Retrieve predictive favorite recommendations and reorder candidates. |

### 3. Categories & Shelves
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_get_categories` | Read | Browse top-level supermarket departments and category shelves. |
| `ah_get_sub_categories` | Read | Fetch child subcategories for a given category ID. |

### 4. Promotions, Bonus Deals & Bonus Box
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_get_bonus_offers` | Read | Browse active weekly national Bonus folder promotions (1+1 gratis, 2e halve prijs). |
| `ah_get_personal_bonus` | Read | Retrieve personalized weekly 5-deal Bonus Box promotions for the member. |
| `ah_activate_personal_bonus` | Write | Activate selected weekly Bonus Box offers for a Bonus card number. |
| `ah_get_promo_digest` | Read | Cross-reference past receipt history against current promotions to find staple discounts. |

### 5. Shopping Lists & Favorite Lists (Mijn Lijstjes)
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_get_shopping_list` | Read | Retrieve primary in-app shopping list items and free-text notes. |
| `ah_add_to_shopping_list` | Write | Add products or free-text grocery items to the primary shopping list. |
| `ah_remove_from_shopping_list` | Write | Remove an item from the primary shopping list by ID. |
| `ah_get_favorite_lists` | Read | Retrieve user's custom favorite lists (*Mijn Lijstjes*) and item counts. |
| `ah_check_favorite_list_item` | Write | Mark items as checked/collected (or unchecked) in a favorite list. |

### 6. Active Online Cart
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_get_cart` | Read | Read-only view of the user's active Albert Heijn online shopping cart and order summary. |

### 7. Digital Receipts (Kassabonnen)
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_list_receipts` | Read | List recent in-store receipts (*kassabonnen*) with store location, date, and totals. |
| `ah_get_receipt_details` | Read | Get complete line items, discounts, unit prices, and payment details for a receipt. |

### 8. Allerhande Recipes
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_search_recipes` | Read | Search Allerhande recipe collection by dish title, ingredient, or dietary preference. |
| `ah_get_recipe_details` | Read | Get step-by-step cooking instructions and mapped ingredient lists. |

### 9. Store Locator & Clearance
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_search_stores` | Read | Search nearby Albert Heijn stores by city or postal code with opening hours and facilities. |
| `ah_get_clearance_bargains` | Read | Fetch today-only dynamic clearance markdowns (*vandaag-af* / 35% discount items) by store ID. |

---

## 🔒 Security & Safety
- **Human-in-the-Loop Checkout**: No automated order submission or payment processing.
- **Safe Token Storage**: Session tokens are saved to `tokens.json` with user-only permissions (`0600`).
- **Read-Only / Safe Hints**: Write tools are clearly identified with MCP annotations (`readOnlyHint: false`).
