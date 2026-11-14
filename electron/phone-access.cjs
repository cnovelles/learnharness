"use strict";

/**
 * Phone access (mobile fork). A second listener that lets a paired phone use
 * this desktop app's server while the desktop window stays open.
 *
 * What it is:
 *  - An HTTP gateway on a fixed port (all interfaces, so LAN and Tailscale).
 *  - Each request must carry a device token from QR pairing.
 *  - Only an allowlist of chat/graph routes passes. Keys, subscriptions,
 *    providers, prompts and settings writes stay desktop-only.
 *  - Allowed requests stream to the loopback server with the desktop
 *    capability header added here. The server code is unchanged.
 *
 * What it is not: a public-internet host. Use Tailscale outside the home
 * network; plain LAN HTTP is not encrypted.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const STORE_VERSION = 1;
const DEFAULT_PORT = 47821;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 26 * 1024 * 1024;
const FAILED_PAIR_LIMIT = 10;
const FAILED_PAIR_WINDOW_MS = 60 * 1000;
const LAST_SEEN_SAVE_MS = 60 * 1000;
const DESKTOP_HEADER = "x-learnharness-desktop";
const PROTOCOL = 1;

/** Method + path allowlist. Anything not listed is refused with 403. */
const ROUTES = [
	{ methods: ["POST"], pattern: /^\/api\/chat$/ },
	{ methods: ["GET", "POST"], pattern: /^\/api\/chats$/ },
	{ methods: ["GET", "PUT"], pattern: /^\/api\/chats\/[^/]+$/ },
	{ methods: ["GET"], pattern: /^\/api\/chats\/[^/]+\/(stream|markdown)$/ },
	{ methods: ["POST"], pattern: /^\/api\/chats\/[^/]+\/(dismiss|steer|artifact-ui)$/ },
	{ methods: ["PUT"], pattern: /^\/api\/chats\/[^/]+\/settings$/ },
	{ methods: ["GET"], pattern: /^\/api\/events$/ },
	{ methods: ["GET"], pattern: /^\/api\/activity$/ },
	{ methods: ["POST"], pattern: /^\/api\/activity\/abort$/ },
	{ methods: ["GET"], pattern: /^\/api\/jobs$/ },
	{ methods: ["GET"], pattern: /^\/api\/models$/ },
	{ methods: ["GET"], pattern: /^\/api\/settings$/ },
	{ methods: ["GET"], pattern: /^\/api\/graph(\/(status|sources|costs))?$/ },
	{ methods: ["GET"], pattern: /^\/api\/stt\/token$/ },
];

function phoneRouteAllowed(method, pathname) {
	if (typeof pathname !== "string" || pathname.includes("..") || pathname.includes("//")) return false;
	return ROUTES.some((route) => route.pattern.test(pathname) && route.methods.includes(method));
}

const hashToken = (token) => crypto.createHash("sha256").update(token, "utf8").digest("hex");
const randomToken = (bytes) => crypto.randomBytes(bytes).toString("base64url");

function safeEqualHex(a, b) {
	const left = Buffer.from(a, "hex");
	const right = Buffer.from(b, "hex");
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function emptyState() {
	return { version: STORE_VERSION, enabled: false, port: DEFAULT_PORT, devices: [] };
}

/** File store: {version, enabled, port, devices:[{id,name,tokenHash,createdAt,lastSeenAt}]}.
 * Token hashes only, never tokens. Atomic temp-file rename, mode 0600. */
function createPhoneAccessStore(file) {
	function read() {
		let raw;
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch (err) {
			if (err.code === "ENOENT") return emptyState();
			throw err;
		}
		const parsed = JSON.parse(raw);
		if (parsed.version > STORE_VERSION) throw new Error(`phone-access.json version ${parsed.version} is newer than this app`);
		return {
			...emptyState(),
			...parsed,
			devices: Array.isArray(parsed.devices) ? parsed.devices.filter((d) => d && typeof d.id === "string" && typeof d.tokenHash === "string") : [],
		};
	}
	function write(state) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ ...state, version: STORE_VERSION }, null, "\t"), { mode: 0o600 });
		fs.renameSync(tmp, file);
	}
	function update(change) {
		const next = change(read());
		write(next);
		return next;
	}
	return { read, write, update };
}

