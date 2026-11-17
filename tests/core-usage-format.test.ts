/**
 * THE USAGE FORMAT HELPERS (src/core/usage-format.ts) — the money, token
 * and context strings that the desktop stats bar, the activity dock and
 * the phone app share. The component modules re-export the same
 * functions; this file pins the core module and the re-exports.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	catalogLimits,
	contextLimitForModel,
	formatContextMeasurement,
	formatTokens,
	formatUsd,
	planCostLabel,
	prettyModel,
	splitQualified,
} from "../src/core/usage-format.ts";
import * as componentFormat from "../components/usage-format.ts";

describe("core usage format: money", () => {
	it("formatUsd keeps two decimals at $1 and more, four below", () => {
		assert.equal(formatUsd(0), "$0.0000");
		assert.equal(formatUsd(0.01234), "$0.0123");
		assert.equal(formatUsd(0.99999), "$1.0000");
		assert.equal(formatUsd(1), "$1.00");
		assert.equal(formatUsd(12.345), "$12.35");
	});

	it("planCostLabel joins the dollars and the subscription labels, else a dash", () => {
		assert.equal(planCostLabel(null, undefined), "—");
		assert.equal(planCostLabel(0.5, undefined), "$0.5000");
		assert.equal(planCostLabel(2, true), "$2.00 + ChatGPT");
		assert.equal(planCostLabel(null, "Claude"), "Claude");
		assert.equal(planCostLabel(null, ["Claude", "Claude", "ChatGPT"]), "Claude + ChatGPT");
		assert.equal(planCostLabel(1.5, false, (d) => `${d} USD`), "1.5 USD");
	});
});

describe("core usage format: tokens and models", () => {
	it("formatTokens trims to k and M without a trailing .0", () => {
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(999), "999");
		assert.equal(formatTokens(1000), "1k");
		assert.equal(formatTokens(38_000), "38k");
		assert.equal(formatTokens(38_450), "38.5k");
		assert.equal(formatTokens(1_000_000), "1M");
		assert.equal(formatTokens(1_234_567), "1.2M");
	});

	it("splitQualified and prettyModel keep the model id and the provider apart", () => {
		assert.deepEqual(splitQualified("openrouter:z-ai/glm-5"), { provider: "openrouter", id: "z-ai/glm-5" });
		assert.deepEqual(splitQualified("bare-id"), { provider: null, id: "bare-id" });
		assert.equal(prettyModel("z-ai/glm-5:free"), "glm-5:free");
		assert.equal(prettyModel("openrouter:z-ai/glm-5", true), "glm-5 · openrouter");
	});
});

describe("core usage format: context", () => {
	it("formatContextMeasurement shows the limit only when known", () => {
		assert.equal(formatContextMeasurement(42_000, 200_000), "42k / 200k");
		assert.equal(formatContextMeasurement(42_000, null), "42k");
		assert.equal(formatContextMeasurement(null, 100_000), "? / 100k");
		assert.equal(formatContextMeasurement(null, null), "?");
	});

	it("catalogLimits keys the known windows by provider:id and skips unknown ones", () => {
		const limits = catalogLimits({ models: [
			{ provider: "anthropic", id: "fixture", contextWindow: 100_000 },
			{ provider: "openrouter", id: "z-ai/glm-5", contextWindow: null },
		] } as unknown as Parameters<typeof catalogLimits>[0]);
		assert.deepEqual([...limits], [["anthropic:fixture", 100_000]]);
	});

	it("contextLimitForModel uses the catalog, or the session's own CLI report for CLI models", () => {
		const limits = new Map([["anthropic:fixture", 100_000]]);
		const cli = { model: "claude-code:opus", tokens: 200_000 };
		assert.equal(contextLimitForModel("anthropic:fixture", limits, cli), 100_000);
		assert.equal(contextLimitForModel("anthropic:other", limits, cli), null);
		assert.equal(contextLimitForModel("claude-code:opus", limits, cli), 200_000);
		assert.equal(contextLimitForModel("claude-code:sonnet", limits, cli), null);
		assert.equal(contextLimitForModel("claude-code:opus", limits), null);
		assert.equal(contextLimitForModel(undefined, limits, cli), null);
		assert.equal(contextLimitForModel("anthropic:fixture", undefined), null);
	});
});

describe("core usage format: the component module re-exports core", () => {
	it("components/usage-format.ts gives the same functions", () => {
		assert.equal(componentFormat.formatUsd, formatUsd);
		assert.equal(componentFormat.formatTokens, formatTokens);
		assert.equal(componentFormat.planCostLabel, planCostLabel);
		assert.equal(componentFormat.prettyModel, prettyModel);
		assert.equal(componentFormat.splitQualified, splitQualified);
	});
});
