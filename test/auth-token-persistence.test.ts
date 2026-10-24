import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "appie-auth-persist-"));
const tokensFile = path.join(tmpDir, "tokens.json");
const blocker = path.join(tmpDir, "blocker");
fs.writeFileSync(blocker, "not a directory");
const unwritableFile = path.join(blocker, "appie-mcp", "tokens.json");

process.env.APPIE_TOKENS_FILE = tokensFile;
delete process.env.AH_TOKENS_FILE;
delete process.env.APPIE_REFRESH_TOKEN;
delete process.env.AH_REFRESH_TOKEN;

const {
  AUTH_CONFIG,
  AhAuthError,
  FileTokenStore,
  MemoryTokenStore,
  HttpTokenStore,
  assertTokensPathWritable,
  authFetch,
  getTokensFilePath,
  getTokenStore,
  loadTokens,
  refreshTokens,
  getValidAccessToken,
  resolveRefreshToken,
  saveTokens,
  setTokenStore,
} = await import("../src/auth.js");

type Call = { url: string; body: any };
let calls: Call[] = [];

function installFetch(handler: (url: string, body: any) => any): void {
  calls = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    return handler(url, body);
  };
}

function json(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
    async text() {
      return JSON.stringify(data);
    },
  };
}

function seed(overrides: Record<string, any> = {}): void {
  fs.writeFileSync(
    tokensFile,
    JSON.stringify({
      access_token: "test_access_token",
      refresh_token: "rt-file",
      expires_in: 7200,
      saved_at: new Date().toISOString(),
      ...overrides,
    }),
    { mode: 0o600 }
  );
}

test("the rotated refresh token is persisted to the resolved tokens file", async () => {
  seed({ refresh_token: "rt-old" });

  installFetch((url, body) => {
    assert.equal(body.refreshToken, "rt-old");
    return json({
      access_token: "acc-new",
      refresh_token: "rt-new",
      expires_in: 7200,
    });
  });

  const refreshed = await refreshTokens();
  assert.equal(refreshed.refresh_token, "rt-new");

  const onDisk = JSON.parse(fs.readFileSync(tokensFile, "utf-8"));
  assert.equal(onDisk.refresh_token, "rt-new");
  assert.equal(onDisk.access_token, "acc-new");
});

test("a stored refresh token wins over a differing APPIE_REFRESH_TOKEN", async () => {
  seed({ refresh_token: "rt-on-disk" });
  process.env.APPIE_REFRESH_TOKEN = "rt-in-env";

  try {
    const { token, source } = resolveRefreshToken(loadTokens() as any);
    assert.equal(token, "rt-on-disk");
    assert.equal(source, "file");

    installFetch((url, body) => {
      assert.equal(body.refreshToken, "rt-on-disk");
      return json({ access_token: "acc-1", refresh_token: "rt-disk-rotated", expires_in: 7200 });
    });

    await refreshTokens();
    assert.equal(calls[0].body.refreshToken, "rt-on-disk");
  } finally {
    delete process.env.APPIE_REFRESH_TOKEN;
  }
});

test("the env token is still the bootstrap value when no tokens file exists", async () => {
  if (fs.existsSync(tokensFile)) fs.unlinkSync(tokensFile);
  process.env.APPIE_REFRESH_TOKEN = "rt-bootstrap";

  try {
    const { token, source } = resolveRefreshToken(loadTokens() as any);
    assert.equal(token, "rt-bootstrap");
    assert.equal(source, "env");

    installFetch((url, body) => {
      assert.equal(body.refreshToken, "rt-bootstrap");
      return json({ access_token: "acc-fresh", refresh_token: "rt-bootstrap-rotated", expires_in: 7200 });
    });

    const refreshed = await refreshTokens();
    assert.equal(refreshed.refresh_token, "rt-bootstrap-rotated");
    assert.ok(fs.existsSync(tokensFile));
  } finally {
    delete process.env.APPIE_REFRESH_TOKEN;
  }
});

