/**
 * GitHub Copilot quota fetcher
 *
 * Strategy (new Copilot API reality):
 *
 * 1) Preferred: GitHub public billing API using a fine-grained PAT
 *    configured in ~/.config/opencode/copilot-quota-token.json.
 * 2) Best-effort: internal endpoint using OpenCode's stored OAuth token
 *    (legacy formats or via token exchange).
 */

import type {
  AuthData,
  CopilotAuthData,
  CopilotQuotaConfig,
  CopilotTier,
  CopilotUsageResponse,
  CopilotQuotaResult,
  QuotaError,
  CopilotResult,
} from "./types.js";
import { fetchWithTimeout } from "./http.js";
import { readAuthFile } from "./opencode-auth.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

import { existsSync, readFileSync } from "fs";
import { join } from "path";

// =============================================================================
// Constants
// =============================================================================

const GITHUB_API_BASE_URL = "https://api.github.com";
const COPILOT_INTERNAL_USER_URL = `${GITHUB_API_BASE_URL}/copilot_internal/user`;
const COPILOT_TOKEN_EXCHANGE_URL = `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`;

// Keep these aligned with current Copilot/VSC versions to avoid API heuristics.
const COPILOT_VERSION = "0.35.0";
const EDITOR_VERSION = "vscode/1.107.0";
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`;
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`;

const COPILOT_QUOTA_CONFIG_FILENAME = "copilot-quota-token.json";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Build headers for GitHub API requests
 */
const COPILOT_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  "Editor-Version": EDITOR_VERSION,
  "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
  "Copilot-Integration-Id": "vscode-chat",
};

function buildBearerHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    ...COPILOT_HEADERS,
  };
}

function buildLegacyTokenHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `token ${token}`,
    ...COPILOT_HEADERS,
  };
}

type GitHubRestAuthScheme = "bearer" | "token";

type CopilotAuthKeyName = "github-copilot" | "copilot" | "copilot-chat";

type CopilotPatTokenKind = "github_pat" | "ghp" | "other";

export type CopilotPatState = "absent" | "invalid" | "valid";

export interface CopilotPatReadResult {
  state: CopilotPatState;
  checkedPaths: string[];
  selectedPath?: string;
  config?: CopilotQuotaConfig;
  error?: string;
  tokenKind?: CopilotPatTokenKind;
}

export interface CopilotQuotaAuthDiagnostics {
  pat: CopilotPatReadResult;
  oauth: {
    configured: boolean;
    keyName: CopilotAuthKeyName | null;
    hasRefreshToken: boolean;
    hasAccessToken: boolean;
  };
  effectiveSource: "pat" | "oauth" | "none";
  override: "pat_overrides_oauth" | "none";
}

function classifyPatTokenKind(token: string): CopilotPatTokenKind {
  const trimmed = token.trim();
  if (trimmed.startsWith("github_pat_")) return "github_pat";
  if (trimmed.startsWith("ghp_")) return "ghp";
  return "other";
}

function dedupePaths(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const path of paths) {
    if (!path) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }

  return out;
}

export function getCopilotPatConfigCandidatePaths(): string[] {
  const candidates = getOpencodeRuntimeDirCandidates();
  return dedupePaths(
    candidates.configDirs.map((configDir) => join(configDir, COPILOT_QUOTA_CONFIG_FILENAME)),
  );
}

