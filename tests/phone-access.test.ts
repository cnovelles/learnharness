import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { PinMismatchError, pinnedFetch } from "./helpers/pinned-fetch.ts";

const require = createRequire(import.meta.url);
const { createPhoneAccessStore, createPhoneGateway, phoneRouteAllowed, phoneWriteFor, checkFolderAction, reachableAddresses, hashToken, PAIRING_TTL_MS, PROTOCOL, MAX_FOLDERS, MAX_FOLDER_TEXT } = require("../electron/phone-access.cjs");
const { createCertificate, loadOrCreateCertificate, spkiPin, checkPair } = require("../electron/phone-access-tls.cjs");


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
		["PUT", "/api/chats/chat_abc/settings"],
		["POST", "/api/chats/chat_abc/artifact-ui"],
		["GET", `/api/chats/chat_abc/images/${"ab12".repeat(16)}`],
		["GET", "/api/events"],
		["GET", "/api/models"],
		["GET", "/api/settings"],
		["GET", "/api/graph"],
		["GET", "/api/graph/status"],
		["GET", "/api/stt/token"],
		["GET", "/api/graph/sources"],
		["POST", "/api/graph/sources"],
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
		["GET", "/api/chats/chat_abc/settings"],
		["GET", "/api/chats/chat_abc/artifact-ui"],
		// Issue 19: only GET of a 64-hex snapshot id (the route's own check).
		["POST", `/api/chats/chat_abc/images/${"ab12".repeat(16)}`],
		["DELETE", `/api/chats/chat_abc/images/${"ab12".repeat(16)}`],
		["GET", "/api/chats/chat_abc/images"],
		["GET", "/api/chats/chat_abc/images/"],
		["GET", "/api/chats/chat_abc/images/not-a-snapshot"],
		["GET", `/api/chats/chat_abc/images/${"AB12".repeat(16)}`],
		["GET", `/api/chats/chat_abc/images/${"ab12".repeat(16)}/x`],
		["GET", `/api/chats/chat_abc/images/../../keys`],
		["POST", "/api/graph/import"],
		["DELETE", "/api/graph/nodes/n1"],
		["PUT", "/api/graph/positions"],
		["DELETE", "/api/graph/sources"],
		["PUT", "/api/graph/sources"],
		["POST", "/api/graph/sources/../import"],
		["GET", "/api/chats/../keys"],
		["GET", "/api/chats//stream"],
		["GET", "/"],
		["GET", "/chat/new"],
	]) assert.equal(phoneRouteAllowed(method, p), false, `${method} ${p}`);
});

// ─── Unit: phone writes (D-015) ──────────────────────────────────────────

test("phone writes: only POST /api/graph/sources has a checked body", () => {
	assert.ok(phoneWriteFor("POST", "/api/graph/sources"));
	assert.equal(phoneWriteFor("DELETE", "/api/graph/sources"), null);
	assert.equal(phoneWriteFor("POST", "/api/chat"), null);
	assert.equal(phoneWriteFor("POST", "/api/graph//sources"), null);
});

test("folder check: the 5 actions with their exact keys pass", () => {
	for (const body of [
		{ action: "create-folder", name: "Databases", parentId: null },
		{ action: "create-folder", name: "Postgres", parentId: "folder_1" },
		{ action: "rename-folder", id: "folder_1", name: "Data" },
		{ action: "rename-source", id: "chat_1", name: "SQL joins" },
		{ action: "move", kind: "source", id: "chat_1", parentId: "folder_1" },
		{ action: "move", kind: "folder", id: "folder_2", parentId: null },
		{ action: "delete-folder", id: "folder_1" },
		{ action: "rename-folder", id: "folder_1", name: "x".repeat(MAX_FOLDER_TEXT) },
		{ action: "rename-folder", id: "folder_1", name: "  Data  " },
	]) assert.equal(checkFolderAction(body), null, JSON.stringify(body));
});

