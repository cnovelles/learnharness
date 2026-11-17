/**
 * Money, token and context presentation helpers (wave-4 observability UI).
 * The activity dock, the stats bar and the phone app share them, so the
 * phone shows the same strings as the desktop. Pure and browser-safe: no
 * DOM, no React, no `node:` import. The phone imports this file directly.
 */

import { CLAUDE_CODE_PROVIDER } from "./contracts/claude-code.ts";
import type { ModelCatalogResponse } from "./contracts/models.ts";
import type { cliContextWindowOf } from "./native-messages.ts";

/** USD for cent-scale money: >= $1 keeps two decimals, smaller keeps four. */
export function formatUsd(c: number): string {
	return c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`;
}

export function planCostLabel(dollars: number | null, subscription: boolean | string | readonly string[] | undefined, format = formatUsd): string {
	const labels = subscription === true ? ["ChatGPT"] : typeof subscription === "string" ? [subscription] : Array.isArray(subscription) ? [...new Set(subscription)] : [];
	return [...(dollars === null ? [] : [format(dollars)]), ...labels].join(" + ") || "—";
}

/** 38000 → "38k", 1234567 → "1.2M" — trimmed, never "38.0k". */
export function formatTokens(n: number): string {
	if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
	return String(n);
}

/** Split a provider-qualified stamp "provider:id" (the usage contracts'
 *  qualification, model-slots wave 2026-09-20) into its two coordinates.
 *  No colon = no provider qualification (a bare catalog id). */
export function splitQualified(id: string): { provider: string | null; id: string } {
	const colon = id.indexOf(":");
	if (colon === -1) return { provider: null, id };
	return { provider: id.slice(0, colon), id: id.slice(colon + 1) };
}

/** Model-only labels omit the vendor path, never versions, dates or variants.
 * Only usage callers pass `qualified`: a bare catalog id's colon belongs to
 * the model (e.g. :free), not a provider. Usage retains its provider suffix. */
export function prettyModel(id: string, qualified = false): string {
	const { provider, id: bare } = qualified ? splitQualified(id) : { provider: null, id };
	const short = bare.includes("/") ? bare.slice(bare.lastIndexOf("/") + 1) : bare;
	return provider ? `${short} · ${provider}` : short;
}

/** "42k / 200k"; an unknown numerator is "?"; an unknown limit shows usage only. */
export function formatContextMeasurement(tokens: number | null, limit: number | null): string {
	const numerator = tokens === null ? "?" : formatTokens(tokens);
	return limit === null ? numerator : `${numerator} / ${formatTokens(limit)}`;
}

/** CLI aliases have no global catalog limit: only this session's matching
 * response can supply a denominator. Other providers keep their catalog join. */
export function contextLimitForModel(model: string | undefined, limits: ReadonlyMap<string, number> | undefined,
	cliWindow: ReturnType<typeof cliContextWindowOf> = null): number | null {
	if (!model) return null;
	if (model.startsWith(`${CLAUDE_CODE_PROVIDER}:`)) return cliWindow?.model === model ? cliWindow.tokens : null;
	return limits?.get(model) ?? null;
}

/** The catalog's context limits, keyed "provider:id" — the client half of
 * the server's catalogContextLimits join. CLI aliases have no global
 * denominator: the stats bar uses that session's actual CLI report instead.
 * Missing limits always render usage-only, without a hardcoded fallback. */
export function catalogLimits(catalog: Pick<ModelCatalogResponse, "models">): Map<string, number> {
	return new Map(catalog.models.flatMap((m) => m.contextWindow === null ? [] : [[`${m.provider}:${m.id}`, m.contextWindow] as const]));
}
