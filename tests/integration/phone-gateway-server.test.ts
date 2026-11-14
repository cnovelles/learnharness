/**
 * Integration (mobile fork, issue 01): the phone gateway in front of the
 * REAL upstream server, with the fake OpenAI-compatible provider as the
 * only model.
 *
 *   fake provider (loopback) ← next dev (temp LH_DATA_DIR) ← gateway ← "phone" (fetch)
 *
 * Run: npm run test:phone-integration
 * It boots `next dev`, so it is not part of `npm test`. Stop any
 * `npm run desktop:dev` first: both use the `.next/dev` lock.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { startFakeProvider, type FakeProvider, type FakeRequest } from "../helpers/fake-openai-provider.ts";
import { startDevServer, type DevServer } from "../helpers/next-dev-server.ts";
import { buildAnswer, questionDataForCall } from "../../src/core/question-core.ts";

const require = createRequire(import.meta.url);
const { createPhoneAccessStore, createPhoneGateway } = require("../../electron/phone-access.cjs");

/** The per-launch desktop capability, as electron/main.cjs makes it. */
const SECRET = "d".repeat(64);
const DESKTOP = { "x-learnharness-desktop": SECRET };

const PROBE_TEXT =
	"Welcome. Before we plan anything, I want to see what you already know about the tides. " +
	"I will ask a few short questions. Answer with your best guess, and tell me how sure you are. " +
	"There is no penalty for a wrong answer: it only shows me where to start.";
const PROBE_INPUT = {
	question: "What mainly causes the ocean tides on Earth?",
	options: [
		{ label: "The gravity of the Moon", value: "moon" },
		{ label: "The wind over the oceans", value: "wind" },
		{ label: "The rotation of the Earth alone", value: "rotation" },
	],
	explanation: "The Moon's gravity pulls the near side of the oceans more than the far side.",
	correctAnswer: "moon",
};
const PROBE_DONE_INPUT = {
	assessment: {
		strands: [{ strand: "gravity and tides", assessment: "Knows the Moon causes tides. The two bulges are new." }],
		summary: "Start from the two tidal bulges.",
	},
};
const TEACH_TEXT = Array.from(
	{ length: 40 },
	(_, i) =>
		`Paragraph ${i + 1}. The Moon pulls on every part of the Earth, but it pulls harder on the near side than on the far side. ` +
		"This difference in pull stretches the oceans into two bulges, one under the Moon and one on the opposite side.",
).join("\n\n");
const PRACTICE_TEXT = "Here is your first practice problem: estimate the time between two high tides.";

let fake: FakeProvider;
let server: DevServer;
let gateway: ReturnType<typeof createPhoneGateway>;
let gatewayURL = "";
let token = "";
let deviceId = "";
let storeFile = "";

const phoneHeaders = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const phoneFetch = (p: string, init: RequestInit = {}) =>
	fetch(`${gatewayURL}${p}`, { ...init, headers: { ...phoneHeaders(), ...(init.headers as Record<string, string> | undefined) } });
const phoneJSON = async (p: string, method = "GET", body?: unknown) => {
	const res = await phoneFetch(p, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
};

type Frame = { event?: string; data: string };

/** Read SSE frames until `stop(frames)` returns true or the stream ends. */
async function readSSE(res: Response, stop: (frames: Frame[]) => boolean, timeoutMs = 60_000): Promise<{ frames: Frame[]; ended: boolean }> {
	assert.equal(res.status, 200, `SSE status ${res.status}`);
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	const frames: Frame[] = [];
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			const { value, done } = await Promise.race([
				reader.read(),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE read timeout")), Math.max(1, deadline - Date.now()))),
			]);
			if (done) return { frames, ended: true };
			buffer += decoder.decode(value, { stream: true });
			let cut: number;
			while ((cut = buffer.indexOf("\n\n")) >= 0) {
				const block = buffer.slice(0, cut);
				buffer = buffer.slice(cut + 2);
				const frame: Frame = { data: "" };
				for (const line of block.split("\n")) {
					if (line.startsWith("event: ")) frame.event = line.slice(7);
					else if (line.startsWith("data: ")) frame.data += line.slice(6);
				}
				if (frame.event === undefined && frame.data === "") continue; // comment / heartbeat
				frames.push(frame);
				if (stop(frames)) return { frames, ended: false };
			}
		}
		throw new Error("SSE read timeout");
	} finally {
		await reader.cancel().catch(() => {});
	}
}