test("folder check: wrong shapes, extra keys, long or multi-line names are refused", () => {
	for (const body of [
		null,
		[],
		"create-folder",
		{},
		{ action: "delete-sources", id: "chat_1" },
		{ action: "__proto__", id: "x" },
		{ action: "create-folder", name: "A" },
		{ action: "create-folder", name: "A", parentId: null, extra: 1 },
		{ action: "create-folder", name: "", parentId: null },
		{ action: "create-folder", name: "   ", parentId: null },
		{ action: "create-folder", name: 5, parentId: null },
		{ action: "create-folder", name: "A", parentId: 3 },
		{ action: "create-folder", name: "A", parentId: "" },
		{ action: "create-folder", name: "x".repeat(MAX_FOLDER_TEXT + 1), parentId: null },
		{ action: "create-folder", name: "two\nlines", parentId: null },
		{ action: "create-folder", name: "tab\there", parentId: null },
		{ action: "create-folder", name: "sep\u2028here", parentId: null },
		{ action: "rename-folder", id: "", name: "A" },
		{ action: "rename-folder", id: "f".repeat(MAX_FOLDER_TEXT + 1), name: "A" },
		{ action: "rename-folder", id: "bad\u0000id", name: "A" },
		{ action: "move", kind: "chat", id: "chat_1", parentId: null },
		{ action: "move", id: "chat_1", parentId: null },
		{ action: "delete-folder", id: "folder_1", parentId: null },
	]) assert.notEqual(checkFolderAction(body), null, JSON.stringify(body));
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

async function harness(options: { now?: () => number; upstream?: http.RequestListener; onPairingCancelled?: (reason: string) => void; networkInterfaces?: () => Record<string, any[]>; writeBodyTimeoutMs?: number } = {}) {
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
	const storeFile = tempFile();
	const store = createPhoneAccessStore(storeFile);
	const paired: Array<{ id: string; name: string }> = [];
	const tlsDir = path.join(path.dirname(storeFile), "tls");
	const logs: string[] = [];
	const gateway = createPhoneGateway({ store, tlsDir, log: (line: string) => logs.push(line), target: () => ({ url: upstreamURL, secret: SECRET }), info: { name: "test-mac", version: "0.0.0" }, now: options.now, onPaired: (d: { id: string; name: string }) => paired.push(d), onPairingCancelled: options.onPairingCancelled, networkInterfaces: options.networkInterfaces, writeBodyTimeoutMs: options.writeBodyTimeoutMs });
	const addr = await gateway.start({ host: "127.0.0.1", port: 0 });
	const base = `https://127.0.0.1:${addr.port}`;
	const fetch = pinnedFetch(gateway.pin());
	const close = async () => {
		await fetch.close();
		await gateway.stop();
		await new Promise<void>((r) => upstream.close(() => r()));
	};
	const pair = async (code: string) => fetch(`${base}/phone/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "iPhone" }) });
	return { seen, store, tlsDir, gateway, base, close, pair, upstream, paired, fetch, logs };
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
		assert.deepEqual(h.paired, [{ id: body.deviceId, name: "iPhone" }], "onPaired fires once, for the successful pair only");
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

test("pairing: 10 wrong codes cancel the active code; a new code works at once", async () => {
	const cancelled: string[] = [];
	const h = await harness({ onPairingCancelled: (reason: string) => cancelled.push(reason) });
	try {
		const first = h.gateway.startPairing();
		for (let i = 0; i < 9; i++) assert.equal((await h.pair(`bad-${i}`)).status, 401);
		assert.deepEqual(cancelled, [], "9 wrong codes do not cancel");
		assert.equal((await h.pair("bad-9")).status, 401);
		assert.deepEqual(cancelled, ["too-many-attempts"]);
		assert.equal((await h.pair(first.code)).status, 401, "the cancelled code no longer pairs");
		// No global lockout: a new code starts at zero and pairs at once.
		const second = h.gateway.startPairing();
		assert.equal((await h.pair(second.code)).status, 200);
	} finally {
		await h.close();
	}
});

test("pairing: wrong codes count against the active code only", async () => {
	const h = await harness();
	try {
		for (let i = 0; i < 20; i++) assert.equal((await h.pair(`bad-${i}`)).status, 401, "no code: refused, no lockout");
		const { code } = h.gateway.startPairing();
		for (let i = 0; i < 5; i++) await h.pair(`bad-${i}`);
		const again = h.gateway.startPairing(); // a new code resets the count
		for (let i = 0; i < 9; i++) await h.pair(`bad-${i}`);
		assert.equal((await h.pair(again.code)).status, 200);
		assert.equal((await h.pair(code)).status, 401, "the replaced code is gone");
	} finally {
		await h.close();
	}
});

test("requests without a valid token are refused and never reach the server", async () => {
	const h = await harness();
	try {
		for (const auth of [undefined, "Bearer short", "Bearer " + "x".repeat(43), "Basic abc"]) {
			const res = await h.fetch(`${h.base}/api/chats`, { headers: auth ? { authorization: auth } : {} });
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
		const res = await h.fetch(`${h.base}/api/chat?x=1`, {
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
		const res = await h.fetch(`${h.base}/api/keys`, { headers: { authorization: `Bearer ${token}` } });
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
		const ping = await h.fetch(`${h.base}/phone/v1/ping`, { headers: { authorization: `Bearer ${token}` } });
		assert.equal(ping.status, 200);
		const { deviceId } = await ping.json();
		h.gateway.revoke(deviceId);
		assert.equal((await h.fetch(`${h.base}/phone/v1/ping`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
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
		const res = await h.fetch(`${h.base}/api/chats/chat_1/stream`, { headers: { authorization: `Bearer ${token}` } });
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
		const res = await h.fetch(`${h.base}/api/events`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
		await res.body!.getReader().read();
		controller.abort();
		await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("upstream not closed")), 2000))]);
		await new Promise((r) => setTimeout(r, 100));
		// A normal disconnect (the app goes to the background) is not an error.
		assert.deepEqual(h.logs.filter((l) => l.includes("upstream error")), []);
	} finally {
		await h.close();
	}
});

test("a phone that disconnects before the server answers is not an upstream error", async () => {
	let upstreamClosed: () => void = () => {};
	const closed = new Promise<void>((r) => (upstreamClosed = r));
	let arrived: () => void = () => {};
	const reached = new Promise<void>((r) => (arrived = r));
	const h = await harness({
		upstream: (req) => {
			// No answer yet, like a turn that waits for the model.
			req.on("close", () => upstreamClosed());
			arrived();
		},
	});
	try {
		const token = await pairedToken(h);
		const controller = new AbortController();
		const res = h.fetch(`${h.base}/api/chats`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal }).catch(() => null);
		await reached;
		controller.abort();
		await res;
		await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("upstream not closed")), 2000))]);
		await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(h.logs.filter((l) => l.includes("upstream error")), []);
	} finally {
		await h.close();
	}
});

test("revoke closes the device's open streams on both sides; other devices keep theirs", async () => {
	const upstreamClosed: string[] = [];
	const h = await harness({
		upstream: (req, res) => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write("data: open\n\n");
			req.on("close", () => upstreamClosed.push(req.url!));
		},
	});
	try {
		const tokenA = await pairedToken(h);
		const tokenB = await pairedToken(h);
		const idA = (await (await h.fetch(`${h.base}/phone/v1/ping`, { headers: { authorization: `Bearer ${tokenA}` } })).json()).deviceId;
		const open = async (token: string, p: string) => {
			const res = await h.fetch(`${h.base}${p}`, { headers: { authorization: `Bearer ${token}` } });
			const reader = res.body!.getReader();
			await reader.read(); // the first event arrived: the stream is open
			return reader;
		};
		const events = await open(tokenA, "/api/events");
		const turn = await open(tokenA, "/api/chats/chat_1/stream");
		const other = await open(tokenB, "/api/events?b=1");

		h.gateway.revoke(idA);

		const ended = (reader: ReadableStreamDefaultReader<Uint8Array>) =>
			Promise.race([
				reader.read().then((r) => r.done, () => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
			]);
		assert.equal(await ended(events), true, "the event stream closed on the phone side");
		assert.equal(await ended(turn), true, "the turn stream closed on the phone side");
		await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(upstreamClosed.sort(), ["/api/chats/chat_1/stream", "/api/events"], "both upstream requests closed");
		// The other device's stream stays open.
		const stillOpen = await Promise.race([other.read().then(() => "data"), new Promise((r) => setTimeout(() => r("open"), 200))]);
		assert.equal(stillOpen, "open");
		assert.deepEqual(h.logs.filter((l) => l.includes("upstream error")), [], "a revoke is not an upstream error");
		await other.cancel();
	} finally {
		await h.close();
	}
});

test("an unreachable server gives 502", async () => {
	const h = await harness();
	try {
		const token = await pairedToken(h);
		await new Promise<void>((r) => h.upstream.close(() => r()));
		const res = await h.fetch(`${h.base}/api/chats`, { headers: { authorization: `Bearer ${token}` } });
		assert.equal(res.status, 502);
		assert.match(h.logs.join("\n"), /upstream error .*ECONNREFUSED/, "a real failure is still logged");
	} finally {
		await h.gateway.stop();
	}
});

// ─── TLS: certificate, pin, HTTPS only ───────────────────────────────────

test("the certificate is a valid self-signed P-256 certificate, and the pin is the SPKI SHA-256", () => {
	const { key, cert } = createCertificate();
	const x509 = new crypto.X509Certificate(cert);
	assert.equal(x509.subject, "CN=LearnHarness Phone Access");
	assert.equal(x509.issuer, x509.subject);
	assert.equal(x509.ca, false);
	assert.ok(x509.verify(x509.publicKey), "self-signed signature is valid");
	assert.ok(new Date(x509.validTo).getTime() > Date.now() + 10 * 365 * 24 * 3600 * 1000);
	const spki = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
	assert.equal(spkiPin(cert), `sha256/${crypto.createHash("sha256").update(spki).digest("base64")}`);
	assert.throws(() => checkPair(createCertificate().key, cert), /does not match/);
});

test("the key file is private, a restart keeps the pin, a damaged pair makes a new one", () => {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lh-phone-tls-")), "tls");
	const first = loadOrCreateCertificate(dir);
	assert.equal(first.created, true);
	assert.equal(fs.statSync(path.join(dir, "key.pem")).mode & 0o777, 0o600);
	const again = loadOrCreateCertificate(dir);
	assert.equal(again.created, false);
	assert.equal(again.pin, first.pin);
	fs.writeFileSync(path.join(dir, "cert.pem"), "damaged");
	const logs: string[] = [];
	const rotated = loadOrCreateCertificate(dir, { log: (l: string) => logs.push(l) });
	assert.equal(rotated.created, true);
	assert.notEqual(rotated.pin, first.pin);
	assert.match(logs.join("\n"), /not usable/);
});

test("the gateway serves HTTPS only; the pairing payload has the pin and https addresses", async () => {
	const h = await harness();
	try {
		assert.equal(PROTOCOL, 2);
		const port = new URL(h.base).port;
		await assert.rejects(fetch(`http://127.0.0.1:${port}/phone/v1/ping`), "no plain HTTP answer");
		const { code } = h.gateway.startPairing();
		const payload = JSON.parse(h.gateway.pairingPayload(code));
		assert.equal(payload.lh, 2);
		assert.equal(payload.pin, h.gateway.pin());
		assert.match(payload.pin, /^sha256\/[A-Za-z0-9+/]{43}=$/);
		for (const url of payload.urls) assert.match(url, /^https:\/\//);
		assert.equal(spkiPin(fs.readFileSync(path.join(h.tlsDir, "cert.pem"))), payload.pin);
	} finally {
		await h.close();
	}
});

test("a client with a wrong pin sends nothing: the code and the server stay untouched", async () => {
	const h = await harness();
	const wrong = pinnedFetch(spkiPin(createCertificate().cert));
	try {
		const { code } = h.gateway.startPairing();
		await assert.rejects(
			wrong(`${h.base}/phone/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }),
			(err: any) => err.cause instanceof PinMismatchError,
		);
		assert.deepEqual(wrong.checks.map((c) => c.ok), [false]);
		// The gateway saw no request: the code still works, and it counts no failure.
		assert.equal((await h.pair(code)).status, 200);
		assert.equal(h.seen.length, 0);
	} finally {
		await wrong.close();
		await h.close();
	}
});

test("a new certificate removes the paired phones; they must pair again", async () => {
	const h = await harness();
	try {
		const token = await pairedToken(h);
		const oldPin = h.gateway.pin();
		await h.gateway.stop();
		// A restart with the same files keeps the phone.
		await h.gateway.start({ host: "127.0.0.1", port: 0 });
		assert.equal(h.gateway.pin(), oldPin);
		assert.equal(h.store.read().devices.length, 1);
		await h.gateway.stop();
		// Lost key: a new certificate, a new pin, no paired phones.
		fs.rmSync(path.join(h.tlsDir, "key.pem"));
		const addr = await h.gateway.start({ host: "127.0.0.1", port: 0 });
		assert.notEqual(h.gateway.pin(), oldPin);
		assert.deepEqual(h.store.read().devices, []);
		const oldPhone = pinnedFetch(oldPin);
		await assert.rejects(oldPhone(`https://127.0.0.1:${addr.port}/phone/v1/ping`, { headers: { authorization: `Bearer ${token}` } }), (err: any) => err.cause instanceof PinMismatchError);
		await oldPhone.close();
		const newPhone = pinnedFetch(h.gateway.pin());
		assert.equal((await newPhone(`https://127.0.0.1:${addr.port}/phone/v1/ping`, { headers: { authorization: `Bearer ${token}` } })).status, 401, "the old token is gone");
		await newPhone.close();
	} finally {
		await h.close();
	}
});

const LAN_ONLY = () => ({ en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }] });
const WITH_TAILSCALE = () => ({ ...LAN_ONLY(), utun4: [{ address: "100.101.102.103", family: "IPv4", internal: false }] });

test("a device record notes whether its pairing payload had a Tailscale address", async () => {
	let interfaces: () => Record<string, any[]> = LAN_ONLY;
	const h = await harness({ networkInterfaces: () => interfaces() });
	try {
		const first = h.gateway.startPairing();
		const lanPayload = JSON.parse(h.gateway.pairingPayload(first.code));
		assert.deepEqual(lanPayload.urls.map((u: string) => new URL(u).hostname), ["192.168.1.20"]);
		assert.equal((await h.pair(first.code)).status, 200);

		interfaces = WITH_TAILSCALE;
		const second = h.gateway.startPairing();
		const payload = JSON.parse(h.gateway.pairingPayload(second.code));
		assert.equal(new URL(payload.urls[0]).hostname, "100.101.102.103", "Tailscale first");
		assert.equal((await h.pair(second.code)).status, 200);

		const third = h.gateway.startPairing();
		assert.equal((await h.pair(third.code)).status, 200, "a code with no payload still pairs");

		assert.deepEqual(h.store.read().devices.map((d: any) => d.tailscale), [false, true, undefined]);
	} finally {
		await h.close();
	}
});

test("the gateway lists the addresses of the network interfaces it is given", async () => {
	const h = await harness({ networkInterfaces: WITH_TAILSCALE });
	try {
		assert.deepEqual(h.gateway.addresses().map((a: any) => a.kind), ["tailscale", "lan"]);
	} finally {
		await h.close();
	}
});

// ─── Integration: phone writes (D-015) ───────────────────────────────────

function folderUpstream(folderCount: number, seen: Seen[]): http.RequestListener {
	return (req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
			res.writeHead(200, { "Content-Type": "application/json" });
			if (req.method === "GET") {
				const folders = Array.from({ length: folderCount }, (_, i) => ({ id: `folder_${i}`, name: `F${i}`, parentId: null, createdAt: "2026-11-18T00:00:00.000Z" }));
				res.end(JSON.stringify({ organization: { version: 1, folders, placements: {} }, sources: [] }));
			} else res.end(JSON.stringify({ ok: true }));
		});
	};
}

