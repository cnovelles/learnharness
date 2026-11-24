/**
 * THE GRAPH COST LABELS: the text of the graph pipeline cost number, its
 * panel (`GraphCostPanel` in components/graph-view.tsx) and the run pills.
 * The desktop view and the phone app share them, so both show the same
 * strings. Pure and browser-safe: no DOM, no React, no `node:` import. The
 * phone imports this file directly. The dollars come from the server fold
 * (core/cost-summary.ts); these helpers only format them.
 */

import type { GraphCostSummary, RecentRun, StageCost } from "./cost-summary.ts";
import { displayCostTotals } from "./graph-view-model.ts";
import { planCostLabel } from "./usage-format.ts";

/** The plan fields that every cost level can carry. */
type PlanFields = { subscriptionRuns?: number; subscriptionProviders?: string[] };

/** Compact token display: 45231 → "45.2k"; absent → "—". */
export function formatGraphTokens(n: number | undefined): string {
	if (n === undefined) return "—";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Relative time for run rows: "now", "12m", "3h", "2d". */
export function runTimeAgo(startedAt: number, now: number = Date.now()): string {
	const mins = Math.round((now - startedAt) / 60_000);
	if (mins < 1) return "now";
	if (mins < 60) return `${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

/** Run/stage cost at 3 decimals (pipeline pennies are real money at this
 *  scale); headline totals use 2. Null (unpriced model) renders "—". */
export function formatRunCost(dollars: number | null, providers: readonly string[] = []): string {
	return planCostLabel(dollars, providers, (value) => `$${value.toFixed(3)}`);
}

/** The plan providers of a cost level ("ChatGPT" for an old record). */
export function graphProviders(value: PlanFields): string[] {
	return value.subscriptionProviders ?? ((value.subscriptionRuns ?? 0) > 0 ? ["ChatGPT"] : []);
}

/** The runs of a stage that have a price (not unpriced, not a plan run). */
function pricedRuns(stage: StageCost): number {
	return stage.runs - stage.unpricedRuns - (stage.subscriptionRuns ?? 0);
}

/** The cost number: the shown stages' dollars at 2 decimals, or "—". */
export function graphUsageLabel(costs: Pick<GraphCostSummary, "stages">): string {
	const stages = [costs.stages.extraction, costs.stages.audit];
	const providers = [...new Set(stages.flatMap(graphProviders))];
	const priced = stages.some((stage) => pricedRuns(stage) > 0);
	const dollars = displayCostTotals(costs).totalDollars;
	return planCostLabel(priced ? dollars : null, providers, (value) => `$${value.toFixed(2)}`);
}

/** The panel rows, in the panel order. */
export function graphCostStageRows(costs: Pick<GraphCostSummary, "stages">): [string, StageCost][] {
	return [
		["Extraction", costs.stages.extraction],
		["Audit", costs.stages.audit],
	];
}

/** A stage's cost: "—" when no run of it has a price. */
export function stageCostLabel(stage: StageCost): string {
	return formatRunCost(pricedRuns(stage) <= 0 ? null : stage.dollars, graphProviders(stage));
}

/** The "+N unpriced" count of a stage row, or null when the row shows none. */
export function stageUnpricedCount(stage: StageCost): number | null {
	const shows = stage.unpricedRuns > 0 && (pricedRuns(stage) > 0 || (stage.subscriptionRuns ?? 0) > 0);
	return shows ? stage.unpricedRuns : null;
}

/** A stage's tokens: "71.2k in / 80.9k out". */
export function stageTokensLabel(stage: Pick<StageCost, "tokens">): string {
	return `${formatGraphTokens(stage.tokens.inputTokens)} in / ${formatGraphTokens(stage.tokens.outputTokens)} out`;
}

/** A recent run's cost, with " +1 unpriced" for an unpriced plan run. */
export function recentRunCostLabel(run: Pick<RecentRun, "dollars"> & PlanFields): string {
	const unpriced = run.dollars === null && run.subscriptionRuns === 1 ? " +1 unpriced" : "";
	return `${formatRunCost(run.dollars, graphProviders(run))}${unpriced}`;
}

/** A run pill's seconds since the start, never below 0. */
export function pipelineRunSeconds(startedAt: number, now: number = Date.now()): number {
	return Math.max(0, Math.round((now - startedAt) / 1000));
}
