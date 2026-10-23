import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { exec } from "node:child_process";
import * as https from "node:https";
import { fileURLToPath } from "node:url";
import { TokensData } from "./types.js";

export const AUTH_CONFIG = {
  domain: "login.ah.nl",
  api_base: "https://api.ah.nl",
  client_id: "appie-android",
  redirect_uri: "appie://login-exit",
  user_agent: "Appie/9.47.3",
  client_name: "Appie",
  client_version: "9.47.3",
  application: "NL",
  locale: "nl-NL",
} as const;

export class AhAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AhAuthError";
    this.code = code;
  }
}

export function getProjectDir(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.resolve(here, "..");
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  } catch {
    // Ignore
  }
  return process.cwd();
}

export function getTokensFilePath(): string {
  const envPath = process.env.APPIE_TOKENS_FILE || process.env.AH_TOKENS_FILE;
  if (envPath) return path.resolve(envPath.replace(/^~/, os.homedir()));

  // 1. Primary: tokens.json in project root
  const projectFile = path.join(getProjectDir(), "tokens.json");
  if (fs.existsSync(projectFile)) return projectFile;

  // 2. Working directory tokens.json
  const cwdFile = path.resolve(process.cwd(), "tokens.json");
  if (fs.existsSync(cwdFile)) return cwdFile;

  // 3. Fallback to global config (~/.config/appie-mcp/tokens.json)
  const globalConfig = path.join(os.homedir(), ".config", "appie-mcp", "tokens.json");
  if (fs.existsSync(globalConfig)) return globalConfig;

  // 4. Fallback to container data dir (/data/tokens.json)
  const containerData = "/data/tokens.json";
  if (fs.existsSync(containerData)) return containerData;

  return projectFile;
}

export function loadTokens(): TokensData | null {
  const filePath = getTokensFilePath();
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  return null;
}

export function saveTokens(tokens: TokensData): void {
  try {
    const filePath = getTokensFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), "utf-8");
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Ignore permissions failure on Windows
    }
  } catch {
    // Ignore if running in a read-only environment
  }
}

export function buildAuthorizeUrl(): string {
  const params = new URLSearchParams({
    client_id: AUTH_CONFIG.client_id,
    redirect_uri: AUTH_CONFIG.redirect_uri,
    response_type: "code",
  });
  return `https://${AUTH_CONFIG.domain}/secure/oauth/authorize?${params.toString()}`;
}

/**
 * Resilient fetch for AH API requests with mobile user agent.
 */
