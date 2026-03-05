import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(() => false),
  readFileSync: vi.fn<(path: string, encoding: BufferEncoding) => string>(() => ""),
}));

const runtimeMocks = vi.hoisted(() => ({
  getOpencodeRuntimeDirCandidates: vi.fn(() => ({
    dataDirs: ["/home/test/.local/share/opencode"],
    configDirs: [
      "/home/test/.config/opencode",
      "/home/test/Library/Application Support/opencode",
    ],
    cacheDirs: ["/home/test/.cache/opencode"],
    stateDirs: ["/home/test/.local/state/opencode"],
  })),
  getOpencodeRuntimeDirs: vi.fn(() => ({
    dataDir: "/home/test/.local/share/opencode",
    configDir: "/home/test/.config/opencode",
    cacheDir: "/home/test/.cache/opencode",
    stateDir: "/home/test/.local/state/opencode",
  })),
}));

const authMocks = vi.hoisted(() => ({
  readAuthFile: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fs")>();
  return {
    ...mod,
    existsSync: fsMocks.existsSync,
    readFileSync: fsMocks.readFileSync,
  };
});

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: runtimeMocks.getOpencodeRuntimeDirCandidates,
  getOpencodeRuntimeDirs: runtimeMocks.getOpencodeRuntimeDirs,
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: authMocks.readAuthFile,
}));

const realEnv = process.env;
const patPath = "/home/test/.config/opencode/copilot-quota-token.json";

describe("queryCopilotQuota", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    process.env = { ...realEnv };
    vi.resetModules();

    fsMocks.existsSync.mockReset();
    fsMocks.readFileSync.mockReset();
    authMocks.readAuthFile.mockReset();

    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readFileSync.mockReturnValue("");
    authMocks.readAuthFile.mockResolvedValue({});
  });

  afterEach(() => {
    process.env = realEnv;
  });

  it("returns null when not configured and no PAT config", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    authMocks.readAuthFile.mockResolvedValueOnce({});

    await expect(queryCopilotQuota()).resolves.toBeNull();
  });

  it("uses PAT billing API when PAT config exists and overrides OAuth auth", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");

    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "pro",
      }),
    );

    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", refresh: "gho_oauth_token" },
    });

    const fetchMock = vi.fn(async (url: unknown, opts: RequestInit | undefined) => {
      const s = String(url);

      if (s.includes("/user/settings/billing/premium_request/usage")) {
        expect((opts?.headers as Record<string, string> | undefined)?.Authorization).toBe(
          "Bearer github_pat_123456789",
        );

        return new Response(
          JSON.stringify({
            timePeriod: { year: 2026, month: 1 },
            user: "halfwalker",
            usageItems: [
              {
                product: "copilot",
                sku: "Copilot Premium Request",
                unitType: "count",
                grossQuantity: 1,
                netQuantity: 1,
                limit: 300,
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const out = await queryCopilotQuota();
    expect(out && out.success ? out.total : -1).toBe(300);
    expect(out && out.success ? out.used : -1).toBe(1);
    expect(out && out.success ? out.percentRemaining : -1).toBe(99);
    expect(authMocks.readAuthFile).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to OAuth/internal flow when PAT config is invalid", async () => {
    const { getCopilotQuotaAuthDiagnostics, queryCopilotQuota } = await import("../src/lib/copilot.js");

    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue("{bad-json");

    const oauthAuth = {
      "github-copilot": { type: "oauth", refresh: "gho_abc" },
    };
    authMocks.readAuthFile.mockResolvedValueOnce(oauthAuth);

    const fetchMock = vi.fn(async (url: unknown) => {
      const s = String(url);
      if (s.includes("/copilot_internal/user")) {
        return new Response(
          JSON.stringify({
            copilot_plan: "pro",
            quota_reset_date: "2026-02-01T00:00:00.000Z",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 300,
                remaining: 299,
                percent_remaining: 100,
                unlimited: false,
                overage_count: 0,
                overage_permitted: false,
                quota_id: "x",
                quota_remaining: 0,
              },
            },
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const out = await queryCopilotQuota();
    expect(out && out.success ? out.total : -1).toBe(300);
    expect(out && out.success ? out.used : -1).toBe(1);
    expect(out && out.success ? out.percentRemaining : -1).toBe(99);

    const diag = getCopilotQuotaAuthDiagnostics(oauthAuth as any);
    expect(diag.pat.state).toBe("invalid");
    expect(diag.pat.selectedPath).toBe(patPath);
    expect(diag.effectiveSource).toBe("oauth");
    expect(diag.override).toBe("none");
  });

  it("returns PAT error and does not fall back to OAuth when PAT is rejected", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");

    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "pro",
      }),
    );

    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", refresh: "gho_should_not_be_used" },
    });

    const fetchMock = vi.fn(async (url: unknown) => {
      const s = String(url);

      if (s.includes("/user/settings/billing/premium_request/usage")) {
        return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });
      }

      if (s.includes("/copilot_internal/user")) {
        return new Response("unexpected oauth fallback", { status: 200 });
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const out = await queryCopilotQuota();
    expect(out && !out.success ? out.error : "").toContain("GitHub API error 403");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/copilot_internal/user"))).toBe(
      false,
    );
    expect(authMocks.readAuthFile).not.toHaveBeenCalled();
  });

  it("computes remaining percentage from entitlement/remaining when OAuth response percent is stale", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");

    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", refresh: "gho_abc" },
    });

    const fetchMock = vi.fn(async (url: unknown) => {
      const s = String(url);

      if (s.includes("/copilot_internal/user")) {
        return new Response(
          JSON.stringify({
            copilot_plan: "pro",
            quota_reset_date: "2026-02-01T00:00:00.000Z",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 300,
                remaining: 299,
                percent_remaining: 100,
                unlimited: false,
                overage_count: 0,
                overage_permitted: false,
                quota_id: "x",
                quota_remaining: 299,
              },
            },
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const out = await queryCopilotQuota();
    expect(out && out.success ? out.used : -1).toBe(1);
    expect(out && out.success ? out.percentRemaining : -1).toBe(99);
  });
});