/** IPv4 addresses a phone can reach. 100.64.0.0/10 is the Tailscale range. */
function reachableAddresses(interfaces = os.networkInterfaces()) {
	const out = [];
	for (const [name, list] of Object.entries(interfaces)) {
		for (const entry of list ?? []) {
			if (entry.internal || (entry.family !== "IPv4" && entry.family !== 4)) continue;
			const [a, b] = entry.address.split(".").map(Number);
			const tailscale = a === 100 && b >= 64 && b <= 127;
			out.push({ address: entry.address, interface: name, kind: tailscale ? "tailscale" : "lan" });
		}
	}
	return out.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "tailscale" ? -1 : 1));
}

function sendJSON(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
	res.end(text);
}

function readJSONBody(req, limit = 64 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(new Error("body too large"), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
			} catch {
				reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
			}
		});
		req.on("error", reject);
	});
}

/** Request headers forwarded to the loopback server. Everything else
 * (cookies, origin, the phone token, forwarded-for) is dropped. */
const FORWARD_HEADERS = ["accept", "content-type", "content-length", "last-event-id", "accept-language"];
/** Response headers that must not pass through a proxy. */
const HOP_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer", "set-cookie"]);

/**
 * @param {object} options
 * @param {ReturnType<typeof createPhoneAccessStore>} options.store
 * @param {() => {url: string, secret?: string}} options.target loopback server URL + desktop secret
 * @param {{name?: string, version?: string}} [options.info]
 * @param {(line: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {(device: {id: string, name: string}) => void} [options.onPaired] called after a phone pairs
 */
