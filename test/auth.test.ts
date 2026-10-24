import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AUTH_CONFIG,
  AhAuthError,
  buildAuthorizeUrl,
  getTokensFilePath,
  loadTokens,
  saveTokens,
  getValidAccessToken,
  refreshTokens,
  exchangeCode,
  getAnonymousToken,
  clearAnonymousTokenCache,
} from "../src/auth.js";
import { TokensData } from "../src/types.js";

describe("auth.ts", () => {
  let tmpDir: string;
  let originalAppieTokensFile: string | undefined;
  let originalAhTokensFile: string | undefined;
  let originalRefreshToken: string | undefined;
  let originalAhRefreshToken: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "appie-auth-test-"));
    originalAppieTokensFile = process.env.APPIE_TOKENS_FILE;
    originalAhTokensFile = process.env.AH_TOKENS_FILE;
    originalRefreshToken = process.env.APPIE_REFRESH_TOKEN;
    originalAhRefreshToken = process.env.AH_REFRESH_TOKEN;
    originalFetch = globalThis.fetch;

    // Direct token storage to the isolated temp dir by default
    process.env.APPIE_TOKENS_FILE = path.join(tmpDir, "tokens.json");
    delete process.env.AH_TOKENS_FILE;
    delete process.env.APPIE_REFRESH_TOKEN;
    delete process.env.AH_REFRESH_TOKEN;
    clearAnonymousTokenCache();
  });

  afterEach(() => {
    // Restore environment variables
    if (originalAppieTokensFile !== undefined) {
      process.env.APPIE_TOKENS_FILE = originalAppieTokensFile;
    } else {
      delete process.env.APPIE_TOKENS_FILE;
    }

    if (originalAhTokensFile !== undefined) {
      process.env.AH_TOKENS_FILE = originalAhTokensFile;
    } else {
      delete process.env.AH_TOKENS_FILE;
    }

    if (originalRefreshToken !== undefined) {
      process.env.APPIE_REFRESH_TOKEN = originalRefreshToken;
    } else {
      delete process.env.APPIE_REFRESH_TOKEN;
    }

    if (originalAhRefreshToken !== undefined) {
      process.env.AH_REFRESH_TOKEN = originalAhRefreshToken;
    } else {
      delete process.env.AH_REFRESH_TOKEN;
    }

    // Restore fetch
    globalThis.fetch = originalFetch;

    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe("buildAuthorizeUrl()", () => {
    it("returns proper URL with client_id=appie-android, redirect_uri=appie://login-exit, and response_type=code", () => {
      const urlStr = buildAuthorizeUrl();
      assert.ok(urlStr.startsWith("https://login.ah.nl/secure/oauth/authorize"));

      const parsed = new URL(urlStr);
      assert.equal(parsed.protocol, "https:");
      assert.equal(parsed.hostname, "login.ah.nl");
      assert.equal(parsed.pathname, "/secure/oauth/authorize");

      assert.equal(parsed.searchParams.get("client_id"), "appie-android");
      assert.equal(parsed.searchParams.get("redirect_uri"), "appie://login-exit");
      assert.equal(parsed.searchParams.get("response_type"), "code");
    });

    it("matches AUTH_CONFIG settings", () => {
      const urlStr = buildAuthorizeUrl();
      const parsed = new URL(urlStr);
      assert.equal(parsed.searchParams.get("client_id"), AUTH_CONFIG.client_id);
      assert.equal(parsed.searchParams.get("redirect_uri"), AUTH_CONFIG.redirect_uri);
    });
  });

  describe("getTokensFilePath()", () => {
    it("respects APPIE_TOKENS_FILE override", () => {
      const customPath = path.join(tmpDir, "custom-tokens.json");
      process.env.APPIE_TOKENS_FILE = customPath;
      assert.equal(getTokensFilePath(), customPath);
    });

    it("expands tilde (~) prefix to user home directory", () => {
      process.env.APPIE_TOKENS_FILE = "~/my-appie-tokens.json";
      const expected = path.resolve(os.homedir(), "my-appie-tokens.json");
      assert.equal(getTokensFilePath(), expected);
    });

    it("falls back to AH_TOKENS_FILE when APPIE_TOKENS_FILE is unset", () => {
      delete process.env.APPIE_TOKENS_FILE;
      const customPath = path.join(tmpDir, "ah-legacy.json");
      process.env.AH_TOKENS_FILE = customPath;
      assert.equal(getTokensFilePath(), customPath);
    });
  });

  describe("loadTokens() and saveTokens()", () => {
    it("returns null when tokens file does not exist", () => {
      const targetFile = path.join(tmpDir, "nonexistent.json");
      process.env.APPIE_TOKENS_FILE = targetFile;
      assert.equal(loadTokens(), null);
    });

    it("saves and loads tokens accurately", () => {
      const tokens: TokensData = {
        access_token: "acc_12345",
        refresh_token: "ref_67890",
        expires_in: 7200,
        token_type: "Bearer",
        saved_at: "2026-10-19T20:00:00.000Z",
        is_anonymous: false,
      };

      saveTokens(tokens);
      const loaded = loadTokens();
      assert.deepEqual(loaded, tokens);
    });

    it("creates nested parent directories if they do not exist", () => {
      const nestedFile = path.join(tmpDir, "sub1", "sub2", "tokens.json");
      process.env.APPIE_TOKENS_FILE = nestedFile;

      const tokens: TokensData = {
        access_token: "nested_token",
        refresh_token: "nested_refresh",
      };

      saveTokens(tokens);
      assert.ok(fs.existsSync(nestedFile));
      assert.deepEqual(loadTokens(), tokens);
    });

    it("sets file permissions to 0o600 on POSIX platforms", () => {
      if (process.platform === "win32") return;

      const tokenFile = path.join(tmpDir, "tokens.json");
      process.env.APPIE_TOKENS_FILE = tokenFile;

      saveTokens({ access_token: "perm_token" });
      const stat = fs.statSync(tokenFile);
      const mode = stat.mode & 0o777;
      assert.equal(mode, 0o600);
    });

    it("returns null when tokens file contains corrupt JSON", () => {
      const tokenFile = path.join(tmpDir, "tokens.json");
      process.env.APPIE_TOKENS_FILE = tokenFile;

      fs.writeFileSync(tokenFile, "INVALID JSON {{{", "utf-8");
      assert.equal(loadTokens(), null);
    });
  });

  describe("token expiration and getValidAccessToken()", () => {
    it("returns existing access token when token is fresh", async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        throw new Error("fetch should not be called for fresh token");
      };

      const freshTokens: TokensData = {
        access_token: "fresh_access_token",
        refresh_token: "active_refresh_token",
        expires_in: 7200,
        saved_at: new Date().toISOString(), // Just saved
      };
      saveTokens(freshTokens);

      const token = await getValidAccessToken();
      assert.equal(token, "fresh_access_token");
      assert.equal(fetchCalled, false);
    });

    it("refreshes token when it has expired", async () => {
      const expiredTokens: TokensData = {
        access_token: "old_expired_access_token",
        refresh_token: "active_refresh_token",
        expires_in: 7200,
        saved_at: new Date(Date.now() - 8000 * 1000).toISOString(), // 8000s ago (> 7200)
      };
      saveTokens(expiredTokens);

      let refreshRequested = false;
      globalThis.fetch = async (input, init) => {
        const urlStr = String(input);
        if (urlStr.includes("/mobile-auth/v1/auth/token/refresh")) {
          refreshRequested = true;
          const body = JSON.parse(String(init?.body || "{}"));
          assert.equal(body.clientId, AUTH_CONFIG.client_id);
          assert.equal(body.refreshToken, "active_refresh_token");

          return new Response(
            JSON.stringify({
              access_token: "brand_new_access_token",
              refresh_token: "rotated_refresh_token",
              expires_in: 7200,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      };

      const token = await getValidAccessToken();
      assert.equal(refreshRequested, true);
      assert.equal(token, "brand_new_access_token");

      // Verify that tokens were saved to disk with new access and refresh tokens
      const saved = loadTokens();
      assert.equal(saved?.access_token, "brand_new_access_token");
      assert.equal(saved?.refresh_token, "rotated_refresh_token");
    });

    it("refreshes token when within the 10-minute (600s) buffer before expiration", async () => {
      // Age is 6700s, expiresIn is 7200. Remaining time is 500s (< 600s buffer).
      const nearExpiryTokens: TokensData = {
        access_token: "near_expiry_token",
        refresh_token: "active_refresh_token",
        expires_in: 7200,
        saved_at: new Date(Date.now() - 6700 * 1000).toISOString(),
      };
      saveTokens(nearExpiryTokens);

      let refreshRequested = false;
      globalThis.fetch = async (input) => {
        const urlStr = String(input);
        if (urlStr.includes("/mobile-auth/v1/auth/token/refresh")) {
          refreshRequested = true;
          return new Response(
            JSON.stringify({
              access_token: "refreshed_after_buffer_token",
              expires_in: 7200,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      };

      const token = await getValidAccessToken();
      assert.equal(refreshRequested, true);
      assert.equal(token, "refreshed_after_buffer_token");
    });

    it("refreshes token when access_token is missing but refresh_token exists", async () => {
      const refreshOnly: TokensData = {
        access_token: "",
        refresh_token: "sole_refresh_token",
      };
      saveTokens(refreshOnly);

      globalThis.fetch = async (input) => {
        const urlStr = String(input);
        if (urlStr.includes("/mobile-auth/v1/auth/token/refresh")) {
          return new Response(
            JSON.stringify({
              access_token: "recovered_access_token",
              refresh_token: "sole_refresh_token",
              expires_in: 7200,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      };

      const token = await getValidAccessToken();
      assert.equal(token, "recovered_access_token");
    });

    it("falls back to anonymous token when no tokens and no refresh token exist", async () => {
      // No tokens file
      delete process.env.APPIE_REFRESH_TOKEN;
      delete process.env.AH_REFRESH_TOKEN;

      let anonRequested = false;
      globalThis.fetch = async (input) => {
        const urlStr = String(input);
        if (urlStr.includes("/mobile-auth/v1/auth/token/anonymous")) {
          anonRequested = true;
          return new Response(
            JSON.stringify({
              access_token: "anonymous_public_token",
              expires_in: 7200,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      };

      const token = await getValidAccessToken();
      assert.equal(anonRequested, true);
      assert.equal(token, "anonymous_public_token");
    });

    it("falls back to existing access token if refresh fails", async () => {
      const expiredTokens: TokensData = {
        access_token: "fallback_access_token",
        refresh_token: "broken_refresh_token",
        expires_in: 7200,
        saved_at: new Date(Date.now() - 10000 * 1000).toISOString(),
      };
      saveTokens(expiredTokens);

      globalThis.fetch = async (input) => {
        const urlStr = String(input);
        if (urlStr.includes("/mobile-auth/v1/auth/token/refresh")) {
          return new Response("Unauthorized", { status: 401 });
        }
        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      };

      const token = await getValidAccessToken();
      assert.equal(token, "fallback_access_token");
    });
  });

  describe("AhAuthError and auth functions error handling", () => {
    it("creates an instance of AhAuthError with proper code and name", () => {
      const err = new AhAuthError("TEST_CODE", "Test error message");
      assert.ok(err instanceof Error);
      assert.ok(err instanceof AhAuthError);
      assert.equal(err.name, "AhAuthError");
      assert.equal(err.code, "TEST_CODE");
      assert.equal(err.message, "Test error message");
      assert.ok(err.stack);
    });

    it("refreshTokens throws MISSING_REFRESH_TOKEN when no refresh token is available", async () => {
      delete process.env.APPIE_REFRESH_TOKEN;
      delete process.env.AH_REFRESH_TOKEN;

      await assert.rejects(
        async () => {
          await refreshTokens();
        },
        (err: any) => {
          assert.ok(err instanceof AhAuthError);
          assert.equal(err.code, "MISSING_REFRESH_TOKEN");
          assert.ok(err.message.includes("refresh_token"));
          return true;
        }
      );
    });

    it("refreshTokens throws TOKEN_REFRESH_FAILED when API returns error", async () => {
      globalThis.fetch = async () => {
        return new Response("Invalid grant", { status: 400 });
      };

      await assert.rejects(
        async () => {
          await refreshTokens({ access_token: "", refresh_token: "bad_refresh" });
        },
        (err: any) => {
          assert.ok(err instanceof AhAuthError);
          assert.equal(err.code, "TOKEN_REFRESH_FAILED");
          assert.ok(err.message.includes("400"));
          assert.ok(err.message.includes("Invalid grant"));
          return true;
        }
      );
    });

    it("exchangeCode parses authorization code from full appie:// URL", async () => {
      let sentCode = "";
      globalThis.fetch = async (input, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        sentCode = body.code;
        return new Response(
          JSON.stringify({
            access_token: "exchanged_acc",
            refresh_token: "exchanged_ref",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const result = await exchangeCode("appie://login-exit?code=auth_code_xyz123");
      assert.equal(sentCode, "auth_code_xyz123");
      assert.equal(result.access_token, "exchanged_acc");
      assert.equal(result.is_anonymous, false);
      assert.ok(result.saved_at);
    });

    it("exchangeCode saves tokens when opts.save is true", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            access_token: "saved_acc_token",
            refresh_token: "saved_ref_token",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      await exchangeCode("direct_code_123", { save: true });
      const loaded = loadTokens();
      assert.equal(loaded?.access_token, "saved_acc_token");
      assert.equal(loaded?.refresh_token, "saved_ref_token");
    });

    it("exchangeCode throws TOKEN_EXCHANGE_FAILED when API returns error", async () => {
      globalThis.fetch = async () => {
        return new Response("Code expired", { status: 400 });
      };

      await assert.rejects(
        async () => {
          await exchangeCode("expired_code");
        },
        (err: any) => {
          assert.ok(err instanceof AhAuthError);
          assert.equal(err.code, "TOKEN_EXCHANGE_FAILED");
          assert.ok(err.message.includes("400"));
          assert.ok(err.message.includes("Code expired"));
          return true;
        }
      );
    });

    it("getAnonymousToken throws ANONYMOUS_AUTH_FAILED when API returns error", async () => {
      globalThis.fetch = async () => {
        return new Response("Server error", { status: 500 });
      };

      await assert.rejects(
        async () => {
          await getAnonymousToken();
        },
        (err: any) => {
          assert.ok(err instanceof AhAuthError);
          assert.equal(err.code, "ANONYMOUS_AUTH_FAILED");
          assert.ok(err.message.includes("500"));
          assert.ok(err.message.includes("Server error"));
          return true;
        }
      );
    });
  });
});
