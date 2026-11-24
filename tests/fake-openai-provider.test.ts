/**
 * The fake OpenAI-compatible provider (tests/helpers/fake-openai-provider.ts)
 * against the app's real custom-endpoint engine: pi-ai's openai-completions
 * client must read the fake's text, reasoning and tool-call stream exactly.
 * If this passes, the server integration test (tests/integration/) can trust
 * the fake as a model.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fake-provider-"));
const originalEnv = process.env;
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}),
	NODE_ENV: "test",
	HOME: scratch,
	LH_DATA_DIR: scratch,
	LH_AUTH_FILE: path.join(scratch, "auth.json"),
	LH_IGNORE_ENV_KEYS: "1",
};
fs.writeFileSync(path.join(scratch, "auth.json"), "{}");

const { writeSettings } = await import("../src/store/settings.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");
await import("../src/server/keys.ts");
const { authorizeFixture } = await import("./helpers/custom-provider-auth.ts");
const { startFakeProvider, roleOf } = await import("./helpers/fake-openai-provider.ts");

let fake: Awaited<ReturnType<typeof startFakeProvider>>;
before(async () => {
	fake = await startFakeProvider();
	writeSettings({ version: 1, customProvider: authorizeFixture({ baseUrl: fake.baseUrl, authMode: "keyless", models: [{ id: "fake-strong", context: 200000, reasoning: true }] }) });
});
after(async () => {
	await fake.close();
	process.env = originalEnv;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } }) as any;
const run = (tools: string[]) => {
	const engine = piEngineForSpec({ provider: "custom", id: "fake-strong" });
	const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }], tools: tools.map(tool) } as any);
	return engine.streamFn(engine.model, context, {}).result();
};

test("roleOf names each agent by its tools", () => {
	assert.equal(roleOf(["probe", "probe_done", "ask_user_question"]), "prober");
	assert.equal(roleOf(["quiz", "plan_init"]), "teacher");
	assert.equal(roleOf(["problem", "conclude"]), "practitioner");
	assert.equal(roleOf(["submit_findings"]), "extractor");
	assert.equal(roleOf(["submit_review"]), "auditor");
	assert.equal(roleOf([]), "unknown");
});

test("pi-ai reads the fake's streamed text, reasoning and tool call", async () => {
	fake.enqueue("prober", {
		reasoning: "Check the floor first.",
		text: "Let us start with one question about the tides.",
		toolCalls: [{ name: "probe", arguments: { question: "What pulls the oceans?", options: [{ label: "The Moon" }, { label: "The wind" }] } }],
		chunkSize: 5,
	});
	const message = await run(["probe", "probe_done"]);
	assert.equal(message.stopReason, "toolUse");
	const text = message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
	const thinking = message.content.filter((c: any) => c.type === "thinking").map((c: any) => c.thinking).join("");
	const calls = message.content.filter((c: any) => c.type === "toolCall") as any[];
	assert.equal(text, "Let us start with one question about the tides.");
	assert.equal(thinking, "Check the floor first.");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, "probe");
	assert.equal(calls[0].id, "call_prober_1");
	assert.deepEqual(calls[0].arguments, { question: "What pulls the oceans?", options: [{ label: "The Moon" }, { label: "The wind" }] });
	assert.equal(fake.requests.at(-1)?.role, "prober");
});

test("a role with no scripted step gets an error and is recorded", async () => {
	const before = fake.unscripted.length;
	const message = await run(["submit_findings"]);
	assert.equal(message.stopReason, "error");
	assert.equal(fake.unscripted.length, before + 1);
	assert.equal(fake.unscripted.at(-1)?.role, "extractor");
});

test("a step can be a function of the request", async () => {
	fake.enqueue("teacher", (request) => ({ text: `I saw ${request.body.messages.length} messages.` }));
	const message = await run(["plan_init"]);
	assert.equal(message.stopReason, "stop");
	assert.match((message.content[0] as any).text, /^I saw \d+ messages\.$/);
	assert.deepEqual(fake.remaining(), {});
});
