/**
 * The session stats summary: the strings of the below-composer stats bar
 * (components/stats-bar.tsx) and its "Session stats" popover. The desktop
 * and the phone app share it, so both show the same strings. Pure and
 * browser-safe: no DOM, no React, no `node:` import. The phone imports
 * this file directly.
 *
 * Spending arrives already priced by the server through Pi's catalog and
 * calculator. Missing cost stays "—", never fake zero. Context is the
 * completed-conversation measurement; its denominator follows the selected
 * model, from the catalog or the session's CLI report.
 */

import { CLAUDE_CODE_PROVIDER } from "./contracts/claude-code.ts";
import type { TurnUsage } from "./contracts/chat.ts";
import type { cliContextWindowOf } from "./native-messages.ts";
import { sessionCacheHitRate, subscriptionLabel, subscriptionLabels, type SessionPricing } from "./prices.ts";
import { contextLimitForModel, formatContextMeasurement, formatUsd, planCostLabel, prettyModel } from "./usage-format.ts";

export interface SessionStatsInput {
	turns: readonly TurnUsage[];
	/** Absent when the server sent no pricing: every turn is unpriced. */
	pricing?: SessionPricing;
	/** Null before a completed reply or after a compaction. */
	contextTokens: number | null;
	/** The effective model, "provider:id"; undefined when unknown. */
	model: string | undefined;
	/** The catalog limits (`catalogLimits`); undefined when unknown. */
	limits: ReadonlyMap<string, number> | undefined;
	cliWindow: ReturnType<typeof cliContextWindowOf>;
}

export interface SessionStatsTurn {
	/** "#3 · deepseek-v4.1-flash · openrouter" */
	label: string;
	steps: number;
	/** "$0.0011", "—" (no price), "CLI", or a plan name ("ChatGPT"). */
	cost: string;
}

export interface SessionStatsSummary {
	/** "42k / 200k"; "?" for an unknown numerator; usage only for an unknown limit. */
	context: string;
	/** The context limit of the model, or null when it is not known. */
	limit: number | null;
	/** "$0.0123", "—" when no turn priced, with plan names ("$0.01 + ChatGPT"). */
	cost: string;
	/** "Usage" when a plan pays for a turn, else "Total cost". */
	costTitle: "Total cost" | "Usage";
	/** Observed session-wide cache reuse (0..1), or null. */
	cacheHitRate: number | null;
	unpriced: number;
	/** The plan names of the session's turns ("ChatGPT", "GitHub Copilot"). */
	providers: string[];
	/** The effective model is a Claude Code CLI alias. */
	cliModel: boolean;
	turns: SessionStatsTurn[];
}

const isCli = (model: string | undefined) => model?.startsWith(`${CLAUDE_CODE_PROVIDER}:`) === true;

export function sessionStatsSummary(input: SessionStatsInput): SessionStatsSummary {
	const { turns, pricing, contextTokens, model, limits, cliWindow } = input;
	const limit = contextLimitForModel(model, limits, cliWindow);
	const { cost = 0, unpriced = turns.length, subscription = 0 } = pricing ?? {};
	// Honest cost: dollars only when at least one turn priced; otherwise "—".
	const pricedCount = turns.length - unpriced - subscription;
	const providers = pricing?.subscriptionProviders ?? subscriptionLabels(turns.map((turn) => turn.model));
	const cliBilled = turns.some((turn) => isCli(turn.model));
	return {
		context: formatContextMeasurement(contextTokens, limit),
		limit,
		cost: planCostLabel(pricedCount > 0 ? cost : null, cliBilled ? [...providers, "CLI"] : providers),
		costTitle: subscription ? "Usage" : "Total cost",
		cacheHitRate: sessionCacheHitRate({ turns: [...turns] }),
		unpriced,
		providers,
		cliModel: isCli(model),
		turns: turns.map((turn, i) => {
			const dollars = pricing?.turnCosts[turn.id] ?? null;
			return {
				label: `#${i + 1} · ${prettyModel(turn.model, true)}`,
				steps: turn.steps.length,
				cost: isCli(turn.model) ? "CLI" : subscriptionLabel(turn.model) ?? (dollars === null ? "—" : formatUsd(dollars)),
			};
		}),
	};
}