async function folderWrite(h: Awaited<ReturnType<typeof harness>>, token: string, body: string, headers: Record<string, string> = {}) {
	return h.fetch(`${h.base}/api/graph/sources`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body });
}

test("phone writes: each folder action reaches the server as checked JSON with the desktop secret", async () => {
	const seen: Seen[] = [];
	const h = await harness({ upstream: folderUpstream(3, seen) });
	try {
		const token = await pairedToken(h);
		const actions = [
			{ action: "create-folder", name: "Databases", parentId: null },
			{ action: "rename-folder", id: "folder_1", name: "Data" },
			{ action: "rename-source", id: "chat_1", name: "SQL joins" },
			{ action: "move", kind: "source", id: "chat_1", parentId: "folder_1" },
			{ action: "delete-folder", id: "folder_1" },
		];
		for (const action of actions) {
			const res = await folderWrite(h, token, JSON.stringify(action));
			assert.equal(res.status, 200, action.action);
			await res.text();
		}
		const posts = seen.filter((r) => r.method === "POST");
		assert.equal(posts.length, 5);
		assert.deepEqual(posts.map((r) => JSON.parse(r.body)), actions);
		for (const r of posts) {
			assert.equal(r.url, "/api/graph/sources");
			assert.equal(r.headers["x-learnharness-desktop"], SECRET);
			assert.equal(r.headers["content-type"], "application/json");
			assert.equal(Number(r.headers["content-length"]), Buffer.byteLength(r.body));
			assert.equal(r.headers.authorization, undefined);
		}
		// Only the new folder reads the folder list first.
		const gets = seen.filter((r) => r.method === "GET");
		assert.equal(gets.length, 1);
		assert.equal(gets[0]!.url, "/api/graph/sources");
		assert.equal(gets[0]!.headers["x-learnharness-desktop"], SECRET);
	} finally {
		await h.close();
	}
});