function createPhoneGateway({ store, target, info = {}, log = () => {}, now = () => Date.now(), onPaired = () => {} }) {
	let server = null;
	let pairing = null; // {codeHash, expiresAt}
	const failedPairs = [];
	const lastSeenSaved = new Map();
	const sockets = new Set();

	function startPairing() {
		const code = randomToken(18);
		pairing = { codeHash: hashToken(code), expiresAt: now() + PAIRING_TTL_MS };
		return { code, expiresAt: pairing.expiresAt };
	}

	function cancelPairing() {
		pairing = null;
	}

	function pairingPayload(code, port = store.read().port) {
		const urls = reachableAddresses().map((a) => `http://${a.address}:${port}`);
		return JSON.stringify({ lh: PROTOCOL, name: info.name ?? os.hostname(), urls, code });
	}

	function authenticate(req) {
		const header = req.headers.authorization ?? "";
		const match = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(header);
		if (!match) return null;
		const hash = hashToken(match[1]);
		const device = store.read().devices.find((d) => safeEqualHex(d.tokenHash, hash));
		if (!device) return null;
		const last = lastSeenSaved.get(device.id) ?? 0;
		if (now() - last > LAST_SEEN_SAVE_MS) {
			lastSeenSaved.set(device.id, now());
			try {
				store.update((state) => ({ ...state, devices: state.devices.map((d) => (d.id === device.id ? { ...d, lastSeenAt: new Date(now()).toISOString() } : d)) }));
			} catch (err) {
				log(`phone access: lastSeen save failed: ${err.message}`);
			}
		}
		return device;
	}

	async function handlePair(req, res) {
		const t = now();
		while (failedPairs.length && t - failedPairs[0] > FAILED_PAIR_WINDOW_MS) failedPairs.shift();
		if (failedPairs.length >= FAILED_PAIR_LIMIT) return sendJSON(res, 429, { error: "Too many pairing attempts. Wait one minute." });
		let body;
		try {
			body = await readJSONBody(req);
		} catch (err) {
			return sendJSON(res, err.status ?? 400, { error: err.message });
		}
		const code = typeof body.code === "string" ? body.code : "";
		const valid = pairing && t <= pairing.expiresAt && code.length > 0 && safeEqualHex(pairing.codeHash, hashToken(code));
		if (!valid) {
			failedPairs.push(t);
			return sendJSON(res, 401, { error: "The pairing code is not valid or has expired. Show a new QR code on the Mac." });
		}
		pairing = null; // one use
		const token = randomToken(32);
		const device = {
			id: `dev_${randomToken(9)}`,
			name: typeof body.deviceName === "string" && body.deviceName.trim() ? body.deviceName.trim().slice(0, 80) : "Phone",
			tokenHash: hashToken(token),
			createdAt: new Date(t).toISOString(),
			lastSeenAt: new Date(t).toISOString(),
		};
		store.update((state) => ({ ...state, devices: [...state.devices, device] }));
		log(`phone access: paired ${device.id} (${device.name})`);
		try {
			onPaired({ id: device.id, name: device.name });
		} catch (err) {
			log(`phone access: onPaired failed: ${err.message}`);
		}
		sendJSON(res, 200, { token, deviceId: device.id, protocol: PROTOCOL, server: { name: info.name ?? os.hostname(), version: info.version ?? null } });
	}

	function proxy(req, res, url) {
		const { url: base, secret } = target();
		const upstreamURL = new URL(url.pathname + url.search, base);
		const headers = {};
		for (const name of FORWARD_HEADERS) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
		const declared = Number(req.headers["content-length"] ?? 0);
		if (declared > MAX_BODY_BYTES) return sendJSON(res, 413, { error: "Request body too large." });
		if (secret) headers[DESKTOP_HEADER] = secret;
		headers.host = upstreamURL.host;
		const upstream = http.request(upstreamURL, { method: req.method, headers }, (upRes) => {
			const out = {};
			for (const [name, value] of Object.entries(upRes.headers)) if (!HOP_HEADERS.has(name.toLowerCase())) out[name] = value;
			res.writeHead(upRes.statusCode ?? 502, out);
			// SSE: send each chunk at once.
			res.flushHeaders?.();
			upRes.pipe(res);
		});
		upstream.on("error", (err) => {
			log(`phone access: upstream error ${err.message}`);
			if (!res.headersSent) sendJSON(res, 502, { error: "The LearnHarness server is not reachable." });
			else res.destroy();
		});
		// A phone that disconnects detaches its view, like a closed browser tab.
		res.on("close", () => {
			if (!res.writableFinished) upstream.destroy();
		});
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				upstream.destroy();
				if (!res.headersSent) sendJSON(res, 413, { error: "Request body too large." });
				req.destroy();
			}
		});
		req.pipe(upstream);
	}

	async function handle(req, res) {
		let url;
		try {
			url = new URL(req.url ?? "/", "http://phone.invalid");
		} catch {
			return sendJSON(res, 400, { error: "Bad request." });
		}
		if (url.pathname === "/phone/v1/pair" && req.method === "POST") return handlePair(req, res);
		const device = authenticate(req);
		if (!device) return sendJSON(res, 401, { error: "This phone is not paired, or its pairing was removed." });
		if (url.pathname === "/phone/v1/ping" && req.method === "GET") {
			return sendJSON(res, 200, { ok: true, protocol: PROTOCOL, deviceId: device.id, server: { name: info.name ?? os.hostname(), version: info.version ?? null } });
		}
		if (!phoneRouteAllowed(req.method ?? "GET", url.pathname)) return sendJSON(res, 403, { error: "This action is available only on the desktop." });
		proxy(req, res, url);
	}

	function start({ host = "0.0.0.0", port } = {}) {
		if (server) return Promise.resolve(server.address());
		const listenPort = port ?? store.read().port ?? DEFAULT_PORT;
		return new Promise((resolve, reject) => {
			const srv = http.createServer((req, res) => {
				handle(req, res).catch((err) => {
					log(`phone access: ${err.stack ?? err}`);
					if (!res.headersSent) sendJSON(res, 500, { error: "Internal error." });
				});
			});
			srv.on("connection", (socket) => {
				sockets.add(socket);
				socket.on("close", () => sockets.delete(socket));
			});
			srv.once("error", reject);
			srv.listen(listenPort, host, () => {
				server = srv;
				log(`phone access: listening on ${host}:${srv.address().port}`);
				resolve(srv.address());
			});
		});
	}

	function stop() {
		pairing = null;
		if (!server) return Promise.resolve();
		const srv = server;
		server = null;
		for (const socket of sockets) socket.destroy();
		return new Promise((resolve) => srv.close(() => resolve()));
	}

	function revoke(deviceId) {
		store.update((state) => ({ ...state, devices: state.devices.filter((d) => d.id !== deviceId) }));
		log(`phone access: revoked ${deviceId}`);
	}

	return { start, stop, startPairing, cancelPairing, pairingPayload, revoke, running: () => server !== null, address: () => server?.address() ?? null };
}

module.exports = {
	createPhoneAccessStore,
	createPhoneGateway,
	phoneRouteAllowed,
	reachableAddresses,
	hashToken,
	DEFAULT_PORT,
	PAIRING_TTL_MS,
	PROTOCOL,
};