function buildGitHubRestHeaders(
  token: string,
  scheme: GitHubRestAuthScheme,
): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: scheme === "bearer" ? `Bearer ${token}` : `token ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
}

function preferredSchemesForToken(token: string): GitHubRestAuthScheme[] {
  const t = token.trim();

  // Fine-grained PATs usually prefer Bearer.
  if (t.startsWith("github_pat_")) {
    return ["bearer", "token"];
  }

  // Classic PATs historically prefer legacy `token`.
  if (t.startsWith("ghp_")) {
    return ["token", "bearer"];
  }

  return ["bearer", "token"];
}

async function readGitHubRestErrorMessage(response: Response): Promise<string> {
  const text = await response.text();

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const msg = typeof obj.message === "string" ? obj.message : null;
      const doc = typeof obj.documentation_url === "string" ? obj.documentation_url : null;
      if (msg && doc) return `${msg} (${doc})`;
      if (msg) return msg;
    }
  } catch {
    // ignore
  }

  return text.slice(0, 160);
}

function validateQuotaConfig(raw: unknown): { config: CopilotQuotaConfig | null; error?: string } {
  if (!raw || typeof raw !== "object") {
    return { config: null, error: "Config must be a JSON object" };
  }

  const obj = raw as Record<string, unknown>;
  const token = typeof obj.token === "string" ? obj.token.trim() : "";
  const tierRaw = typeof obj.tier === "string" ? obj.tier.trim() : "";
  const usernameRaw = obj.username;

  if (!token) {
    return { config: null, error: "Missing required string field: token" };
  }

  const validTiers: CopilotTier[] = ["free", "pro", "pro+", "business", "enterprise"];
  if (!validTiers.includes(tierRaw as CopilotTier)) {
    return {
      config: null,
      error: "Invalid tier; expected one of: free, pro, pro+, business, enterprise",
    };
  }

  let username: string | undefined;
  if (usernameRaw != null) {
    if (typeof usernameRaw !== "string") {
      return { config: null, error: "username must be a non-empty string when provided" };
    }
    const trimmed = usernameRaw.trim();
    if (!trimmed) {
      return { config: null, error: "username must be a non-empty string when provided" };
    }
    username = trimmed;
  }

  return {
    config: {
      token,
      tier: tierRaw as CopilotTier,
      username,
    },
  };
}

export function readQuotaConfigWithMeta(): CopilotPatReadResult {
  const checkedPaths = getCopilotPatConfigCandidatePaths();

  for (const path of checkedPaths) {
    if (!existsSync(path)) continue;

    try {
      const content = readFileSync(path, "utf-8");
      const parsed = JSON.parse(content) as unknown;
      const validated = validateQuotaConfig(parsed);

      if (!validated.config) {
        return {
          state: "invalid",
          checkedPaths,
          selectedPath: path,
          error: validated.error ?? "Invalid config",
        };
      }

      return {
        state: "valid",
        checkedPaths,
        selectedPath: path,
        config: validated.config,
        tokenKind: classifyPatTokenKind(validated.config.token),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        state: "invalid",
        checkedPaths,
        selectedPath: path,
        error: msg,
      };
    }
  }

  return {
    state: "absent",
    checkedPaths,
  };
}

async function fetchGitHubRestJsonOnce<T>(
  url: string,
  token: string,
  scheme: GitHubRestAuthScheme,
): Promise<
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string }
> {
  const response = await fetchWithTimeout(url, {
    headers: buildGitHubRestHeaders(token, scheme),
  });

  if (response.ok) {
    return { ok: true, status: response.status, data: (await response.json()) as T };
  }

  return {
    ok: false,
    status: response.status,
    message: await readGitHubRestErrorMessage(response),
  };
}

/**
 * Read Copilot auth data from auth.json
 *
 * Tries multiple key names to handle different OpenCode versions/configs.
 */
async function readCopilotAuth(): Promise<CopilotAuthData | null> {
  const authData = await readAuthFile();
  return selectCopilotAuth(authData).auth;
}

/**
 * Select Copilot OAuth auth entry from auth.json-shaped data.
 */
function selectCopilotAuth(
  authData: AuthData | null,
): { auth: CopilotAuthData | null; keyName: CopilotAuthKeyName | null } {
  if (!authData) {
    return { auth: null, keyName: null };
  }

  const candidates: Array<[CopilotAuthKeyName, CopilotAuthData | undefined]> = [
    ["github-copilot", authData["github-copilot"]],
    ["copilot", (authData as Record<string, CopilotAuthData | undefined>).copilot],
    ["copilot-chat", (authData as Record<string, CopilotAuthData | undefined>)["copilot-chat"]],
  ];

  for (const [keyName, candidate] of candidates) {
    if (!candidate) continue;
    if (candidate.type !== "oauth") continue;
    if (!candidate.refresh) continue;
    return { auth: candidate, keyName };
  }

  return { auth: null, keyName: null };
}

export function getCopilotQuotaAuthDiagnostics(authData: AuthData | null): CopilotQuotaAuthDiagnostics {
  const pat = readQuotaConfigWithMeta();
  const { auth, keyName } = selectCopilotAuth(authData);
  const oauthConfigured = Boolean(auth);

  let effectiveSource: "pat" | "oauth" | "none" = "none";
  if (pat.state === "valid") {
    effectiveSource = "pat";
  } else if (oauthConfigured) {
    effectiveSource = "oauth";
  }

  return {
    pat,
    oauth: {
      configured: oauthConfigured,
      keyName,
      hasRefreshToken: Boolean(auth?.refresh),
      hasAccessToken: Boolean(auth?.access),
    },
    effectiveSource,
    override: pat.state === "valid" && oauthConfigured ? "pat_overrides_oauth" : "none",
  };
}

function computePercentRemainingFromUsed(params: { used: number; total: number }): number {
  const { used, total } = params;
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(used) || used <= 0) return 100;
  const usedPct = Math.max(0, Math.min(100, Math.ceil((used / total) * 100)));
  return 100 - usedPct;
}

// Public billing API response types (keep local; only used here)
interface BillingUsageItem {
  product: string;
  sku: string;
  model?: string;
  unitType: string;
  grossQuantity: number;
  netQuantity: number;
  limit?: number;
}

interface BillingUsageResponse {
  timePeriod: { year: number; month?: number };
  user: string;
  usageItems: BillingUsageItem[];
}

const COPILOT_PLAN_LIMITS: Record<CopilotTier, number> = {
  free: 50,
  pro: 300,
  "pro+": 1500,
  business: 300,
  enterprise: 1000,
};

function getApproxNextResetIso(nowMs: number = Date.now()): string {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)).toISOString();
}

async function fetchPublicBillingUsage(config: CopilotQuotaConfig): Promise<BillingUsageResponse> {
  const token = config.token;
  const schemes = preferredSchemesForToken(token);

  // Prefer authenticated-user endpoint; fall back to /users/{username} for older behavior.
  const urls: string[] = [`${GITHUB_API_BASE_URL}/user/settings/billing/premium_request/usage`];
  if (config.username) {
    urls.push(
      `${GITHUB_API_BASE_URL}/users/${config.username}/settings/billing/premium_request/usage`,
    );
  }

  for (const url of urls) {
    let lastUnauthorized: { status: number; message: string } | null = null;

    for (const scheme of schemes) {
      const res = await fetchGitHubRestJsonOnce<BillingUsageResponse>(url, token, scheme);

      if (res.ok) {
        return res.data;
      }

      if (res.status === 401) {
        lastUnauthorized = { status: res.status, message: res.message };
        continue; // retry with alternate scheme
      }

      // If /user/... isn't supported for some reason, fall back to /users/... when available.
      if (res.status === 404 && url.includes("/user/")) {
        break;
      }

      throw new Error(`GitHub API error ${res.status}: ${res.message}`);
    }

    if (lastUnauthorized) {
      throw new Error(
        `GitHub API error ${lastUnauthorized.status}: ${lastUnauthorized.message} (token rejected; verify PAT and permissions)`,
      );
    }
  }

  throw new Error("GitHub API error 404: Not Found");
}

function toQuotaResultFromBilling(
  data: BillingUsageResponse,
  tier: CopilotTier,
): CopilotQuotaResult {
  const items = Array.isArray(data.usageItems) ? data.usageItems : [];

  const premiumItems = items.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      typeof item.sku === "string" &&
      (item.sku === "Copilot Premium Request" || item.sku.includes("Premium")),
  );

  const used = premiumItems.reduce((sum, item) => sum + (item.grossQuantity || 0), 0);

  const limits = premiumItems
    .map((item) => item.limit)
    .filter((n): n is number => typeof n === "number" && n > 0);

  // Prefer API-provided limits when available (more future-proof than hardcoding).
  const total = limits.length ? Math.max(...limits) : COPILOT_PLAN_LIMITS[tier];

  if (!total || total <= 0) {
    throw new Error(`Unsupported Copilot tier: ${tier}`);
  }

  const normalizedUsed = Math.max(0, used);
  const percentRemaining = computePercentRemainingFromUsed({ used: normalizedUsed, total });

  return {
    success: true,
    used: normalizedUsed,
    total,
    percentRemaining,
    resetTimeIso: getApproxNextResetIso(),
  };
}

interface CopilotTokenResponse {
  token: string;
  expires_at: number;
  refresh_in: number;
  endpoints: { api: string };
}

async function exchangeForCopilotToken(oauthToken: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(COPILOT_TOKEN_EXCHANGE_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${oauthToken}`,
        ...COPILOT_HEADERS,
      },
    });

    if (!response.ok) {
      return null;
    }

    const tokenData = (await response.json()) as CopilotTokenResponse;
    if (!tokenData || typeof tokenData.token !== "string") return null;
    return tokenData.token;
  } catch {
    return null;
  }
}