test("phone writes: bad bodies are refused and never reach the server", async () => {
	const seen: Seen[] = [];
	const h = await harness({ upstream: folderUpstream(0, seen) });
	try {
		const token = await pairedToken(h);
		const cases: Array<[string, Record<string, string>, number]> = [
			[JSON.stringify({ action: "delete-sources", ids: ["chat_1"] }), {}, 400],
			[JSON.stringify({ action: "create-folder", name: "A", parentId: null, extra: true }), {}, 400],
			[JSON.stringify({ action: "rename-folder", id: "folder_1", name: "x".repeat(MAX_FOLDER_TEXT + 1) }), {}, 400],
			[JSON.stringify({ action: "rename-folder", id: "folder_1", name: "a\nb" }), {}, 400],
			["{not json", {}, 400],
			[JSON.stringify({ action: "create-folder", name: "A", parentId: null }), { "content-type": "text/plain" }, 415],
			[JSON.stringify({ action: "rename-folder", id: "folder_1", name: "A", pad: "x".repeat(5000) }), {}, 413],
		];
		for (const [body, headers, status] of cases) {
			const res = await folderWrite(h, token, body, headers);
			assert.equal(res.status, status, body.slice(0, 60));
			const answer = await res.json();
			assert.equal(typeof answer.error, "string");
		}
		const del = await h.fetch(`${h.base}/api/graph/sources`, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ids: ["chat_1"] }) });
		assert.equal(del.status, 403);
		await del.text();
		assert.equal(seen.length, 0);
	} finally {
		await h.close();
	}
});

