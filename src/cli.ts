import { getTokensFilePath, loadTokens, loginCli, refreshTokens } from "./auth.js";
import { AhClient } from "./client.js";

export async function showStatus(client: AhClient): Promise<void> {
  let tokens = await loadTokens();
  if (!tokens && (process.env.APPIE_REFRESH_TOKEN || process.env.AH_REFRESH_TOKEN)) {
    try {
      tokens = await refreshTokens();
    } catch (error: any) {
      console.error(`⚠️ Bootstrap from refresh token failed: ${error.message}`);
    }
  }

  console.log("=".repeat(60));
  console.log("📋 ALBERT HEIJN (APPIE) MCP STATUS");
  console.log("=".repeat(60));
  console.log(`Token storage: ${getTokensFilePath()}`);

  if (!tokens) {
    console.log("⚠️ No user session found. Operating in anonymous / public search mode.");
    console.log("\nRun 'npx appie-mcp login' to connect your personal Albert Heijn account.");
  } else {
    console.log(`Access Token:  ${tokens.access_token ? "✅ Present" : "❌ Missing"}`);
    console.log(`Refresh Token: ${tokens.refresh_token ? "✅ Active (Permanent)" : "❌ None"}`);
    console.log(`Last Saved:    ${tokens.saved_at || "Unknown"}`);
  }

  console.log("\nVerifying live API connection...");
  const cacheStats = client.cacheStats();
  console.log(
    `Response cache: ${cacheStats.enabled ? "enabled" : "disabled"} — ` +
      `max ${cacheStats.maxEntries} entries. ` +
      `Call ah_cache_stats for live hit/miss counters of the running server.`
  );
  try {
    const prof = await client.getProfile();
    console.log(`Customer Name: ${prof.name || "Anonymous / Public"}`);
    if (prof.bonusCardNumber) {
      console.log(`Bonus Card:    ${prof.bonusCardNumber}`);
    }
    console.log("✅ Connection healthy and operational!");
  } catch (err: any) {
    console.log(`⚠️ Note: ${err.message}`);
    console.log("Testing public product search...");
    try {
      const search = await client.searchProducts({ query: "koffie", size: 1 });
      console.log(`✅ Public API operational (${search.total} products accessible)`);
    } catch (searchErr: any) {
      console.log(`❌ API check failed: ${searchErr.message}`);
    }
  }
}

export async function runCliCommand(
  args: string[],
  client: AhClient
): Promise<boolean> {
  const cmd = args[0]?.toLowerCase();
  if (cmd === "login") {
    const manual = args.includes("--manual");
    const save = args.includes("--save");
    await loginCli({ manual, save });
    return true;
  }
  if (cmd === "status") {
    await showStatus(client);
    return true;
  }
  return false;
}