export async function authFetch(
  urlStr: string,
  options: { method: string; headers?: Record<string, string>; body?: string }
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any> }> {
  let lastErr: any = null;
  const mergedHeaders: Record<string, string> = {
    "User-Agent": AUTH_CONFIG.user_agent,
    "X-ClientName": AUTH_CONFIG.client_name,
    "X-ClientVersion": AUTH_CONFIG.client_version,
    "X-Application": "AHWEBSHOP",
    "X-Accept-Language": AUTH_CONFIG.locale,
    "Deliver-Errors-In-Json": "true",
    ...(options.headers || {}),
  };

  // 1. Try global fetch with transient error retry
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(urlStr, {
        method: options.method,
        headers: mergedHeaders,
        body: options.body,
      });
    } catch (err: any) {
      lastErr = err;
      const isEbadf =
        err?.message?.includes("EBADF") ||
        err?.cause?.code === "EBADF" ||
        err?.cause?.message?.includes("EBADF");
      if (isEbadf) break;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }

  // 2. Try node:https with isolated agent
  try {
    return await new Promise((resolve, reject) => {
      const parsed = new URL(urlStr);
      const postData = options.body || "";
      const reqHeaders = {
        ...mergedHeaders,
        ...(postData ? { "Content-Length": String(Buffer.byteLength(postData)) } : {}),
      };

      const agent = new https.Agent({ keepAlive: false });
      const req = https.request(
        parsed,
        {
          method: options.method || "POST",
          headers: reqHeaders,
          agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf-8");
            resolve({
              ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
              status: res.statusCode || 0,
              text: async () => body,
              json: async () => JSON.parse(body),
            });
          });
        }
      );
      req.on("error", (e) => reject(e));
      if (postData) req.write(postData);
      req.end();
    });
  } catch (httpsErr: any) {
    lastErr = httpsErr;
  }

  // 3. Fallback to system curl
  try {
    const { execFile } = await import("node:child_process");
    return await new Promise((resolve, reject) => {
      const delimiter = "---HTTP_STATUS---";
      const args = [
        "-s",
        "-S",
        "-X",
        options.method || "POST",
        "-w",
        `${delimiter}%{http_code}`,
        urlStr,
      ];
      for (const [k, v] of Object.entries(mergedHeaders)) {
        args.push("-H", `${k}: ${v}`);
      }
      if (options.body) {
        args.push("-d", options.body);
      }
      execFile("curl", args, (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`curl failed: ${err.message} (${stderr})`));
        }
        const idx = stdout.lastIndexOf(delimiter);
        const body = idx >= 0 ? stdout.slice(0, idx) : stdout;
        const statusStr = idx >= 0 ? stdout.slice(idx + delimiter.length).trim() : "0";
        const statusCode = parseInt(statusStr, 10) || 0;
        resolve({
          ok: statusCode >= 200 && statusCode < 300,
          status: statusCode,
          text: async () => body,
          json: async () => JSON.parse(body),
        });
      });
    });
  } catch (curlErr: any) {
    throw lastErr || curlErr;
  }
}

export async function exchangeCode(
  codeOrUrl: string,
  opts: { save?: boolean } = {}
): Promise<TokensData> {
  let code = codeOrUrl.trim();
  if (code.startsWith("appie://") || code.includes("?")) {
    try {
      const parsed = new URL(code.replace(/^appie:\/\//, "https://dummy/"));
      const c = parsed.searchParams.get("code");
      if (c) code = c;
    } catch {
      // Fallback
    }
  }

  const tokenUrl = `${AUTH_CONFIG.api_base}/mobile-auth/v1/auth/token`;
  const payload = {
    clientId: AUTH_CONFIG.client_id,
    code,
  };

  const resp = await authFetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new AhAuthError(
      "TOKEN_EXCHANGE_FAILED",
      `Albert Heijn token exchange failed (${resp.status}): ${errText}`
    );
  }

  const tokens = (await resp.json()) as TokensData;
  tokens.saved_at = new Date().toISOString();
  tokens.is_anonymous = false;

  if (opts.save) {
    saveTokens(tokens);
  }

  return tokens;
}

export async function refreshTokens(existing?: TokensData): Promise<TokensData> {
  const tokens = existing || loadTokens();
  const rToken = tokens?.refresh_token || process.env.APPIE_REFRESH_TOKEN || process.env.AH_REFRESH_TOKEN;

  if (!rToken) {
    throw new AhAuthError(
      "MISSING_REFRESH_TOKEN",
      "No Albert Heijn refresh_token is available. Run 'appie-mcp login' to re-authenticate."
    );
  }

  const tokenUrl = `${AUTH_CONFIG.api_base}/mobile-auth/v1/auth/token/refresh`;
  const payload = {
    clientId: AUTH_CONFIG.client_id,
    refreshToken: rToken,
  };

  const resp = await authFetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new AhAuthError(
      "TOKEN_REFRESH_FAILED",
      `Albert Heijn token refresh failed (${resp.status}): ${errText}`
    );
  }

  const refreshed = (await resp.json()) as TokensData;
  refreshed.saved_at = new Date().toISOString();
  refreshed.is_anonymous = false;

  // Preserve refresh token if the response omitted a rotated token
  if (!refreshed.refresh_token) {
    refreshed.refresh_token = rToken;
  }

  saveTokens(refreshed);
  return refreshed;
}