test("phone writes: a body over the limit with a wrong content-length is refused", async () => {
	const seen: Seen[] = [];
	const h = await harness({ upstream: folderUpstream(0, seen) });
	try {
		const token = await pairedToken(h);
		const big = JSON.stringify({ action: "rename-folder", id: "folder_1", name: "x".repeat(6000) });
		const res = await new Promise<number>((resolve, reject) => {
			const req = require("node:https").request(`${h.base}/api/graph/sources`, {
				method: "POST",
				rejectUnauthorized: false,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "transfer-encoding": "chunked" },
			}, (r: http.IncomingMessage) => { r.resume(); resolve(r.statusCode!); });
			req.on("error", reject);
			req.write(big.slice(0, 3000));
			req.end(big.slice(3000));
		});
		assert.equal(res, 413);
		assert.equal(seen.length, 0);
	} finally {
		await h.close();
	}
});

test(`phone writes: a new folder is refused at ${MAX_FOLDERS} folders; other actions still pass`, async () => {
	const seen: Seen[] = [];
	const h = await harness({ upstream: folderUpstream(MAX_FOLDERS, seen) });
	try {
		const token = await pairedToken(h);
		const create = await folderWrite(h, token, JSON.stringify({ action: "create-folder", name: "One more", parentId: null }));
		assert.equal(create.status, 409);
		assert.equal((await create.json()).code, "folder-limit");
		assert.equal(seen.filter((r) => r.method === "POST").length, 0);
		const rename = await folderWrite(h, token, JSON.stringify({ action: "rename-folder", id: "folder_1", name: "Data" }));
		assert.equal(rename.status, 200);
		await rename.text();
	} finally {
		await h.close();
	}
});

