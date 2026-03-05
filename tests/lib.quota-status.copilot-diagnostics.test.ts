import { beforeEach, describe, expect, it, vi } from "vitest";

const copilotMocks = vi.hoisted(() => ({
  getCopilotQuotaAuthDiagnostics: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  stat: vi.fn(async () => ({ mtimeMs: Date.now() })),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  getAuthPath: () => "/home/test/.config/opencode/auth.json",
  getAuthPaths: () => ["/home/test/.config/opencode/auth.json"],
  readAuthFileCached: vi.fn(async () => ({
    "github-copilot": { type: "oauth", refresh: "gho_test" },
  })),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: "/home/test/.local/share/opencode",
    configDir: "/home/test/.config/opencode",
    cacheDir: "/home/test/.cache/opencode",
    stateDir: "/home/test/.local/state/opencode",
  }),
}));

vi.mock("../src/lib/google-token-cache.js", () => ({
  getGoogleTokenCachePath: () => "/home/test/.cache/opencode/google-token-cache.json",
}));

vi.mock("../src/lib/google.js", () => ({
  getAntigravityAccountsCandidatePaths: () => ["/home/test/.config/opencode/antigravity-accounts.json"],
  readAntigravityAccounts: vi.fn(async () => []),
}));

vi.mock("../src/lib/firmware.js", () => ({
  getFirmwareKeyDiagnostics: vi.fn(async () => ({ configured: false, source: null, checkedPaths: [] })),
}));

vi.mock("../src/lib/chutes.js", () => ({
  getChutesKeyDiagnostics: vi.fn(async () => ({ configured: false, source: null, checkedPaths: [] })),
}));

vi.mock("../src/lib/qwen-local-quota.js", () => ({
  computeQwenQuota: () => ({
    day: { used: 0, limit: 1000 },
    rpm: { used: 0, limit: 60 },
  }),
  getQwenLocalQuotaPath: () => "/home/test/.local/state/opencode/opencode-quota/qwen-local-quota.json",
  readQwenLocalQuotaState: vi.fn(async () => ({ day: { used: 0 }, minute: [] })),
}));

vi.mock("../src/lib/qwen-auth.js", () => ({
  hasQwenOAuthAuth: () => false,
}));

vi.mock("../src/lib/modelsdev-pricing.js", () => ({
  getPricingSnapshotHealth: () => ({ ageMs: 0, maxAgeMs: 259200000, stale: false }),
  getPricingRefreshPolicy: () => ({ maxAgeMs: 259200000 }),
  getPricingSnapshotMeta: () => ({
    source: "bundled",
    generatedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    units: "usd_1m_tokens",
  }),
  getPricingSnapshotSource: () => "bundled",
  getRuntimePricingRefreshStatePath: () => "/home/test/.cache/opencode/opencode-quota/pricing-refresh-state.json",
  getRuntimePricingSnapshotPath: () => "/home/test/.cache/opencode/opencode-quota/pricing.json",
  listProviders: () => [],
  getProviderModelCount: () => 0,
  hasProvider: () => false,
  readPricingRefreshState: vi.fn(async () => null),
}));

vi.mock("../src/providers/registry.js", () => ({
  getProviders: () => [],
}));

vi.mock("../src/lib/version.js", () => ({
  getPackageVersion: vi.fn(async () => "2.4.0-test"),
}));

vi.mock("../src/lib/opencode-storage.js", () => ({
  getOpenCodeDbPath: () => "/home/test/.local/share/opencode/opencode.db",
  getOpenCodeDbPathCandidates: () => ["/home/test/.local/share/opencode/opencode.db"],
  getOpenCodeDbStats: vi.fn(async () => ({
    sessionCount: 0,
    messageCount: 0,
    assistantMessageCount: 0,
  })),
}));

vi.mock("../src/lib/quota-stats.js", () => ({
  aggregateUsage: vi.fn(async () => ({
    byModel: [],
    unknown: [],
    unpriced: [],
    bySourceProvider: [],
    totals: {
      unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
    },
  })),
}));

vi.mock("../src/lib/copilot.js", () => ({
  getCopilotQuotaAuthDiagnostics: copilotMocks.getCopilotQuotaAuthDiagnostics,
}));

describe("buildQuotaStatusReport copilot diagnostics", () => {
  beforeEach(() => {
    copilotMocks.getCopilotQuotaAuthDiagnostics.mockReset();
  });

  it("renders PAT override details when PAT is effective source", async () => {
    copilotMocks.getCopilotQuotaAuthDiagnostics.mockReturnValue({
      pat: {
        state: "valid",
        checkedPaths: [
          "/home/test/.config/opencode/copilot-quota-token.json",
          "/home/test/Library/Application Support/opencode/copilot-quota-token.json",
        ],
        selectedPath: "/home/test/.config/opencode/copilot-quota-token.json",
        tokenKind: "github_pat",
        config: {
          token: "github_pat_hidden",
          tier: "enterprise",
        },
      },
      oauth: {
        configured: true,
        keyName: "github-copilot",
        hasRefreshToken: true,
        hasAccessToken: false,
      },
      effectiveSource: "pat",
      override: "pat_overrides_oauth",
    });

    const { buildQuotaStatusReport } = await import("../src/lib/quota-status.js");
    const report = await buildQuotaStatusReport({
      configSource: "test",
      configPaths: [],
      enabledProviders: "auto",
      onlyCurrentModel: false,
      sessionModelLookup: "no_session",
      providerAvailability: [],
      googleRefresh: { attempted: false },
    });

    expect(report).toContain("copilot_quota_auth:");
    expect(report).toContain("- pat_state: valid");
    expect(report).toContain(
      "- pat_checked_paths: /home/test/.config/opencode/copilot-quota-token.json | /home/test/Library/Application Support/opencode/copilot-quota-token.json",
    );
    expect(report).toContain("- effective_source: pat");
    expect(report).toContain("- override: pat_overrides_oauth");
    expect(copilotMocks.getCopilotQuotaAuthDiagnostics).toHaveBeenCalledOnce();
  });

  it("renders invalid PAT and oauth effective source details", async () => {
    copilotMocks.getCopilotQuotaAuthDiagnostics.mockReturnValue({
      pat: {
        state: "invalid",
        checkedPaths: ["/home/test/.config/opencode/copilot-quota-token.json"],
        selectedPath: "/home/test/.config/opencode/copilot-quota-token.json",
        error: "Unexpected token b in JSON at position 1",
      },
      oauth: {
        configured: true,
        keyName: "github-copilot",
        hasRefreshToken: true,
        hasAccessToken: true,
      },
      effectiveSource: "oauth",
      override: "none",
    });

    const { buildQuotaStatusReport } = await import("../src/lib/quota-status.js");
    const report = await buildQuotaStatusReport({
      configSource: "test",
      configPaths: [],
      enabledProviders: "auto",
      onlyCurrentModel: false,
      sessionModelLookup: "no_session",
      providerAvailability: [],
      googleRefresh: { attempted: false },
    });

    expect(report).toContain("- pat_state: invalid");
    expect(report).toContain("- pat_error: Unexpected token b in JSON at position 1");
    expect(report).toContain("- effective_source: oauth");
    expect(report).toContain("- override: none");
  });
});