export async function getAnonymousToken(): Promise<TokensData> {
  const tokenUrl = `${AUTH_CONFIG.api_base}/mobile-auth/v1/auth/token/anonymous`;
  const payload = { clientId: AUTH_CONFIG.client_id };

  const resp = await authFetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new AhAuthError(
      "ANONYMOUS_AUTH_FAILED",
      `Albert Heijn anonymous token request failed (${resp.status}): ${errText}`
    );
  }

  const tokens = (await resp.json()) as TokensData;
  tokens.saved_at = new Date().toISOString();
  tokens.is_anonymous = true;
  return tokens;
}

/**
 * Anonymous access tokens are minted per process, not per request: AH returns a
 * brand-new token on every mint, and re-minting per call threw away the cache
 * scope and added an extra round-trip to every upstream fetch.
 */
let anonymousTokenCache: { accessToken: string; expiresAt: number } | null = null;

export function clearAnonymousTokenCache(): void {
  anonymousTokenCache = null;
}

async function getCachedAnonymousToken(): Promise<string> {
  const now = Date.now();
  if (anonymousTokenCache && anonymousTokenCache.expiresAt > now) {
    return anonymousTokenCache.accessToken;
  }

  const anon = await getAnonymousToken();
  const lifetimeMs = Math.max(0, (anon.expires_in ?? 3600) * 1000);
  // Renew a minute early so a request never starts with a dying token.
  anonymousTokenCache = {
    accessToken: anon.access_token,
    expiresAt: now + Math.max(0, lifetimeMs - 60_000),
  };
  return anon.access_token;
}

export async function getValidAccessToken(): Promise<string> {
  const tokens = loadTokens();
  let accessToken = tokens?.access_token;
  const refreshToken = tokens?.refresh_token || process.env.APPIE_REFRESH_TOKEN || process.env.AH_REFRESH_TOKEN;

  if (!accessToken && !refreshToken) {
    // If no user session is available, fallback to an anonymous token for search/browsing
    return getCachedAnonymousToken();
  }

  let shouldRefresh = false;
  if (!accessToken) {
    shouldRefresh = true;
  } else if (tokens?.saved_at) {
    try {
      const savedAt = new Date(tokens.saved_at).getTime();
      const ageSec = (Date.now() - savedAt) / 1000;
      const expiresIn = tokens.expires_in || 7200; // AH default is 2 hours
      if (ageSec > expiresIn - 600) {
        shouldRefresh = true;
      }
    } catch {
      // Ignore
    }
  }

  if (shouldRefresh && refreshToken) {
    try {
      const fresh = await refreshTokens(tokens || undefined);
      accessToken = fresh.access_token;
    } catch {
      // If refresh failed and we have an existing token, attempt using it or fallback to anon
      if (!accessToken) {
        return getCachedAnonymousToken();
      }
    }
  }

  return accessToken || (await getCachedAnonymousToken());
}

let stealthConfigured = false;