test("phone writes: a refused folder list read gives 502, and nothing is written", async () => {
	const seen: Seen[] = [];
	const h = await harness({
		upstream: (req, res) => {
			seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: "" });
			req.resume();
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "boom" }));
		},
	});
	try {
		const token = await pairedToken(h);
		const res = await folderWrite(h, token, JSON.stringify({ action: "create-folder", name: "A", parentId: null }));
		assert.equal(res.status, 502);
		await res.text();
		assert.equal(seen.filter((r) => r.method === "POST").length, 0);
	} finally {
		await h.close();
	}
});

test("phone writes: two new folders at the same time cannot both pass the limit", async () => {
	const seen: Seen[] = [];
	let folders = MAX_FOLDERS - 1;
	const h = await harness({
		upstream: (req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
				res.writeHead(200, { "Content-Type": "application/json" });
				if (req.method === "GET") {
					const list = Array.from({ length: folders }, (_, i) => ({ id: `folder_${i}`, name: `F${i}`, parentId: null, createdAt: "x" }));
					// A slow read: without the queue, both writes would see 499.
					setTimeout(() => res.end(JSON.stringify({ organization: { version: 1, folders: list, placements: {} }, sources: [] })), 50);
				} else {
					folders += 1;
					res.end(JSON.stringify({ ok: true }));
				}
			});
		},
	});
	try {
		const token = await pairedToken(h);
		const send = () => folderWrite(h, token, JSON.stringify({ action: "create-folder", name: "New", parentId: null })).then(async (r) => { await r.text(); return r.status; });
		const statuses = (await Promise.all([send(), send()])).sort();
		assert.deepEqual(statuses, [200, 409]);
		assert.equal(seen.filter((r) => r.method === "POST").length, 1);
		assert.equal(folders, MAX_FOLDERS);
	} finally {
		await h.close();
	}
});