test("an unwritable tokens path fails loudly instead of continuing in memory", async () => {
  process.env.APPIE_TOKENS_FILE = unwritableFile;
  process.env.APPIE_REFRESH_TOKEN = "rt-unwritable";

  try {
    let fetchCalled = false;
    installFetch(() => {
      fetchCalled = true;
      return json({ access_token: "acc", refresh_token: "rt-consumed", expires_in: 7200 });
    });

    await assert.rejects(
      () => refreshTokens(),
      (err: any) => {
        assert.equal(err instanceof AhAuthError, true);
        assert.equal(err.code, "TOKENS_NOT_PERSISTED");
        assert.match(err.message, new RegExp(unwritableFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      }
    );
    assert.equal(fetchCalled, false, "refresh must fail before network when path is unwritable");
  } finally {
    process.env.APPIE_TOKENS_FILE = tokensFile;
    delete process.env.APPIE_REFRESH_TOKEN;
  }
});

test("saveTokens reports the failed write with the resolved path", async () => {
  process.env.APPIE_TOKENS_FILE = unwritableFile;
  try {
    assert.throws(
      () => saveTokens({ access_token: "a", refresh_token: "b" }),
      (err: any) => {
        assert.equal(err instanceof AhAuthError, true);
        assert.equal(err.code, "TOKENS_NOT_PERSISTED");
        return true;
      }
    );
  } finally {
    process.env.APPIE_TOKENS_FILE = tokensFile;
  }
});

test("custom TokenStore can be plugged in and receives rotated tokens", async () => {
  const memoryStore = new MemoryTokenStore({
    access_token: "mem-acc",
    refresh_token: "mem-rt-1",
  });
  setTokenStore(memoryStore);

  installFetch((url, body) => {
    assert.equal(body.refreshToken, "mem-rt-1");
    return json({ access_token: "mem-acc-2", refresh_token: "mem-rt-2", expires_in: 7200 });
  });

  try {
    const refreshed = await refreshTokens();
    assert.equal(refreshed.refresh_token, "mem-rt-2");
    const inMem = memoryStore.load();
    assert.equal(inMem?.refresh_token, "mem-rt-2");
  } finally {
    setTokenStore(null);
  }
});

test("concurrent refreshTokens calls are serialized and coalesced via lock", async () => {
  seed({ refresh_token: "concurrent-rt-1" });

  let refreshNetworkCalls = 0;
  installFetch(async (url, body) => {
    refreshNetworkCalls++;
    await new Promise((r) => setTimeout(r, 60));
    return json({
      access_token: "acc-concurrent",
      refresh_token: "concurrent-rt-2",
      expires_in: 7200,
    });
  });

  const [t1, t2] = await Promise.all([refreshTokens(), refreshTokens()]);
  assert.equal(t1.refresh_token, "concurrent-rt-2");
  assert.equal(t2.refresh_token, "concurrent-rt-2");
  assert.equal(refreshNetworkCalls, 1, "second concurrent call must coalesce and avoid duplicate refresh");
});

test("stale lock file is broken and recovered", async () => {
  seed({ refresh_token: "stale-lock-rt" });
  const fileStore = new FileTokenStore(() => tokensFile);
  const lockPath = fileStore.getLockFilePath();

  // Write a stale lock file with an impossible pid and old timestamp
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 99999999, host: os.hostname(), owner: "dead-owner", createdAt: Date.now() - 60000 }),
    "utf-8"
  );

  let lockWaited = false;
  await fileStore.withLock(async (ctx) => {
    lockWaited = ctx.waited;
  });

  assert.equal(lockWaited, true, "should have waited and broken the stale lock");
  assert.equal(fs.existsSync(lockPath), false, "lock file should be cleaned up after release");
});

test("concurrent refreshes with a lockless store coalesce in-process via single-flight", async () => {
  let storedTokens: any = {
    access_token: "lockless-old",
    refresh_token: "lockless-rt-1",
  };

  const locklessStore = {
    load: () => storedTokens,
    save: (t: any) => {
      storedTokens = t;
    },
  };

  setTokenStore(locklessStore);

  let fetchCalls = 0;
  installFetch(async () => {
    fetchCalls++;
    await new Promise((r) => setTimeout(r, 50));
    return json({ access_token: "lockless-acc", expires_in: 7200, refresh_token: "lockless-rt-2" });
  });

  try {
    const [t1, t2] = await Promise.all([refreshTokens(), refreshTokens()]);
    assert.equal(t1.refresh_token, "lockless-rt-2");
    assert.equal(t2.refresh_token, "lockless-rt-2");
    assert.equal(fetchCalls, 1, "lockless store must coalesce in-flight calls inside the same process");
  } finally {
    setTokenStore(null);
  }
});

test("authFetch abort stops fallback chain without replaying via https or curl", async () => {
  const controller = new AbortController();
  controller.abort();

  let fetchAttempted = false;
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    fetchAttempted = true;
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  };

  try {
    await assert.rejects(
      () =>
        authFetch("https://api.ah.nl/mobile-auth/v1/auth/token/refresh", {
          method: "POST",
          headers: {},
          signal: controller.signal,
        }),
      (err: any) => err?.name === "AbortError" || /aborted/i.test(err?.message)
    );
    assert.equal(fetchAttempted, false, "already aborted request must not even dispatch fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authFetch stops before https fallback if signal aborts during fetch attempt", async () => {
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    controller.abort();
    throw new Error("transient socket error");
  };

  try {
    await assert.rejects(
      () =>
        authFetch("https://api.ah.nl/mobile-auth/v1/auth/token/refresh", {
          method: "POST",
          headers: {},
          signal: controller.signal,
        }),
      (err: any) => err?.name === "AbortError" || /aborted/i.test(err?.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("token-store module exports match auth re-exports and resolve XDG default path", async () => {
  const tokenStoreModule = await import("../src/token-store.js");
  const authModule = await import("../src/auth.js");

  assert.equal(typeof tokenStoreModule.FileTokenStore, "function");
  assert.equal(typeof tokenStoreModule.MemoryTokenStore, "function");
  assert.equal(typeof tokenStoreModule.HttpTokenStore, "function");
  assert.equal(authModule.FileTokenStore, tokenStoreModule.FileTokenStore);
  assert.equal(authModule.MemoryTokenStore, tokenStoreModule.MemoryTokenStore);
  assert.equal(authModule.HttpTokenStore, tokenStoreModule.HttpTokenStore);

  const prevAppie = process.env.APPIE_TOKENS_FILE;
  const prevAh = process.env.AH_TOKENS_FILE;
  delete process.env.APPIE_TOKENS_FILE;
  delete process.env.AH_TOKENS_FILE;
  try {
    const resolved = tokenStoreModule.getTokensFilePath();
    assert.ok(resolved.endsWith("tokens.json"));
  } finally {
    process.env.APPIE_TOKENS_FILE = prevAppie;
    process.env.AH_TOKENS_FILE = prevAh;
  }
});
