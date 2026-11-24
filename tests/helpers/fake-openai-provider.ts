/**
 * Fake OpenAI-compatible provider (mobile fork, test base for issue 01).
 *
 * A loopback HTTP server that answers `GET /v1/models` and streams
 * `POST /v1/chat/completions` from a script. The app connects to it as its
 * one custom endpoint (docs/custom-providers.md), so a real server process
 * runs real agents with no model, no account and no network.
 *
 * The role of each request comes from the tool names the agent sends:
 *   prober        → has `probe_done`
 *   teacher       → has `plan_init`
 *   practitioner  → has `problem` or `conclude`
 *   extractor     → has `submit_findings`
 *   auditor       → has `submit_review`
 * Each role has its own queue of steps. A request for a role with an empty
 * queue gets HTTP 500 and is recorded in `unscripted`, so a test can fail
 * with a clear message instead of a hang.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_ROLES = ["prober", "teacher", "practitioner", "extractor", "auditor"] as const;
export type FakeRole = (typeof FAKE_ROLES)[number] | "unknown";

export interface FakeToolCall {
	name: string;
	arguments: Record<string, unknown>;
	/** Default: `call_<role>_<n>`. */
	id?: string;
}

/** One scripted model response. Text streams first, then the tool calls. */
export interface FakeStep {
	reasoning?: string;
	text?: string;
	toolCalls?: FakeToolCall[];
	/** Characters per text chunk. Default 16. */
	chunkSize?: number;
	/** Delay before each chunk, in ms. Default 0. */
	chunkDelayMs?: number;
}

/** What the fake received. `body` is the parsed JSON request. */
export interface FakeRequest {
	role: FakeRole;
	tools: string[];
	body: Record<string, any>;
}

export type FakeStepSource = FakeStep | ((request: FakeRequest) => FakeStep);
export type FakeScript = Partial<Record<FakeRole, FakeStepSource[]>>;

export interface FakeProvider {
	/** The API base URL to configure, for example `http://127.0.0.1:5123/v1`. */
	baseUrl: string;
	/** Every chat-completions request, in arrival order. */
	requests: FakeRequest[];
	/** Requests that found no scripted step. */
	unscripted: FakeRequest[];
	/** Add steps to the end of a role's queue. */
	enqueue(role: FakeRole, ...steps: FakeStepSource[]): void;
	/** Steps that are still in the queue, by role. */
	remaining(): Partial<Record<FakeRole, number>>;
	close(): Promise<void>;
}

export function roleOf(tools: readonly string[]): FakeRole {
	if (tools.includes("probe_done")) return "prober";
	if (tools.includes("plan_init")) return "teacher";
	if (tools.includes("problem") || tools.includes("conclude")) return "practitioner";
	if (tools.includes("submit_findings")) return "extractor";
	if (tools.includes("submit_review")) return "auditor";
	return "unknown";
}

function chunks(text: string, size: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
	return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeProvider(options: { script?: FakeScript; models?: string[] } = {}): Promise<FakeProvider> {
	const models: string[] = options.models?.length ? options.models : ["fake-strong", "fake-cheap"];
	const queues = new Map<FakeRole, FakeStepSource[]>();
	for (const [role, steps] of Object.entries(options.script ?? {})) queues.set(role as FakeRole, [...(steps ?? [])]);
	const requests: FakeRequest[] = [];
	const unscripted: FakeRequest[] = [];
	const counters = new Map<FakeRole, number>();
	const sockets = new Set<import("node:net").Socket>();

	async function streamStep(res: http.ServerResponse, request: FakeRequest, step: FakeStep, model: string) {
		const id = `chatcmpl-fake-${requests.length}`;
		const created = Math.floor(Date.now() / 1000);
		const send = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => {
			res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
		};
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
		const size = step.chunkSize ?? 16;
		const delay = step.chunkDelayMs ?? 0;
		send({ role: "assistant", content: "" });
		for (const part of chunks(step.reasoning ?? "", size)) {
			if (delay) await sleep(delay);
			if (res.destroyed) return;
			send({ reasoning_content: part });
		}
		for (const part of chunks(step.text ?? "", size)) {
			if (delay) await sleep(delay);
			if (res.destroyed) return;
			send({ content: part });
		}
		const calls = step.toolCalls ?? [];
		calls.forEach((call, index) => {
			const n = (counters.get(request.role) ?? 0) + 1;
			counters.set(request.role, n);
			const callId = call.id ?? `call_${request.role}_${n}`;
			const args = JSON.stringify(call.arguments);
			send({ tool_calls: [{ index, id: callId, type: "function", function: { name: call.name, arguments: "" } }] });
			for (const part of chunks(args, 64)) send({ tool_calls: [{ index, function: { arguments: part } }] });
		});
		send({}, calls.length ? "tool_calls" : "stop");
		const outputTokens = Math.ceil(((step.text ?? "").length + (step.reasoning ?? "").length) / 4) + calls.length * 20;
		res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: 100, completion_tokens: outputTokens, total_tokens: 100 + outputTokens } })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	}

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://fake.invalid");
		if (req.method === "GET" && url.pathname === "/v1/models") {
			const body = JSON.stringify({ object: "list", data: models.map((m) => ({ id: m, object: "model", owned_by: "fake", context_length: 200000 })) });
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(body);
			return;
		}
		if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
			const parts: Buffer[] = [];
			req.on("data", (c: Buffer) => parts.push(c));
			req.on("end", () => {
				let body: Record<string, any>;
				try {
					body = JSON.parse(Buffer.concat(parts).toString("utf8"));
				} catch {
					res.writeHead(400).end("invalid JSON");
					return;
				}
				const tools: string[] = Array.isArray(body.tools) ? body.tools.map((t: any) => t?.function?.name).filter((n: unknown) => typeof n === "string") : [];
				const request: FakeRequest = { role: roleOf(tools), tools, body };
				requests.push(request);
				const source = queues.get(request.role)?.shift();
				if (!source) {
					unscripted.push(request);
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: { message: `fake provider: no scripted step for role "${request.role}"`, type: "fake_unscripted" } }));
					return;
				}
				const step = typeof source === "function" ? source(request) : source;
				streamStep(res, request, step, typeof body.model === "string" ? body.model : models[0]!).catch(() => res.destroy());
			});
			return;
		}
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message: `fake provider: no route ${req.method} ${url.pathname}` } }));
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;

	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		unscripted,
		enqueue(role, ...steps) {
			const queue = queues.get(role) ?? [];
			queue.push(...steps);
			queues.set(role, queue);
		},
		remaining() {
			const out: Partial<Record<FakeRole, number>> = {};
			for (const [role, queue] of queues) if (queue.length) out[role] = queue.length;
			return out;
		},
		close() {
			for (const socket of sockets) socket.destroy();
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}
