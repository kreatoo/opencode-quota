import type { AuthData } from "./types.js";
import { readAuthFileCached } from "./opencode-auth.js";

export const DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS = 5_000;

export function hasQwenOAuthAuth(auth: AuthData | null | undefined): boolean {
  const qwen = auth?.["opencode-qwencode-auth"];
  return (
    !!qwen &&
    qwen.type === "oauth" &&
    typeof qwen.access === "string" &&
    qwen.access.trim().length > 0
  );
}

export async function hasQwenOAuthAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<boolean> {
  const auth = await readAuthFileCached({
    maxAgeMs: Math.max(0, params?.maxAgeMs ?? DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS),
  });
  return hasQwenOAuthAuth(auth);
}

export function isQwenCodeModelId(model?: string): boolean {
  return typeof model === "string" && model.toLowerCase().startsWith("qwen-code/");
}
