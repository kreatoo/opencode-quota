/**
 * Verbose quota status formatter for /quota.
 *
 * This is intentionally more verbose than the toast:
 * - Always shows reset countdown when available
 * - Uses one line per limit, grouped under provider headers
 * - Includes session token summary (input/output per model)
 */

import type { QuotaToastError, SessionTokensData } from "./entries.js";
import { isValueEntry } from "./entries.js";
import { bar, clampInt, padRight } from "./format-utils.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import type { ToastGroupEntry } from "./toast-format-grouped.js";
import { renderSessionTokensLines } from "./session-tokens-format.js";

/**
 * Format reset time in compact form (different from toast countdown).
 * Uses seconds/minutes/hours/days format for /quota command.
 */
function formatResetTimeSeconds(diffSeconds: number): string {
  if (!Number.isFinite(diffSeconds) || diffSeconds <= 0) return "now";
  if (diffSeconds < 60) return `${Math.ceil(diffSeconds)}s`;
  if (diffSeconds < 3600) return `${Math.ceil(diffSeconds / 60)}m`;
  if (diffSeconds < 86400) return `${Math.round(diffSeconds / 3600)}h`;
  return `${Math.round(diffSeconds / 86400)}d`;
}

function formatResetsIn(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diffSeconds = (t - Date.now()) / 1000;
  return ` (resets in ${formatResetTimeSeconds(diffSeconds)})`;
}

function looksLikeGoogleModel(label: string): boolean {
  const x = label.toLowerCase();
  return x === "claude" || x === "g3pro" || x === "g3flash" || x === "g3image";
}

function coerceGrouped(entries: ToastGroupEntry[]): ToastGroupEntry[] {
  const out: ToastGroupEntry[] = [];
  for (const e of entries) {
    if (e.group) {
      out.push(e);
      continue;
    }

    // Heuristic for Google entries currently named like "Claude (abc..gmail)".
    const m = e.name.match(/^(.+?)\s*\((.+)\)\s*$/);
    if (m && looksLikeGoogleModel(m[1]!.trim())) {
      out.push({
        ...e,
        group: `Google Antigravity (${m[2]!.trim()})`,
        label: `${m[1]!.trim()}:`,
      });
      continue;
    }

    // Default: treat the whole name as one grouped row.
    out.push({ ...e, group: e.name, label: "Status:" });
  }
  return out;
}

export function formatQuotaCommand(params: {
  entries: ToastGroupEntry[];
  errors: QuotaToastError[];
  sessionTokens?: SessionTokensData;
}): string {
  const entries = coerceGrouped(params.entries);

  const groupOrder: string[] = [];
  const groups = new Map<string, ToastGroupEntry[]>();
  for (const e of entries) {
    const g = (e.group ?? "").trim();
    if (!g) continue;
    const list = groups.get(g);
    if (list) list.push(e);
    else {
      groupOrder.push(g);
      groups.set(g, [e]);
    }
  }

  const lines: string[] = [];
  lines.push("# Quota (/quota)");

  const barWidth = 18;
  const leftCol = 16;

  for (let i = 0; i < groupOrder.length; i++) {
    const g = groupOrder[i]!;
    const list = groups.get(g) ?? [];

    if (i > 0) lines.push("");

    lines.push(`→ ${formatGroupedHeader(g)}`);

    for (const row of list) {
      const label = (row.label ?? row.name).trim();
      const leftText = row.right ? `${label} ${row.right}` : label;
      const labelCol = padRight(leftText, leftCol);
      const suffix = formatResetsIn(row.resetTimeIso);

      if (isValueEntry(row)) {
        lines.push(`  ${labelCol} ${row.value}${suffix}`);
        continue;
      }

      const pct = clampInt(row.percentRemaining, 0, 100);
      lines.push(`  ${labelCol} ${bar(pct, barWidth)}  ${pct}% left${suffix}`);
    }
  }

  // Add session token summary (if data available and non-empty)
  const tokenLines = renderSessionTokensLines(params.sessionTokens);
  if (tokenLines.length > 0) {
    lines.push("");
    lines.push(...tokenLines);
  }

  if (params.errors.length > 0) {
    lines.push("");
    for (const err of params.errors) {
      lines.push(`${err.label}: ${err.message}`);
    }
  }

  return lines.join("\n");
}
