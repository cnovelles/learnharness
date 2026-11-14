import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
const { createPhoneAccessStore, createPhoneGateway, phoneRouteAllowed, reachableAddresses, hashToken, PAIRING_TTL_MS } = require("../electron/phone-access.cjs");

const SECRET = "s".repeat(64);

function tempFile() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-phone-"));
	return path.join(dir, "phone-access.json");
}

// ─── Unit: route allowlist ───────────────────────────────────────────────

test("allowlist passes the phone's chat, stream, event and read routes", () => {
	for (const [method, p] of [
		["POST", "/api/chat"],
		["GET", "/api/chats"],
		["POST", "/api/chats"],
		["GET", "/api/chats/chat_abc"],
		["PUT", "/api/chats/chat_abc"],
		["GET", "/api/chats/chat_abc/stream"],
		["POST", "/api/chats/chat_abc/dismiss"],
		["POST", "/api/chats/chat_abc/steer"],
		["GET", "/api/chats/chat_abc/settings"],
		["GET", "/api/events"],
		["GET", "/api/models"],
		["GET", "/api/settings"],
		["GET", "/api/graph"],
		["GET", "/api/graph/status"],
		["GET", "/api/stt/token"],
	]) assert.equal(phoneRouteAllowed(method, p), true, `${method} ${p}`);
});

test("allowlist refuses credentials, providers, prompts, settings writes, deletes and traversal", () => {
	for (const [method, p] of [
		["GET", "/api/keys"],
		["PUT", "/api/keys/ANTHROPIC_API_KEY"],
		["GET", "/api/subscriptions"],
		["POST", "/api/subscriptions/browser"],
		["POST", "/api/custom-provider"],
		["GET", "/api/claude-code"],
		["PUT", "/api/settings"],
		["PATCH", "/api/settings/agent"],
		["GET", "/api/settings/prompts"],
		["DELETE", "/api/chats/chat_abc"],
		["PATCH", "/api/chats/chat_abc"],
		["POST", "/api/stt/token"],
		["POST", "/api/graph/import"],
		["DELETE", "/api/graph/nodes/n1"],
		["PUT", "/api/graph/positions"],
		["GET", "/api/chats/../keys"],
		["GET", "/api/chats//stream"],
		["GET", "/"],
		["GET", "/chat/new"],
	]) assert.equal(phoneRouteAllowed(method, p), false, `${method} ${p}`);
});

// ─── Unit: store ─────────────────────────────────────────────────────────

test("store starts empty, writes owner-only and keeps token hashes only", () => {
	const file = tempFile();
	const store = createPhoneAccessStore(file);
	assert.deepEqual(store.read(), { version: 1, enabled: false, port: 47821, devices: [] });
	store.update((s: any) => ({ ...s, enabled: true, devices: [{ id: "dev_1", name: "Phone", tokenHash: hashToken("tok"), createdAt: "x", lastSeenAt: "x" }] }));
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.equal(store.read().enabled, true);
	assert.equal(fs.readFileSync(file, "utf8").includes("\"tok\""), false);
	assert.deepEqual(fs.readdirSync(path.dirname(file)), ["phone-access.json"], "no temp files remain");
});

test("store refuses a newer format and drops malformed devices", () => {
	const file = tempFile();
	fs.writeFileSync(file, JSON.stringify({ version: 2 }));
	assert.throws(() => createPhoneAccessStore(file).read(), /newer/);
	fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: true, devices: [null, { id: 3 }, { id: "ok", tokenHash: "aa" }] }));
	assert.deepEqual(createPhoneAccessStore(file).read().devices.map((d: any) => d.id), ["ok"]);
});

test("addresses list Tailscale first and skip loopback and IPv6", () => {
	const result = reachableAddresses({
		lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
		en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }],
		utun4: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
	});
	assert.deepEqual(result.map((a: any) => [a.address, a.kind]), [["100.101.102.103", "tailscale"], ["192.168.1.20", "lan"]]);
});

// ─── Integration: gateway over real HTTP ─────────────────────────────────

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

