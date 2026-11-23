import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sessionStatsSummary, type SessionStatsInput } from "../src/core/session-stats.ts";
import type { TurnUsage } from "../src/core/contracts.ts";

// The stats bar strings in core (the desktop stats bar and the phone app
// share them): honest cost, the context measurement, the CLI and plan rows.

const step = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheWriteTokens: 0, reasoningTokens: 0 };
const turn = (id: string, model: string, steps = 1): TurnUsage => ({
	id, messageId: `m_${id}`, at: "2026-11-23T10:00:00.000Z", model, steps: Array.from({ length: steps }, () => step),
});
const input = (over: Partial<SessionStatsInput> = {}): SessionStatsInput => ({
	turns: [turn("t1", "openrouter:a/x", 3)],
	pricing: { cost: 0.0123, unpriced: 0, turnCosts: { t1: 0.0123 } },
	contextTokens: 38_000,
	model: "openrouter:a/x",
	limits: new Map([["openrouter:a/x", 200_000]]),
	cliWindow: null,
	...over,
});

describe("sessionStatsSummary", () => {
	it("gives the line, the popover rows and one row for each turn", () => {
		const s = sessionStatsSummary(input());
		assert.equal(s.context, "38k / 200k");
		assert.equal(s.cost, "$0.0123");
		assert.equal(s.costTitle, "Total cost");
		assert.equal(s.cacheHitRate, 0.75);
		assert.deepEqual(s.turns, [{ label: "#1 · x · openrouter", steps: 3, cost: "$0.0123" }]);
	});

	it("never shows a fake $0.0000: no priced turn is —", () => {
		const s = sessionStatsSummary(input({ pricing: { cost: 0, unpriced: 1, turnCosts: { t1: null } } }));
		assert.equal(s.cost, "—");
		assert.equal(s.turns[0]!.cost, "—");
		assert.equal(sessionStatsSummary(input({ pricing: undefined })).unpriced, 1);
	});

	it("shows usage only for an unknown limit and ? for an unknown measurement", () => {
		assert.equal(sessionStatsSummary(input({ limits: undefined })).context, "38k");
		assert.equal(sessionStatsSummary(input({ limits: undefined })).limit, null);
		assert.equal(sessionStatsSummary(input()).limit, 200_000);
		assert.equal(sessionStatsSummary(input({ contextTokens: null })).context, "? / 200k");
	});

	it("takes a CLI alias's limit only from its own report", () => {
		const model = "claude-code:sonnet";
		const s = sessionStatsSummary(input({ model, turns: [turn("t1", model)], pricing: { cost: 0, unpriced: 1, turnCosts: { t1: null } }, cliWindow: { model, tokens: 150_000 } }));
		assert.equal(s.context, "38k / 150k");
		assert.equal(s.cliModel, true);
		assert.equal(s.cost, "CLI");
		assert.equal(s.turns[0]!.cost, "CLI");
	});

	it("names a plan turn and titles the total Usage", () => {
		const s = sessionStatsSummary(input({
			turns: [turn("t1", "openrouter:a/x"), turn("t2", "chatgpt:gpt-5")],
			pricing: { cost: 0.0011, unpriced: 0, subscription: 1, subscriptionProviders: ["ChatGPT"], turnCosts: { t1: 0.0011, t2: null } },
		}));
		assert.equal(s.costTitle, "Usage");
		assert.equal(s.cost, "$0.0011 + ChatGPT");
		assert.deepEqual(s.providers, ["ChatGPT"]);
		assert.equal(s.turns[1]!.cost, "ChatGPT");
	});
});