const isDone = (frames: Frame[]) => frames.at(-1)?.data === "[DONE]";
const wireEvents = (frames: Frame[]) => frames.filter((f) => f.data && f.data !== "[DONE]").map((f) => JSON.parse(f.data));
/** The text of the newest assistant snapshot. The wire sends each
 * message_update as the whole message so far, not as a delta. */
const latestText = (frames: Frame[]) => {
	const last = wireEvents(frames)
		.filter((e) => (e.type === "message_update" || e.type === "message_end") && e.message?.role === "assistant")
		.at(-1);
	return ((last?.message.content ?? []) as any[]).filter((c) => c.type === "text").map((c) => c.text).join("");
};
const toolCallsOf = (frames: Frame[]) =>
	wireEvents(frames)
		.filter((e) => e.type === "message_end" && e.message?.role === "assistant")
		.flatMap((e) => (e.message.content as any[]).filter((c) => c.type === "toolCall"));

/** Failure context: wire event types, the fake's requests, the server log tail. */
const diag = (frames: Frame[]) =>
	`\nwire: ${JSON.stringify(wireEvents(frames).map((e) => e.type + (e.type === "error" || e.type === "turn-settled" ? JSON.stringify(e) : "")))}` +
	`\nfake: ${JSON.stringify(fake.requests.map((r) => r.role))} unscripted: ${JSON.stringify(fake.unscripted.map((r) => r.role))}` +
	`\nserver: ${server.log().slice(-2500)}`;

async function waitFor<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 60_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value !== undefined) return value;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`timed out waiting for ${what}`);
}

const userText = (request: FakeRequest) => JSON.stringify(request.body.messages.filter((m: any) => m.role === "user"));

before(async () => {
	fake = await startFakeProvider({ models: ["fake-strong", "fake-cheap"] });
	server = await startDevServer({ env: { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: SECRET }, headers: DESKTOP });
	assert.ok(!server.dataDir.includes("Application Support"), "never the user's real data folder");

	// Configure the fake as the custom endpoint, the way the desktop window does.
	const get = await fetch(`${server.url}/api/custom-provider`, { headers: DESKTOP });
	assert.equal(get.status, 200, await get.clone().text());
	const connect = await fetch(`${server.url}/api/custom-provider`, {
		method: "POST",
		headers: { ...DESKTOP, "content-type": "application/json", "if-match": get.headers.get("etag")! },
		body: JSON.stringify({ baseUrl: fake.baseUrl, authMode: "keyless" }),
	});
	assert.equal(connect.status, 200, await connect.clone().text());
	const slot = (id: string) => ({ model: { provider: "custom", id } });
	const models = await fetch(`${server.url}/api/settings/models`, {
		method: "PUT",
		headers: { ...DESKTOP, "content-type": "application/json" },
		body: JSON.stringify({ strong: slot("fake-strong"), cheap: slot("fake-cheap"), vision: slot("fake-cheap") }),
	});
	assert.equal(models.status, 200, await models.clone().text());
	// The smallest extraction chunk, so one teacher turn starts extraction.
	const graph = await fetch(`${server.url}/api/settings/graph`, {
		method: "PUT",
		headers: { ...DESKTOP, "content-type": "application/json" },
		body: JSON.stringify({ enabled: true, rendering: true, extractionChunkTokens: 500 }),
	});
	assert.equal(graph.status, 200, await graph.clone().text());

	storeFile = path.join(server.home, "phone-access.json");
	gateway = createPhoneGateway({
		store: createPhoneAccessStore(storeFile),
		target: () => ({ url: server.url, secret: SECRET }),
		info: { name: "Test Mac", version: "test" },
	});
	const address: AddressInfo = await gateway.start({ host: "127.0.0.1", port: 0 });
	gatewayURL = `http://127.0.0.1:${address.port}`;
});

after(async () => {
	await gateway?.stop();
	await server?.stop();
	await fake?.close();
});

