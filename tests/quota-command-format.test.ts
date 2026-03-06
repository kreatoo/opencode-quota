import { afterEach, describe, expect, it, vi } from "vitest";

import { formatQuotaCommand } from "../src/lib/quota-command-format.js";

describe("formatQuotaCommand", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("documents the main /quota printout combinations used by the default command output", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const out = formatQuotaCommand({
      entries: [
        {
          name: "Copilot",
          group: "Copilot (personal)",
          label: "Quota:",
          right: "42/300",
          percentRemaining: 86,
          resetTimeIso: "2026-01-16T00:00:00.000Z",
        },
        {
          name: "Copilot",
          group: "Copilot (business)",
          label: "Usage:",
          kind: "value",
          value: "9 used | 2026-01 | org=acme-corp | user=alice",
          resetTimeIso: "2026-02-01T00:00:00.000Z",
        },
        {
          name: "OpenAI (Pro) Hourly",
          group: "OpenAI (Pro)",
          label: "Hourly:",
          percentRemaining: 42,
          resetTimeIso: "2026-01-15T14:00:00.000Z",
        },
        {
          name: "OpenAI (Pro) Weekly",
          group: "OpenAI (Pro)",
          label: "Weekly:",
          percentRemaining: 81,
          resetTimeIso: "2026-01-18T12:00:00.000Z",
        },
        {
          name: "Claude (acct)",
          percentRemaining: 67,
          resetTimeIso: "2026-01-15T15:00:00.000Z",
        },
      ],
      errors: [{ label: "Z.ai", message: "Authentication expired" }],
      sessionTokens: {
        models: [
          { modelID: "openai/gpt-5", input: 1234, output: 567 },
          { modelID: "github-copilot/claude-sonnet-4.5", input: 987, output: 654 },
        ],
        totalInput: 2221,
        totalOutput: 1221,
      },
    });

    expect(out).toMatchInlineSnapshot(`
      "# Quota (/quota)
      → [Copilot] (personal)
        Quota: 42/300    ███████████████░░░  86% left (resets in 12h)

      → [Copilot] (business)
        Usage:           9 used | 2026-01 | org=acme-corp | user=alice (resets in 17d)

      → [OpenAI] (Pro)
        Hourly:          ████████░░░░░░░░░░  42% left (resets in 2h)
        Weekly:          ███████████████░░░  81% left (resets in 3d)

      → [Google Antigravity] (acct)
        Claude:          ████████████░░░░░░  67% left (resets in 3h)

      Session Tokens
        openai/gpt-5            1.2K in     567 out
        github-copilot/clau…     987 in     654 out

      Z.ai: Authentication expired"
    `);
  });
});
