# appie-mcp

Model Context Protocol (MCP) server for **Albert Heijn (Appie)**. Connects AI assistants (like Claude Desktop, Cursor, and Continue) directly to Albert Heijn’s supermarket services.

Features include **product search**, **weekly Bonus offers**, **personal Bonus Box**, **Mijn Lijstjes (favorite lists) with item completion**, **digital receipts (kassabonnen)**, **Allerhande recipes**, and **habit-based discount alerts**.

---

## ⚡ Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Log In
Run the interactive login command:
```bash
npm run login
```
* **Seamless Authentication:** Automatically launches Google Chrome in stealth mode, opens Albert Heijn's sign-in page, intercepts the `appie://login-exit` redirect, and saves the tokens to `tokens.json`. No copy-pasting required!
* **Headless / Manual Fallback:** If you're on a headless server, run `npm run login -- --manual` to paste the authorization redirect manually.

### 3. Check Status
```bash
npm run status
```
Verifies your live Albert Heijn connection, checks your Bonus card number, and confirms session validity.

### 4. Build
```bash
npm run build
```

---

## 🛠️ MCP Tools (27 Tools)

### 1. Authentication & Member Profile
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_login` | Read | Check session status and verify customer identity & Bonus card connection. |
| `ah_get_profile` | Read | Get customer loyalty profile, name, email, and 13-digit Bonus card number. |

### 2. Product Catalog & Search
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_search_products` | Read | Search product catalog by keyword, with price sorting and bonus filters. |
| `ah_get_product` | Read | Get detailed product info (pricing, nutrition, allergens, unit sizes). |
| `ah_get_product_alternatives` | Read | Find brand swaps, store-brand alternatives, or dietary substitutes. |
| `ah_get_products_bulk` | Read | Fetch product cards in bulk for multiple product IDs (e.g. `['wi196825', 'wi187593']`). |
| `ah_get_search_suggestions` | Read | Get search query autocomplete keywords and suggestions. |
| `ah_get_predictive_favorites` | Read | Fetch predictive favorite recommendations and frequently reordered products. |

### 3. Categories & Shelves
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_get_categories` | Read | Browse top-level supermarket shelves/categories. |
| `ah_get_sub_categories` | Read | Fetch child subcategories for a given supermarket category ID. |

### 4. Promotions, Bonus Deals & Personal Bonus Box
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_get_bonus_offers` | Read | Browse active weekly Bonus folder promotions (1+1 gratis, 2e halve prijs). |
| `ah_get_personal_bonus` | Read | View the 5 personalized weekly Bonus Box offers for the member. |
| `ah_activate_personal_bonus` | Write | Activate selected weekly Bonus Box promotions for a Bonus card number. |
| `ah_get_promo_digest` | Read | Mines recent receipts to answer: *"What that I frequently buy is on Bonus discount right now?"* |

### 5. Shopping Lists & Favorites (Mijn Lijstjes)
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_get_shopping_list` | Read | Retrieve the primary in-app shopping list items and notes. |
| `ah_add_to_shopping_list` | Write | Add free-text items or products to the primary shopping list. |
| `ah_remove_from_shopping_list` | Write | Remove an item from the primary shopping list by ID. |
| `ah_get_favorite_lists` | Read | List saved custom lists (*Mijn Lijstjes*, e.g., 'Weekly Staples', 'Party'). |
| `ah_check_favorite_list_item` | Write | Tick off items as collected in a favorite list (`checked: true/false`). |

### 6. Active Online Cart
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_get_cart` | Read | Read-only view of the user's active Albert Heijn online shopping cart and order summary. |

### 7. Digital Receipts (Kassabonnen)
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_list_receipts` | Read | List in-store receipts (*kassabonnen*) with dates, store name, and totals. `page`/`size` walk the full history; a `size` above 100 is fetched in 100-row windows. |
| `ah_get_receipt_details` | Read | Inspect line items, unit prices, discounts, and payment methods for a receipt. |

### 8. Allerhande Recipes
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_search_recipes` | Read | Search official Allerhande recipes by dish name or ingredient. |
| `ah_get_recipe_details` | Read | Get step-by-step cooking instructions and mapped ingredient lists. |

### 9. Store Locator & Clearance
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_search_stores` | Read | Search nearby AH stores, facilities, and opening hours. |
| `ah_get_clearance_bargains` | Read | Query store-specific clearance markdowns (*vandaag-af* / 35% discount items). |

### 10. Diagnostics
| Tool | Type | Description |
| :--- | :---: | :--- |
| `ah_cache_stats` | Read | Report the response cache: enabled state, hits, misses, hit rate, entries, evictions. |

---

## 🗄️ Caching & Data Freshness

Albert Heijn's API sends `cache-control: no-store` and no `ETag`, so nothing can
be cached at the HTTP layer. To cut request volume (and the load a bot-managed
edge puts on your account), this server keeps a **process-local TTL cache** in
front of its single HTTP choke point.

**Scope:** in memory only, for the lifetime of the running MCP server process.
Nothing is written to disk, no cache survives a restart, and no cached response
contains your tokens.

### What is cached, and for how long

| Data | TTL | Why |
| :--- | :---: | :--- |
| Product detail (`ah_get_product`, `ah_get_product_alternatives`, `ah_get_products_bulk`) | 24 hours | A product page is stable for a day |
| Categories & sub-categories, stores, Allerhande recipes | 24 hours | Near-static reference data |
| Product search results | 30 minutes | Offer prices churn daily |
| Bonus folder, personal Bonus Box, clearance (*vandaag-af*), predictive favorites | 30 minutes | Weekly campaign, daily markdowns |
| Receipt line items (`ah_get_receipt_details`) | 30 days | A closed receipt is immutable |
| Everything else | — | See below |

### What is never cached

Your member profile, the receipt **overview** list, your shopping list, your
favorite lists, and the active online cart are **always fetched live**, never
served from the cache. Those carry live personal state, and a stale read there
would make the assistant re-add an item you just added.

### What this means for you

* **Prices and offers can be up to 30 minutes old**, and **product pages up to
  24 hours old**. A price change during that window is not reflected. If you
  need the current shelf price, say so and the assistant can rely on a
  fresh search result for a *different* term, or you can restart the server to
  drop the cache.
* **Caching is per process, not per client.** One cache instance serves every
  tool call in the server process, and an anonymous session reuses a single
  minted token instead of one per request. Only a client that spawns a
  **new process per tool call** loses the cache between calls — then every
  `ah_cache_stats` reading is all zeros however many searches precede it.
* **Kill switch:** set `APPIE_MCP_CACHE=off` to disable the cache entirely (for
  debugging, or if you need guaranteed-live data). `APPIE_MCP_CACHE_MAX_ENTRIES`
  caps the number of cached responses (default 500).
* **Verify it:** call `ah_cache_stats` for the live hit/miss counters of the
  running server. `npm run status` prints the cache *configuration* (enabled
  state and size cap) — it starts a separate process, so it cannot show the
  running server's counters.

---

## ⚙️ Configuration in Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "appie": {
      "command": "node",
      "args": ["/Users/robert/Developer/appie-mcp/dist/index.js"]
    }
  }
}
```

---

## 🔒 Safety & Guardrails
* **No Automatic Checkout:** The server does not handle payment, credit cards, or final order submission. All purchases and checkout actions remain strictly human-in-the-loop.
* **Stateless Token Refreshing:** Tokens are safely stored locally in `tokens.json` (with restricted `0600` permissions) and silently renewed in the background.

## 📄 License
MIT © Robert Schulze Dieckhoff
