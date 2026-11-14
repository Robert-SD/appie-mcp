import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AhClient } from "../client.js";
import { withJsonTool } from "./helpers.js";

export function registerReceiptTools(server: McpServer, c: AhClient): void {
  server.registerTool(
    "ah_list_receipts",
    {
      title: "List Albert Heijn Receipts",
      description:
        "List in-store cash register receipts (kassabonnen) with date, store name, and total. Pagination is real: page and size walk the whole history, and a size above 100 is fetched in 100-row windows. Always fetched live, never cached.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        page: z.number().int().min(0).default(0).describe("Page number (default 0)"),
        size: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(10)
          .describe(
            "Number of receipts to return (default 10, max 500; above 100 is fetched in 100-row windows)"
          ),
      }),
    },
    withJsonTool(({ page, size }) => c.listReceipts(page, size))
  );

  server.registerTool(
    "ah_get_receipt_details",
    {
      title: "Get Albert Heijn Receipt Details",
      description:
        "Get detailed line items, unit prices, discounts, and total amount for a specific store receipt. A closed receipt is immutable, so it is cached for 30 days.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        transaction_id: z
          .string()
          .describe("Receipt transaction ID (from ah_list_receipts)"),
      }),
    },
    withJsonTool(({ transaction_id }) => c.getReceiptDetails(transaction_id))
  );

  server.registerTool(
    "ah_get_promo_digest",
    {
      title: "Get Albert Heijn Promo Digest",
      description:
        "Answer 'of the things I frequently buy, what is on Bonus discount right now?'. Mines receipts inside the requested window — paging back to the oldest receipt that falls in it, up to 150 — and cross-references them against active offers.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        days: z
          .number()
          .int()
          .positive()
          .max(365)
          .default(90)
          .describe("Days of receipt history to scan (default 90)"),
        min_times: z
          .number()
          .int()
          .positive()
          .default(2)
          .describe("Minimum purchase count to consider frequent (default 2)"),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .default(20)
          .describe("Maximum offers to return (default 20)"),
      }),
    },
    withJsonTool(({ days, min_times, limit }) =>
      c.getPromoDigest({ days, minTimes: min_times, limit })
    )
  );
}