async function harness(options: { now?: () => number; upstream?: http.RequestListener } = {}) {
	const seen: Seen[] = [];
	const upstream = http.createServer(options.upstream ?? ((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
			res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "a=b" });
			res.end(JSON.stringify({ ok: true }));
		});
	}));
	await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
	const upstreamURL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
	const store = createPhoneAccessStore(tempFile());
	const gateway = createPhoneGateway({ store, target: () => ({ url: upstreamURL, secret: SECRET }), info: { name: "test-mac", version: "0.0.0" }, now: options.now });
	const addr = await gateway.start({ host: "127.0.0.1", port: 0 });
	const base = `http://127.0.0.1:${addr.port}`;
	const close = async () => {
		await gateway.stop();
		await new Promise<void>((r) => upstream.close(() => r()));
	};
	const pair = async (code: string) => fetch(`${base}/phone/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "iPhone" }) });
	return { seen, store, gateway, base, close, pair, upstream };
}

test("pairing: one use, no code without a session, wrong code refused", async () => {
	const h = await harness();
	try {
		assert.equal((await h.pair("anything")).status, 401, "no pairing session");
		const { code } = h.gateway.startPairing();
		assert.equal((await h.pair("wrong-code")).status, 401);
		const ok = await h.pair(code);
		assert.equal(ok.status, 200);
		const body = await ok.json();
		assert.match(body.token, /^[A-Za-z0-9_-]{40,}$/);
		assert.equal(body.server.name, "test-mac");
		assert.equal((await h.pair(code)).status, 401, "second use refused");
		const devices = h.store.read().devices;
		assert.equal(devices.length, 1);
		assert.equal(devices[0].name, "iPhone");
		assert.equal(devices[0].tokenHash, hashToken(body.token));
	} finally {
		await h.close();
	}
});

test("pairing: an expired code is refused", async () => {
	let t = 1_000_000;
	const h = await harness({ now: () => t });
	try {
		const { code } = h.gateway.startPairing();
		t += PAIRING_TTL_MS + 1;
		assert.equal((await h.pair(code)).status, 401);
	} finally {
		await h.close();
	}
});

test("pairing: too many failed attempts are rate-limited", async () => {
	const h = await harness();
	try {
		const { code } = h.gateway.startPairing();
		for (let i = 0; i < 10; i++) assert.equal((await h.pair(`bad-${i}`)).status, 401);
		assert.equal((await h.pair(code)).status, 429, "valid code also waits during the limit");
	} finally {
		await h.close();
	}
});

test("requests without a valid token are refused and never reach the server", async () => {
	const h = await harness();
	try {
		for (const auth of [undefined, "Bearer short", "Bearer " + "x".repeat(43), "Basic abc"]) {
			const res = await fetch(`${h.base}/api/chats`, { headers: auth ? { authorization: auth } : {} });
			assert.equal(res.status, 401, String(auth));
		}
		assert.equal(h.seen.length, 0);
	} finally {
		await h.close();
	}
});

async function pairedToken(h: Awaited<ReturnType<typeof harness>>) {
	const { code } = h.gateway.startPairing();
	return (await (await h.pair(code)).json()).token as string;
}

test("allowed requests reach the server with the desktop secret and without phone headers", async () => {
	const h = await harness();
	try {
		const token = await pairedToken(h);
		const res = await fetch(`${h.base}/api/chat?x=1`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json", cookie: "evil=1", origin: "https://evil.invalid", "x-learnharness-desktop": "forged" },
			body: JSON.stringify({ chatId: "chat_1", input: { type: "text", text: "hi" } }),
		});
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("set-cookie"), null, "cookies do not pass back");
		assert.equal(h.seen.length, 1);
		const req = h.seen[0]!;
		assert.equal(req.method, "POST");
		assert.equal(req.url, "/api/chat?x=1");
		assert.equal(req.headers["x-learnharness-desktop"], SECRET);
		assert.equal(req.headers.authorization, undefined);
		assert.equal(req.headers.cookie, undefined);
		assert.equal(req.headers.origin, undefined);
		assert.deepEqual(JSON.parse(req.body), { chatId: "chat_1", input: { type: "text", text: "hi" } });
	} finally {
		await h.close();
	}
});

test("refused routes return 403 and never reach the server", async () => {
	const h = await harness();
	try {
		const token = await pairedToken(h);
		const res = await fetch(`${h.base}/api/keys`, { headers: { authorization: `Bearer ${token}` } });
		assert.equal(res.status, 403);
		assert.equal(h.seen.length, 0);
	} finally {
		await h.close();
	}
});

test("ping answers a paired phone; a revoked phone is refused", async () => {
	const h = await harness();
	try {
		const token = await pairedToken(h);
		const ping = await fetch(`${h.base}/phone/v1/ping`, { headers: { authorization: `Bearer ${token}` } });
		assert.equal(ping.status, 200);
		const { deviceId } = await ping.json();
		h.gateway.revoke(deviceId);
		assert.equal((await fetch(`${h.base}/phone/v1/ping`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
	} finally {
		await h.close();
	}
});

test("server-sent events stream through chunk by chunk", async () => {
	let release: () => void = () => {};
	const h = await harness({
		upstream: (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write("data: first\n\n");
			release = () => res.end("data: last\n\n");
		},
	});
	try {
		const token = await pairedToken(h);
		const res = await fetch(`${h.base}/api/chats/chat_1/stream`, { headers: { authorization: `Bearer ${token}` } });
		const reader = res.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		assert.equal(first, "data: first\n\n", "first event arrives before the upstream ends");
		release();
		let rest = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			rest += new TextDecoder().decode(value);
		}
		assert.equal(rest, "data: last\n\n");
	} finally {
		await h.close();
	}
});

test("a phone that disconnects closes the upstream request", async () => {
	let upstreamClosed: () => void = () => {};
	const closed = new Promise<void>((r) => (upstreamClosed = r));
	const h = await harness({
		upstream: (req, res) => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write("data: open\n\n");
			req.on("close", () => upstreamClosed());
		},
	});
	try {
		const token = await pairedToken(h);
		const controller = new AbortController();
		const res = await fetch(`${h.base}/api/events`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
		await res.body!.getReader().read();
		controller.abort();
		await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("upstream not closed")), 2000))]);
	} finally {
		await h.close();
	}
});

test("an unreachable server gives 502", async () => {
	const h = await harness();
	try {
		const token = await pairedToken(h);
		await new Promise<void>((r) => h.upstream.close(() => r()));
		const res = await fetch(`${h.base}/api/chats`, { headers: { authorization: `Bearer ${token}` } });
		assert.equal(res.status, 502);
	} finally {
		await h.gateway.stop();
	}
});