describe("phone gateway in front of the real server", { concurrency: false }, () => {
	it("pairs with a one-use code and pings", async () => {
		const { code } = gateway.startPairing();
		const pair = await fetch(`${gatewayURL}/phone/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Test iPhone" }) });
		assert.equal(pair.status, 200);
		const paired = await pair.json();
		token = paired.token;
		deviceId = paired.deviceId;
		const again = await fetch(`${gatewayURL}/phone/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
		assert.equal(again.status, 401, "the code works once");
		const ping = await phoneJSON("/phone/v1/ping");
		assert.equal(ping.status, 200);
		assert.equal(ping.body.deviceId, deviceId);
		assert.equal(fs.readFileSync(storeFile, "utf8").includes(token), false, "the store keeps only the hash");
	});

	it("the loopback server refuses a request without the desktop secret; the gateway adds it", async () => {
		assert.equal((await fetch(`${server.url}/api/chats`)).status, 403);
		assert.equal((await phoneJSON("/api/chats")).status, 200);
	});

	it("refuses desktop-only routes even with a valid token", async () => {
		assert.equal((await phoneJSON("/api/custom-provider")).status, 403);
		assert.equal((await phoneJSON("/api/keys")).status, 403);
		assert.equal((await phoneJSON("/api/settings/models", "PUT", {})).status, 403);
	});

	let chatId = "";
	let eventsFrames: Promise<{ frames: Frame[] }>;

	it("creates a chat and lists it", async () => {
		const created = await phoneJSON("/api/chats", "POST", { title: "Tides" });
		assert.equal(created.status, 200);
		chatId = created.body.id;
		const list = await phoneJSON("/api/chats");
		assert.equal(list.status, 200);
		assert.ok(list.body.chats.some((c: any) => c.id === chatId));
		const record = await phoneJSON(`/api/chats/${chatId}`);
		assert.equal(record.status, 200);
		assert.equal(record.body.id, chatId);
		assert.equal(record.body.turnInFlight, false);
		// No turn yet: the stream answers with the settled terminal. (This also
		// compiles the stream route in dev before the timed turn below.)
		const idle = await readSSE(await phoneFetch(`/api/chats/${chatId}/stream`), isDone);
		assert.deepEqual(wireEvents(idle.frames).map((e) => e.type), ["turn-settled"]);
	});

	it("streams a prober turn, survives a disconnect and replays on reattach; /api/events reports it", async () => {
		// Watch the event channel through the gateway for the whole turn.
		const events = await phoneFetch("/api/events");
		eventsFrames = readSSE(events, (frames) => frames.some((f) => f.event === "turn-settled" && JSON.parse(f.data).chatId === chatId), 90_000);

		fake.enqueue("prober", { text: PROBE_TEXT, chunkSize: 4, chunkDelayMs: 60, toolCalls: [{ name: "probe", arguments: PROBE_INPUT }] });
		const post = await phoneJSON("/api/chat", "POST", { chatId, input: { type: "text", text: "Teach me how the tides work." } });
		assert.equal(post.status, 200, JSON.stringify(post.body));

		// First attach: read a few text chunks, then drop the connection.
		const first = await readSSE(await phoneFetch(`/api/chats/${chatId}/stream`), (frames) => latestText(frames).length >= 24);
		assert.equal(first.ended, false, `stream ended early.${diag(first.frames)}`);
		const partial = latestText(first.frames);
		assert.ok(partial.length < PROBE_TEXT.length, "disconnected before the turn ended");
		assert.ok(PROBE_TEXT.startsWith(partial));

		// The turn keeps running on the Mac. Reattach: full replay, then live, then [DONE].
		const second = await readSSE(await phoneFetch(`/api/chats/${chatId}/stream`), isDone, 60_000);
		assert.equal(wireEvents(second.frames)[0]?.type, "agent_start", "the reattached stream replays the event log from the start");
		assert.equal(latestText(second.frames), PROBE_TEXT);
		const calls = toolCallsOf(second.frames);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].name, "probe");
		assert.deepEqual(calls[0].arguments, PROBE_INPUT);

		// After the turn settles, a new attach gets the cheap terminal.
		const settled = await readSSE(await phoneFetch(`/api/chats/${chatId}/stream`), isDone);
		assert.ok(wireEvents(settled.frames).some((e) => e.type === "turn-settled"));

		const { frames } = await eventsFrames;
		const ours = frames.filter((f) => f.data && JSON.parse(f.data).chatId === chatId).map((f) => f.event);
		assert.ok(ours.includes("turn-started"), `events: ${ours.join(", ")}`);
		assert.ok(ours.includes("turn-settled"));

		const proberRequest = fake.requests.find((r) => r.role === "prober")!;
		assert.match(userText(proberRequest), /Teach me how the tides work\./);
	});

	it("answers the probe with the shared question code; the teacher takes over and extraction writes the graph", async () => {
		const record = await phoneJSON(`/api/chats/${chatId}`);
		assert.equal(record.status, 200);
		const call = (record.body.messages as any[])
			.flatMap((m) => (m.role === "assistant" ? m.content : []))
			.find((c: any) => c.type === "toolCall" && c.name === "probe");
		assert.ok(call, "the record holds the pending probe call");
		const question = questionDataForCall(call.name, call.id, call.arguments);
		const answer = buildAnswer(question, { values: ["moon"] });

		fake.enqueue("prober", { toolCalls: [{ name: "probe_done", arguments: PROBE_DONE_INPUT }] }, { text: "Good. The teacher takes over now." });
		fake.enqueue("teacher", { text: TEACH_TEXT, chunkSize: 200 });
		fake.enqueue("extractor", (request) => {
			const ids = [...JSON.stringify(request.body.messages).matchAll(/TEACHER \[([^\]]+)\]/g)].map((m) => m[1]);
			assert.ok(ids.length > 0, "the extractor sees labeled teacher passages");
			return {
				toolCalls: [
					{
						name: "submit_findings",
						arguments: {
							propositions: [
								{ id: "p1", name: "Tidal bulges", statement: "The difference in the Moon's pull across the Earth stretches the oceans into two bulges.", messageId: ids[0] },
							],
							chains: [],
						},
					},
				],
			};
		});
		fake.enqueue("auditor", { toolCalls: [{ name: "submit_review", arguments: { links: [] } }] });

		const post = await phoneJSON("/api/chat", "POST", { chatId, input: { type: "answer", toolCallId: call.id, answer } });
		assert.equal(post.status, 200, JSON.stringify(post.body));
		// The answer turn has no delays, so it can end before the attach. Either
		// way the stream ends with [DONE], and the record holds the handoff.
		const answered = await readSSE(await phoneFetch(`/api/chats/${chatId}/stream`), isDone, 60_000);
		assert.equal(answered.frames.at(-1)?.data, "[DONE]", diag(answered.frames));
		await waitFor("probe_done in the record", async () => {
			const r = await phoneJSON(`/api/chats/${chatId}`);
			const calls = (r.body.messages as any[]).flatMap((m) => (m.role === "assistant" ? m.content : [])).filter((c: any) => c.type === "toolCall");
			return calls.some((c: any) => c.name === "probe_done") ? true : undefined;
		});

		// The handoff wakes the teacher in a new turn. Wait for its text in the record.
		await waitFor("the teacher's turn in the record", async () => {
			const r = await phoneJSON(`/api/chats/${chatId}`);
			const texts = (r.body.messages as any[]).flatMap((m) => (m.role === "assistant" ? m.content : [])).filter((c: any) => c.type === "text").map((c: any) => c.text);
			return texts.includes(TEACH_TEXT) ? true : undefined;
		});
		const answerRequest = fake.requests.filter((r) => r.role === "prober")[1]!;
		assert.match(JSON.stringify(answerRequest.body.messages), /moon|Moon/);

		// Extraction runs in the background after the teacher turn.
		const nodes = await waitFor(
			"graph nodes from extraction",
			async () => {
				const g = await phoneJSON("/api/graph");
				assert.equal(g.status, 200);
				const list = (g.body.nodes ?? []) as any[];
				return list.length > 0 ? list : undefined;
			},
			90_000,
		);
		assert.ok(nodes.some((n: any) => /two bulges/.test(n.statement ?? "")), JSON.stringify(nodes));
		assert.deepEqual(fake.unscripted.map((r) => r.role), [], "no unscripted model request");
	});

	it("runs a practice turn", async () => {
		const created = await phoneJSON("/api/chats", "POST", { title: "Tide practice", kind: "practice" });
		assert.equal(created.status, 200);
		fake.enqueue("practitioner", { text: PRACTICE_TEXT, chunkSize: 4, chunkDelayMs: 60 });
		const post = await phoneJSON("/api/chat", "POST", { chatId: created.body.id, input: { type: "text", text: "Give me a problem about tides." } });
		assert.equal(post.status, 200, JSON.stringify(post.body));
		const done = await readSSE(await phoneFetch(`/api/chats/${created.body.id}/stream`), isDone, 60_000);
		assert.equal(latestText(done.frames), PRACTICE_TEXT, diag(done.frames));
		assert.ok(fake.requests.some((r) => r.role === "practitioner"));
	});

	it("a removed device gets 401 at once", async () => {
		gateway.revoke(deviceId);
		assert.equal((await phoneJSON("/phone/v1/ping")).status, 401);
		assert.equal((await phoneJSON("/api/chats")).status, 401);
		assert.deepEqual(fake.remaining(), {}, "every scripted step was used");
	});
});