export async function loginWithBrowser(
  url: string
): Promise<{ redirectUrl: string; close: () => Promise<void> } | null> {
  let chromium: any;
  try {
    const pwe = await import("playwright-extra");
    const stealthMod = await import("puppeteer-extra-plugin-stealth");
    const stealth = (stealthMod as any).default || stealthMod;
    chromium = pwe.chromium;
    if (!stealthConfigured) {
      chromium.use(stealth());
      stealthConfigured = true;
    }
  } catch {
    try {
      const pw = await import("playwright");
      chromium = pw.chromium;
    } catch {
      return null;
    }
  }

  const profileDir = path.join(os.homedir(), ".config", "appie-mcp", "browser_profile");
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch {
    // Ignore
  }

  const isHeadless = process.env.APPIE_HEADLESS === "true" || process.env.CI === "true";

  const launchOptions = {
    headless: isHeadless,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--no-sandbox",
    ],
    viewport: { width: 1280, height: 800 },
  };

  let context: any = null;
  try {
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        channel: "chrome",
        ...launchOptions,
      });
    } catch {
      context = await chromium.launchPersistentContext(profileDir, launchOptions);
    }

    const page = context.pages()[0] || (await context.newPage());

    console.log("\n🌐 Opening Albert Heijn login in Chrome...");
    console.log("👉 Please sign in to your Albert Heijn account in the browser window.");
    console.log("   (Your redirect callback will be captured automatically — no copy/paste needed!)\n");

    return await new Promise<{ redirectUrl: string; close: () => Promise<void> } | null>((resolve) => {
      let resolved = false;

      const closeHandler = async () => {
        try {
          await context?.close();
        } catch {
          // Ignore
        }
      };

      const handleUrl = (targetUrl: string) => {
        if (!resolved && targetUrl.startsWith("appie://login-exit")) {
          resolved = true;
          console.log("⚡ Captured Albert Heijn OAuth redirect callback automatically!");
          resolve({ redirectUrl: targetUrl, close: closeHandler });
        }
      };

      page.on("request", (req: any) => handleUrl(req.url()));
      page.on("requestfailed", (req: any) => handleUrl(req.url()));
      page.on("framenavigated", (frame: any) => {
        if (frame === page.mainFrame()) {
          handleUrl(frame.url());
        }
      });

      page.on("close", () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      });

      page.goto(url).catch(() => {});
    });
  } catch (err) {
    console.warn(`Browser automation failed to launch: ${(err as Error).message}`);
    if (context) {
      try {
        await context.close();
      } catch {
        // Ignore
      }
    }
    return null;
  }
}

function openInSystemBrowser(url: string) {
  const platform = process.platform;
  if (platform === "darwin") {
    exec(`open "${url}"`);
  } else if (platform === "win32") {
    exec(`start "" "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

export async function loginCli(opts: { manual?: boolean; save?: boolean } = {}): Promise<void> {
  const authUrl = buildAuthorizeUrl();

  console.log("=" .repeat(60));
  console.log("🔐 ALBERT HEIJN (APPIE) MCP LOGIN");
  console.log("=" .repeat(60));

  let capturedUrl: string | null = null;
  let browserHandle: { redirectUrl: string; close: () => Promise<void> } | null = null;

  if (!opts.manual) {
    try {
      browserHandle = await loginWithBrowser(authUrl);
      if (browserHandle) {
        capturedUrl = browserHandle.redirectUrl;
      }
    } catch {
      // Fallback to manual
    }
  }

  let codeToExchange = "";

  if (capturedUrl) {
    codeToExchange = capturedUrl;
  } else {
    console.log("\n1. Open this URL in your browser to sign in to Albert Heijn:\n");
    console.log(`   ${authUrl}\n`);
    openInSystemBrowser(authUrl);

    console.log("2. After signing in, your browser will try to open 'appie://login-exit?code=...'.");
    console.log("   Copy the entire URL or the 'code' parameter from the address bar.\n");

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await rl.question("Paste the redirect URL or code here: ");
    rl.close();
    codeToExchange = answer.trim();
  }

  if (!codeToExchange) {
    console.error("❌ No code provided. Login aborted.");
    if (browserHandle) await browserHandle.close();
    process.exit(1);
  }

  console.log("\nExchanging authorization code with Albert Heijn...");
  try {
    const tokens = await exchangeCode(codeToExchange, { save: true });
    console.log("✅ Successfully authenticated with Albert Heijn!");
    console.log(`📁 Tokens saved to: ${getTokensFilePath()}`);
    console.log(`🔑 Refresh Token: ${tokens.refresh_token ? "Active" : "None"}`);
  } catch (err: any) {
    console.error(`❌ Authentication failed: ${err.message}`);
    process.exit(1);
  } finally {
    if (browserHandle) {
      await browserHandle.close();
    }
  }
}