test("phone writes: a phone removed while its write waits sends nothing", async () => {
	const seen: Seen[] = [];
	let release: () => void = () => {};
	const listRead = new Promise<void>((r) => { release = r; });
	let gotRead: () => void = () => {};
	const readStarted = new Promise<void>((r) => { gotRead = r; });
	const h = await harness({
		upstream: (req, res) => {
			req.resume();
			req.on("end", async () => {
				seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: "" });
				res.writeHead(200, { "Content-Type": "application/json" });
				if (req.method === "GET") {
					gotRead();
					await listRead;
					res.end(JSON.stringify({ organization: { version: 1, folders: [], placements: {} }, sources: [] }));
				} else res.end(JSON.stringify({ ok: true }));
			});
		},
	});
	try {
		const token = await pairedToken(h);
		const deviceId = h.store.read().devices[0].id;
		const pending = folderWrite(h, token, JSON.stringify({ action: "create-folder", name: "New", parentId: null }));
		await readStarted;
		h.gateway.revoke(deviceId);
		release();
		const res = await pending.catch(() => null);
		if (res) {
			assert.equal(res.status, 401);
			await res.text();
		}
		assert.equal(seen.filter((r) => r.method === "POST").length, 0);
	} finally {
		await h.close();
	}
});

test("phone writes: a folder list with no folders array refuses the new folder", async () => {
	const seen: Seen[] = [];
	const h = await harness({
		upstream: (req, res) => {
			req.resume();
			req.on("end", () => {
				seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: "" });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ organization: {}, sources: [] }));
			});
		},
	});
	try {
		const token = await pairedToken(h);
		const res = await folderWrite(h, token, JSON.stringify({ action: "create-folder", name: "New", parentId: null }));
		assert.equal(res.status, 502);
		await res.text();
		assert.equal(seen.filter((r) => r.method === "POST").length, 0);
	} finally {
		await h.close();
	}
});

test("phone writes: a body that does not end in time closes the request; nothing reaches the server", async () => {
	const seen: Seen[] = [];
	const h = await harness({ upstream: folderUpstream(0, seen), writeBodyTimeoutMs: 200 });
	try {
		const token = await pairedToken(h);
		const outcome = await new Promise<string>((resolve) => {
			const req = require("node:https").request(`${h.base}/api/graph/sources`, {
				method: "POST",
				rejectUnauthorized: false,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": "100" },
			}, (r: http.IncomingMessage) => { r.resume(); resolve(`status ${r.statusCode}`); });
			req.on("error", () => resolve("closed"));
			req.write('{"action":"create-folder"');
			// The rest of the body never comes.
		});
		assert.equal(outcome, "closed");
		assert.equal(seen.length, 0);
	} finally {
		await h.close();
	}
});
