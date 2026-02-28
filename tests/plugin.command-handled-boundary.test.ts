import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMMAND_HANDLED_SENTINEL } from "../src/lib/command-handled.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
}));

vi.mock("@opencode-ai/plugin", () => {
  const makeChain = () => {
    const chain: any = {};
    chain.optional = () => chain;
    chain.describe = () => chain;
    chain.int = () => chain;
    chain.min = () => chain;
    return chain;
  };

  const toolFn = ((definition: unknown) => definition) as any;
  toolFn.schema = {
    boolean: () => makeChain(),
    number: () => makeChain(),
  };

  return { tool: toolFn };
});

vi.mock("../src/lib/config.js", () => ({
  loadConfig: mocks.loadConfig,
  createLoadConfigMeta: () => ({ source: "test", paths: [] }),
}));

vi.mock("../src/providers/registry.js", () => ({
  getProviders: mocks.getProviders,
}));

function createClient() {
  return {
    config: {
      get: vi.fn().mockResolvedValue({ data: {} }),
      providers: vi.fn().mockResolvedValue({ data: { providers: [] } }),
    },
    session: {
      get: vi.fn().mockResolvedValue({ data: {} }),
      prompt: vi.fn().mockResolvedValue({}),
    },
    tui: {
      showToast: vi.fn().mockResolvedValue({}),
    },
    app: {
      log: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("plugin command handled boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as any).__opencodeQuotaCommandCache;

    mocks.loadConfig.mockResolvedValue({
      ...DEFAULT_CONFIG,
      enabled: true,
    });
    mocks.getProviders.mockReturnValue([]);
  });

  it("propagates command-handled sentinel errors to abort command pipeline", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-1",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
  });

  it("rethrows non-sentinel errors", async () => {
    mocks.getProviders.mockReturnValue([
      {
        id: "boom-provider",
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockRejectedValue(new Error("boom")),
      },
    ]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({ client: createClient() } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-2",
      } as any),
    ).rejects.toThrow("boom");
  });
});