/**
 * Fetch Copilot usage from GitHub internal API.
 * Tries multiple authentication methods to handle old/new token formats.
 */
async function fetchCopilotUsage(authData: CopilotAuthData): Promise<CopilotUsageResponse> {
  const oauthToken = authData.refresh || authData.access;
  if (!oauthToken) {
    throw new Error("No OAuth token found in auth data");
  }

  const cachedAccessToken = authData.access;
  const tokenExpiry = authData.expires || 0;

  // Strategy 1: If we have a valid cached access token (from previous exchange), use it.
  if (cachedAccessToken && cachedAccessToken !== oauthToken && tokenExpiry > Date.now()) {
    const response = await fetchWithTimeout(COPILOT_INTERNAL_USER_URL, {
      headers: buildBearerHeaders(cachedAccessToken),
    });

    if (response.ok) {
      return response.json() as Promise<CopilotUsageResponse>;
    }
  }

  // Strategy 2: Try direct call with OAuth token (newer tokens generally expect Bearer).
  const directBearerResponse = await fetchWithTimeout(COPILOT_INTERNAL_USER_URL, {
    headers: buildBearerHeaders(oauthToken),
  });

  if (directBearerResponse.ok) {
    return directBearerResponse.json() as Promise<CopilotUsageResponse>;
  }

  // Strategy 2b: Legacy auth format.
  const directLegacyResponse = await fetchWithTimeout(COPILOT_INTERNAL_USER_URL, {
    headers: buildLegacyTokenHeaders(oauthToken),
  });

  if (directLegacyResponse.ok) {
    return directLegacyResponse.json() as Promise<CopilotUsageResponse>;
  }

  // Strategy 3: Exchange OAuth token for Copilot session token (new auth flow).
  const copilotToken = await exchangeForCopilotToken(oauthToken);
  if (!copilotToken) {
    const errorText = await directLegacyResponse.text();
    throw new Error(`GitHub Copilot quota unavailable: ${errorText.slice(0, 160)}`);
  }

  const exchangedResponse = await fetchWithTimeout(COPILOT_INTERNAL_USER_URL, {
    headers: buildBearerHeaders(copilotToken),
  });

  if (!exchangedResponse.ok) {
    const errorText = await exchangedResponse.text();
    throw new Error(`GitHub API error ${exchangedResponse.status}: ${errorText.slice(0, 160)}`);
  }

  return exchangedResponse.json() as Promise<CopilotUsageResponse>;
}

