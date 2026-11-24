/**
 * The graph cost labels moved to src/core (issue 08 of the mobile app):
 * src/core/graph-cost-format.ts. The desktop cost number, the cost panel and
 * the run pills use them, and the phone imports the file directly. These
 * tests pin the strings that the panel showed before the move.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StageCost } from "../src/core/cost-summary.ts";
import {
	formatGraphTokens,
	formatRunCost,
	graphCostStageRows,
	graphProviders,
	graphUsageLabel,
	pipelineRunSeconds,
	recentRunCostLabel,
	runTimeAgo,
	stageCostLabel,
	stageTokensLabel,
	stageUnpricedCount,
} from "../src/core/graph-cost-format.ts";

const stage = (over: Partial<StageCost> = {}): StageCost => ({
	dollars: 0.0135,
	unpricedRuns: 0,
	runs: 8,
	tokens: { inputTokens: 71193, outputTokens: 80854, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
	...over,
});

describe("graph cost labels in src/core", () => {
	it("formats tokens as the panel", () => {
		assert.equal(formatGraphTokens(undefined), "—");
		assert.equal(formatGraphTokens(999.4), "999");
		assert.equal(formatGraphTokens(45231), "45.2k");
		assert.equal(formatGraphTokens(1_234_567), "1.23M");
	});

	it("formats the run age", () => {
		const now = 10 * 86_400_000;
		assert.equal(runTimeAgo(now - 20_000, now), "now");
		assert.equal(runTimeAgo(now - 12 * 60_000, now), "12m");
		assert.equal(runTimeAgo(now - 3 * 3_600_000, now), "3h");
		assert.equal(runTimeAgo(now - 2 * 86_400_000, now), "2d");
	});

	it("formats run costs at 3 decimals and the headline at 2", () => {
		assert.equal(formatRunCost(0.0023), "$0.002");
		assert.equal(formatRunCost(null), "—");
		assert.equal(formatRunCost(null, ["ChatGPT"]), "ChatGPT");
		const stages = { extraction: stage(), audit: stage({ dollars: 0.0098 }) };
		assert.equal(graphUsageLabel({ stages }), "$0.02");
	});

	it("shows a dash when no stage run has a price", () => {
		const stages = { extraction: stage({ unpricedRuns: 8 }), audit: stage({ runs: 0, dollars: 0 }) };
		assert.equal(graphUsageLabel({ stages }), "—");
		assert.equal(stageCostLabel(stages.extraction), "—");
		assert.equal(stageUnpricedCount(stages.extraction), null);
	});

	it("names the plan providers", () => {
		assert.deepEqual(graphProviders({ subscriptionRuns: 2 }), ["ChatGPT"]);
		assert.deepEqual(graphProviders({ subscriptionProviders: ["Claude"] }), ["Claude"]);
		assert.deepEqual(graphProviders({}), []);
		const plan = stage({ runs: 2, subscriptionRuns: 2, subscriptionProviders: ["ChatGPT"] });
		assert.equal(stageCostLabel(plan), "ChatGPT");
	});

	it("shows the stage rows, the unpriced count and the tokens", () => {
		const s = stage({ runs: 9, unpricedRuns: 1 });
		const rows = graphCostStageRows({ stages: { extraction: s, audit: stage() } });
		assert.deepEqual(rows.map(([label]) => label), ["Extraction", "Audit"]);
		assert.equal(stageCostLabel(s), "$0.013");
		assert.equal(stageUnpricedCount(s), 1);
		assert.equal(stageTokensLabel(s), "71.2k in / 80.9k out");
	});

	it("labels a recent run and the pill seconds", () => {
		assert.equal(recentRunCostLabel({ dollars: 0.0051 }), "$0.005");
		assert.equal(recentRunCostLabel({ dollars: null, subscriptionRuns: 1 }), "ChatGPT +1 unpriced");
		assert.equal(pipelineRunSeconds(1000, 13_400), 12);
		assert.equal(pipelineRunSeconds(5000, 1000), 0);
	});
});
