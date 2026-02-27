/**
 * Z.ai provider wrapper.
 *
 * Normalizes Z.ai quota into generic toast entries.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { queryZaiQuota } from "../lib/zai.js";
import { isAnyProviderIdAvailable } from "../lib/provider-availability.js";

export const zaiProvider: QuotaProvider = {
  id: "zai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    return isAnyProviderIdAvailable({
      ctx,
      // Z.ai models typically use "zai" or "glm" provider ids.
      candidateIds: ["zai", "glm", "zai-coding-plan"],
      fallbackOnError: false,
    });
  },

  matchesCurrentModel(model: string): boolean {
    const lower = model.toLowerCase();
    const provider = lower.split("/")[0];
    if (provider && (provider.includes("zai") || provider.includes("glm"))) {
      return true;
    }
    return lower.includes("glm");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryZaiQuota();

    if (!result) {
      return { attempted: false, entries: [], errors: [] };
    }

    if (!result.success) {
      return {
        attempted: true,
        entries: [],
        errors: [{ label: "Z.ai", message: result.error }],
      };
    }

    const style = ctx.config.toastStyle ?? "classic";

    // Classic toast: show a single entry based on the worst remaining window
    if (style === "classic") {
      const windows: Array<{ name: string; percentRemaining: number; resetTimeIso?: string }> = [];

      if (result.windows.hourly) {
        windows.push({ name: "Hourly", ...result.windows.hourly });
      }
      if (result.windows.weekly) {
        windows.push({ name: "Weekly", ...result.windows.weekly });
      }
      if (result.windows.mcp) {
        windows.push({ name: "MCP", ...result.windows.mcp });
      }

      if (windows.length === 0) {
        return {
          attempted: true,
          entries: [{ name: result.label, percentRemaining: 0 }],
          errors: [],
        };
      }

      windows.sort((a, b) => a.percentRemaining - b.percentRemaining);
      const worst = windows[0]!;

      return {
        attempted: true,
        entries: [
          {
            name: result.label,
            percentRemaining: worst.percentRemaining,
            resetTimeIso: worst.resetTimeIso,
          },
        ],
        errors: [],
      };
    }

    // Grouped style: expose all windows
    const entries: Array<{ name: string; percentRemaining: number; group?: string; label?: string; resetTimeIso?: string }> = [];
    const group = result.label;

    const hourly = result.windows.hourly;
    if (hourly) {
      entries.push({
        name: `${group} Hourly`,
        group,
        label: "Hourly:",
        percentRemaining: hourly.percentRemaining,
        resetTimeIso: hourly.resetTimeIso,
      });
    }

    const weekly = result.windows.weekly;
    if (weekly) {
      entries.push({
        name: `${group} Weekly`,
        group,
        label: "Weekly:",
        percentRemaining: weekly.percentRemaining,
        resetTimeIso: weekly.resetTimeIso,
      });
    }

    const mcp = result.windows.mcp;
    if (mcp) {
      entries.push({
        name: `${group} MCP`,
        group,
        label: "MCP:",
        percentRemaining: mcp.percentRemaining,
        resetTimeIso: mcp.resetTimeIso,
      });
    }

    return {
      attempted: true,
      entries,
      errors: [],
    };
  },
};
