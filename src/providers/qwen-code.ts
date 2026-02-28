import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { computeQwenQuota, readQwenLocalQuotaState } from "../lib/qwen-local-quota.js";
import {
  DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS,
  hasQwenOAuthAuthCached,
  isQwenCodeModelId,
} from "../lib/qwen-auth.js";

type GroupedToastEntry = {
  name: string;
  percentRemaining: number;
  resetTimeIso?: string;
  group?: string;
  label?: string;
  right?: string;
};

export const qwenCodeProvider: QuotaProvider = {
  id: "qwen-code",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return await hasQwenOAuthAuthCached({
      maxAgeMs: DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS,
    });
  },

  matchesCurrentModel(model: string): boolean {
    return isQwenCodeModelId(model);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const hasAuth = await hasQwenOAuthAuthCached({
      maxAgeMs: DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS,
    });
    if (!hasAuth) {
      return { attempted: false, entries: [], errors: [] };
    }

    const quota = computeQwenQuota({ state: await readQwenLocalQuotaState() });
    const style = ctx.config.toastStyle ?? "classic";

    if (style === "grouped") {
      const entries: GroupedToastEntry[] = [
        {
          name: "Qwen Daily",
          group: "Qwen (OAuth)",
          label: "Daily:",
          right: `${quota.day.used}/${quota.day.limit}`,
          percentRemaining: quota.day.percentRemaining,
          resetTimeIso: quota.day.resetTimeIso,
        },
        {
          name: "Qwen RPM",
          group: "Qwen (OAuth)",
          label: "RPM:",
          right: `${quota.rpm.used}/${quota.rpm.limit}`,
          percentRemaining: quota.rpm.percentRemaining,
          resetTimeIso: quota.rpm.resetTimeIso,
        },
      ];

      return { attempted: true, entries, errors: [] };
    }

    return {
      attempted: true,
      entries: [
        {
          name: "Qwen Daily",
          percentRemaining: quota.day.percentRemaining,
          resetTimeIso: quota.day.resetTimeIso,
        },
        {
          name: "Qwen RPM",
          percentRemaining: quota.rpm.percentRemaining,
          resetTimeIso: quota.rpm.resetTimeIso,
        },
      ],
      errors: [],
    };
  },
};