// =============================================================================
// Export
// =============================================================================

/**
 * Query GitHub Copilot premium requests quota
 *
 * @returns Quota result, error, or null if not configured
 */
export async function queryCopilotQuota(): Promise<CopilotResult> {
  // Strategy 1: Try public billing API with user's fine-grained PAT.
  const quotaConfigRead = readQuotaConfigWithMeta();
  if (quotaConfigRead.state === "valid" && quotaConfigRead.config) {
    try {
      const billing = await fetchPublicBillingUsage(quotaConfigRead.config);
      return toQuotaResultFromBilling(billing, quotaConfigRead.config.tier);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      } as QuotaError;
    }
  }

  // Strategy 2: Best-effort internal API using OpenCode auth.
  const auth = await readCopilotAuth();
  if (!auth) {
    return null; // Not configured
  }

  try {
    const data = await fetchCopilotUsage(auth);
    const premium = data.quota_snapshots.premium_interactions;

    if (!premium) {
      return {
        success: false,
        error: "No premium quota data",
      } as QuotaError;
    }

    if (premium.unlimited) {
      return {
        success: true,
        used: 0,
        total: -1, // Indicate unlimited
        percentRemaining: 100,
        resetTimeIso: data.quota_reset_date,
      } as CopilotQuotaResult;
    }

    const total = premium.entitlement;
    if (!Number.isFinite(total) || total <= 0) {
      return {
        success: false,
        error: "Invalid premium quota entitlement",
      } as QuotaError;
    }

    const remainingRaw =
      typeof premium.remaining === "number"
        ? premium.remaining
        : typeof premium.quota_remaining === "number"
          ? premium.quota_remaining
          : NaN;

    if (!Number.isFinite(remainingRaw)) {
      return {
        success: false,
        error: "Invalid premium quota remaining value",
      } as QuotaError;
    }

    const remaining = Math.max(0, Math.min(total, remainingRaw));
    const used = Math.max(0, total - remaining);
    const percentRemaining = computePercentRemainingFromUsed({ used, total });

    return {
      success: true,
      used,
      total,
      percentRemaining,
      resetTimeIso: data.quota_reset_date,
    } as CopilotQuotaResult;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    } as QuotaError;
  }
}

/**
 * Format Copilot quota for toast display
 *
 * @param result - Copilot quota result
 * @returns Formatted string like "Copilot 229/300 (24%)" or null
 */
export function formatCopilotQuota(result: CopilotResult): string | null {
  if (!result) {
    return null;
  }

  if (!result.success) {
    return null;
  }

  if (result.total === -1) {
    return "Copilot Unlimited";
  }

  const percentUsed = 100 - result.percentRemaining;
  return `Copilot ${result.used}/${result.total} (${percentUsed}%)`;
}
