"use strict";

/**
 * Phone access (mobile fork). A second listener that lets a paired phone use
 * this desktop app's server while the desktop window stays open.
 *
 * What it is:
 *  - An HTTPS gateway on a fixed port (all interfaces, so LAN and Tailscale).
 *    No plain HTTP listener. The certificate is self-signed
 *    (phone-access-tls.cjs); the phone pins its public key, which it gets
 *    from the pairing QR code, and sends nothing to a server that fails it.
 *  - Each request must carry a device token from QR pairing.
 *  - Only an allowlist of chat/graph routes passes. Keys, subscriptions,
 *    providers, prompts and settings writes stay desktop-only. The folder
 *    writes pass only through the checks of PHONE_WRITES.
 *  - Allowed requests stream to the loopback server with the desktop
 *    capability header added here. The server code is unchanged.
 *
 * What it is not: a public-internet host. Use Tailscale outside the home
 * network.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { loadOrCreateCertificate } = require("./phone-access-tls.cjs");

const STORE_VERSION = 1;
const DEFAULT_PORT = 47821;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 26 * 1024 * 1024;
/** Wrong codes allowed against one pairing code. The next one cancels that code. */
const FAILED_PAIR_LIMIT = 10;
const LAST_SEEN_SAVE_MS = 60 * 1000;
const DESKTOP_HEADER = "x-learnharness-desktop";
/** 2: HTTPS with the SPKI pin in the pairing payload (1 was plain HTTP). */
const PROTOCOL = 2;

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

/** Folder ids and names: at most this many characters. */
const MAX_FOLDER_TEXT = 200;
/** The gateway refuses a new folder when the Mac already has this many. */
const MAX_FOLDERS = 500;
/** A checked write must send its whole body in this time. */
const WRITE_BODY_TIMEOUT_MS = 10 * 1000;
/** The longest time one checked write holds the queue. */
const WRITE_HOLD_MS = 30 * 1000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** The keys of each folder action (fork src/core/source-organization.ts). */
const FOLDER_ACTION_KEYS = {
	"create-folder": ["action", "name", "parentId"],
	"rename-folder": ["action", "id", "name"],
	"rename-source": ["action", "id", "name"],
	move: ["action", "kind", "id", "parentId"],
	"delete-folder": ["action", "id"],
};

const isText = (value) => typeof value === "string" && value.length <= MAX_FOLDER_TEXT && !CONTROL_CHARS.test(value);

/** The error for a folder action that the gateway refuses, or null. The
 * server checks the meaning (the folder exists, no cycle, empty delete);
 * this checks the shape and the sizes. */
function checkFolderAction(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return "The folder change is not valid.";
	const keys = Object.hasOwn(FOLDER_ACTION_KEYS, body.action) ? FOLDER_ACTION_KEYS[body.action] : null;
	if (!keys) return "The folder change is not valid.";
	const given = Object.keys(body);
	if (given.length !== keys.length || !keys.every((key) => Object.hasOwn(body, key))) return "The folder change is not valid.";
	if ("id" in body && !(isText(body.id) && body.id.length > 0)) return "The folder change is not valid.";
	if ("parentId" in body && body.parentId !== null && !(isText(body.parentId) && body.parentId.length > 0)) return "The folder change is not valid.";
	if ("kind" in body && body.kind !== "source" && body.kind !== "folder") return "The folder change is not valid.";
	if ("name" in body) {
		if (typeof body.name !== "string" || !body.name.trim()) return "Enter a name.";
		if (!isText(body.name.trim()) || CONTROL_CHARS.test(body.name)) return `Use a name of at most ${MAX_FOLDER_TEXT} characters, on one line.`;
	}
	return null;
}

/**
 * The only writes that a phone can send with a body that the gateway checks.
 * To add, change or remove a phone write, change this table only. The
 * gateway reads the body (at most `maxBytes`), parses it as JSON, calls
 * `check` and `limit`, and sends the checked body to the server. Audit:
 * learnharness-mobile docs/TRANSPORT-SECURITY.md "Gateway writes" (D-015).
 */
const PHONE_WRITES = [
	{
		method: "POST",
		pattern: /^\/api\/graph\/sources$/,
		maxBytes: 4 * 1024,
		check: checkFolderAction,
		/** Reads the folder list only before a new folder. The gateway runs
		 * the writes of this entry one at a time, so two new folders at the
		 * same time cannot both pass the count. */
		limit: async (body, readJSON) => {
			if (body.action !== "create-folder") return null;
			const directory = await readJSON("/api/graph/sources");
			const folders = directory?.organization?.folders;
			if (!Array.isArray(folders)) throw new Error("the folder list is not valid");
			return folders.length >= MAX_FOLDERS ? { status: 409, error: `This Mac has the most folders it can keep (${MAX_FOLDERS}). Delete a folder first.`, code: "folder-limit" } : null;
		},
	},
];

const safePath = (pathname) => typeof pathname === "string" && !pathname.includes("..") && !pathname.includes("//");

function phoneWriteFor(method, pathname) {
	if (!safePath(pathname)) return null;
	return PHONE_WRITES.find((write) => write.method === method && write.pattern.test(pathname)) ?? null;
}

function phoneRouteAllowed(method, pathname) {
	if (!safePath(pathname)) return false;
	return ROUTES.some((route) => route.pattern.test(pathname) && route.methods.includes(method)) || phoneWriteFor(method, pathname) !== null;
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

/** @param {boolean} [destroyOnOverflow] false: pause the request instead, so
 * the caller can answer 413 first and then close the connection. */
function readJSONBody(req, limit = 64 * 1024, destroyOnOverflow = true) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let over = false;
		req.on("data", (chunk) => {
			if (over) return;
			size += chunk.length;
			if (size > limit) {
				over = true;
				reject(Object.assign(new Error("body too large"), { status: 413 }));
				if (destroyOnOverflow) req.destroy();
				else req.pause();
				return;
			}
			chunks.push(chunk);
		});
		let ended = false;
		// A destroyed request (a timeout, a lost phone) sends no "end".
		req.on("close", () => {
			if (!ended && !over) reject(Object.assign(new Error("request closed"), { status: 400 }));
		});
		req.on("end", () => {
			ended = true;
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
 * @param {string} options.tlsDir folder for the gateway key and certificate (userData)
 * @param {{name?: string, version?: string}} [options.info]
 * @param {(line: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {(device: {id: string, name: string}) => void} [options.onPaired] called after a phone pairs
 * @param {(reason: "too-many-attempts") => void} [options.onPairingCancelled] called when wrong codes cancel the active code
 * @param {() => ReturnType<typeof os.networkInterfaces>} [options.networkInterfaces] the network interfaces (tests replace it)
 * @param {number} [options.writeBodyTimeoutMs] the time a checked write has to send its body (tests make it short)
 */
function createPhoneGateway({ store, target, tlsDir, info = {}, log = () => {}, now = () => Date.now(), onPaired = () => {}, onPairingCancelled = () => {}, networkInterfaces = () => os.networkInterfaces(), writeBodyTimeoutMs = WRITE_BODY_TIMEOUT_MS }) {
	let server = null;
	let certificate = null; // {key, cert, pin}, loaded by start()
	// The active one-use code. `failures` counts wrong codes against THIS code
	// only: a device on the network can cancel a code, but it cannot block the
	// next one (a new code starts at zero).
	// `tailscale`: the last payload for this code had a Tailscale address.
	let pairing = null; // {codeHash, expiresAt, failures, tailscale?}
	const lastSeenSaved = new Map();
	const sockets = new Set();
	// Open proxied requests by device id, so a revoke closes them at once.
	const activeByDevice = new Map(); // deviceId -> Set<{res, upstream}>
	// The checked writes run one at a time (check, limit, server answer), so
	// a limit cannot be passed by two writes at the same time.
	let writeQueue = Promise.resolve();

	function startPairing() {
		const code = randomToken(18);
		pairing = { codeHash: hashToken(code), expiresAt: now() + PAIRING_TTL_MS, failures: 0 };
		return { code, expiresAt: pairing.expiresAt };
	}

	function cancelPairing() {
		pairing = null;
	}

	/** The addresses a phone can reach now (Tailscale first). */
	function addresses() {
		return reachableAddresses(networkInterfaces());
	}

	/** The pairing payload (QR code and "Copy pairing text"). Needs a started gateway (the pin). */
	function pairingPayload(code, port = store.read().port) {
		if (!certificate) throw new Error("phone access: start the gateway before pairing");
		const list = addresses();
		// The phone knows only the addresses in this payload. Keep a note of
		// whether a Tailscale address was one of them, for the device record.
		if (pairing) pairing.tailscale = list.some((a) => a.kind === "tailscale");
		const urls = list.map((a) => `https://${a.address}:${port}`);
		return JSON.stringify({ lh: PROTOCOL, name: info.name ?? os.hostname(), urls, pin: certificate.pin, code });
	}

	/** Load the certificate, or make one. A new key has a new pin: the
	 * paired phones cannot connect any more, so they must pair again. */
	function loadCertificate() {
		if (typeof tlsDir !== "string" || !tlsDir) throw new Error("phone access: tlsDir is missing");
		const loaded = loadOrCreateCertificate(tlsDir, { log });
		if (loaded.created) {
			const before = store.read().devices.length;
			if (before > 0) {
				store.update((state) => ({ ...state, devices: [] }));
				log(`phone access: new certificate; removed ${before} paired phone(s), which must pair again`);
			}
		}
		certificate = { key: loaded.key, cert: loaded.cert, pin: loaded.pin };
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
		let body;
		try {
			body = await readJSONBody(req);
		} catch (err) {
			return sendJSON(res, err.status ?? 400, { error: err.message });
		}
		const code = typeof body.code === "string" ? body.code : "";
		const valid = pairing && t <= pairing.expiresAt && code.length > 0 && safeEqualHex(pairing.codeHash, hashToken(code));
		if (!valid) {
			if (pairing && t <= pairing.expiresAt) {
				pairing.failures += 1;
				if (pairing.failures >= FAILED_PAIR_LIMIT) {
					pairing = null;
					log("phone access: pairing code cancelled after too many wrong codes");
					try {
						onPairingCancelled("too-many-attempts");
					} catch (err) {
						log(`phone access: onPairingCancelled failed: ${err.message}`);
					}
				}
			}
			return sendJSON(res, 401, { error: "The pairing code is not valid or has expired. Show a new QR code on the Mac." });
		}
		const offeredTailscale = pairing.tailscale;
		pairing = null; // one use
		const token = randomToken(32);
		const device = {
			id: `dev_${randomToken(9)}`,
			name: typeof body.deviceName === "string" && body.deviceName.trim() ? body.deviceName.trim().slice(0, 80) : "Phone",
			tokenHash: hashToken(token),
			createdAt: new Date(t).toISOString(),
			lastSeenAt: new Date(t).toISOString(),
			// false: the phone got no Tailscale address, so it can connect only
			// on the local network. Absent: not known (no payload was made).
			...(typeof offeredTailscale === "boolean" ? { tailscale: offeredTailscale } : {}),
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

	// Upstream requests that the gateway closes on purpose (the phone went
	// away, a body was too large, a revoke). Node reports such a close as
	// "socket hang up", which is not a failure, so it is not logged.
	const closedOnPurpose = new WeakSet();
	function closeUpstream(upstream) {
		closedOnPurpose.add(upstream);
		upstream.destroy();
	}

	function track(deviceId, entry) {
		let set = activeByDevice.get(deviceId);
		if (!set) activeByDevice.set(deviceId, (set = new Set()));
		set.add(entry);
		return () => {
			set.delete(entry);
			if (set.size === 0 && activeByDevice.get(deviceId) === set) activeByDevice.delete(deviceId);
		};
	}

	/** GET a JSON answer from the loopback server (for a write's `limit`). */
	function readUpstreamJSON(pathname) {
		const { url: base, secret } = target();
		const upstreamURL = new URL(pathname, base);
		const headers = { accept: "application/json", host: upstreamURL.host };
		if (secret) headers[DESKTOP_HEADER] = secret;
		return new Promise((resolve, reject) => {
			const request = http.get(upstreamURL, { headers }, (upRes) => {
				const chunks = [];
				upRes.on("data", (chunk) => chunks.push(chunk));
				upRes.on("end", () => {
					if ((upRes.statusCode ?? 500) >= 400) return reject(new Error(`upstream ${upRes.statusCode}`));
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch {
						reject(new Error("upstream answer is not JSON"));
					}
				});
				upRes.on("error", reject);
			});
			request.on("error", reject);
		});
	}

	/** A write from PHONE_WRITES: read and check the body here, then send
	 * the checked body. A refused body never reaches the server. */
	async function handleWrite(req, res, url, device, write) {
		// A refusal before the read answers first, then closes: the body is never read.
		const refuse = (status, error) => {
			res.setHeader("Connection", "close");
			res.on("finish", () => req.destroy());
			return sendJSON(res, status, { error });
		};
		const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
		if (type !== "application/json") return refuse(415, "The request must be JSON.");
		if (Number(req.headers["content-length"] ?? 0) > write.maxBytes) return refuse(413, "Request body too large.");
		let body;
		let timedOut = false;
		const slow = setTimeout(() => {
			timedOut = true;
			req.destroy();
		}, writeBodyTimeoutMs);
		try {
			body = await readJSONBody(req, write.maxBytes, false);
		} catch (err) {
			if (timedOut) return res.destroy();
			return err.status === 413 ? refuse(413, "Request body too large.") : sendJSON(res, 400, { error: "The request must be JSON." });
		}
		finally {
			clearTimeout(slow);
		}
		const problem = write.check(body);
		if (problem) return sendJSON(res, 400, { error: problem });
		const turn = writeQueue.then(() => runWrite(req, res, url, device, write, body));
		writeQueue = turn.catch(() => {});
		return turn;
	}

	/** One checked write, in the queue: the limit, then the server, until the answer ends. */
	async function runWrite(req, res, url, device, write, body) {
		if (res.destroyed) return;
		let refusal;
		try {
			refusal = await write.limit(body, readUpstreamJSON);
		} catch (err) {
			log(`phone access: write limit check failed: ${err.message}`);
			return sendJSON(res, 502, { error: "The LearnHarness server is not reachable." });
		}
		if (refusal) return sendJSON(res, refusal.status, { error: refusal.error, code: refusal.code });
		// The phone can be removed while its write waits: check it again.
		if (!store.read().devices.some((d) => d.id === device.id)) return sendJSON(res, 401, { error: "This phone is not paired, or its pairing was removed." });
		// The next write waits for this answer, but never more than WRITE_HOLD_MS.
		await new Promise((resolve) => {
			const hold = setTimeout(resolve, WRITE_HOLD_MS);
			res.once("close", () => {
				clearTimeout(hold);
				resolve();
			});
			proxy(req, res, url, device, Buffer.from(JSON.stringify(body), "utf8"));
		});
	}

	/** @param {Buffer} [body] a body that the gateway already read and checked */
	function proxy(req, res, url, device, body) {
		const { url: base, secret } = target();
		const upstreamURL = new URL(url.pathname + url.search, base);
		const headers = {};
		for (const name of FORWARD_HEADERS) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
		if (body) {
			headers["content-type"] = "application/json";
			headers["content-length"] = String(body.length);
		}
		const declared = Number(req.headers["content-length"] ?? 0);
		if (!body && declared > MAX_BODY_BYTES) return sendJSON(res, 413, { error: "Request body too large." });
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
			if (closedOnPurpose.has(upstream)) return;
			log(`phone access: upstream error ${err.message}`);
			if (!res.headersSent) sendJSON(res, 502, { error: "The LearnHarness server is not reachable." });
			else res.destroy();
		});
		const untrack = track(device.id, { res, upstream });
		// A phone that disconnects detaches its view, like a closed browser tab.
		res.on("close", () => {
			untrack();
			if (!res.writableFinished) closeUpstream(upstream);
		});
		if (body) {
			upstream.end(body);
			return;
		}
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				closeUpstream(upstream);
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
		const write = phoneWriteFor(req.method ?? "GET", url.pathname);
		if (write) return handleWrite(req, res, url, device, write);
		proxy(req, res, url, device);
	}

	function start({ host = "0.0.0.0", port } = {}) {
		if (server) return Promise.resolve(server.address());
		const listenPort = port ?? store.read().port ?? DEFAULT_PORT;
		try {
			loadCertificate();
		} catch (err) {
			return Promise.reject(err);
		}
		return new Promise((resolve, reject) => {
			const srv = https.createServer({ key: certificate.key, cert: certificate.cert, minVersion: "TLSv1.2" }, (req, res) => {
				handle(req, res).catch((err) => {
					log(`phone access: ${err.stack ?? err}`);
					if (!res.headersSent) sendJSON(res, 500, { error: "Internal error." });
				});
			});
			srv.on("tlsClientError", (err) => log(`phone access: TLS handshake failed: ${err.code ?? err.message}`));
			srv.on("connection", (socket) => {
				sockets.add(socket);
				socket.on("close", () => sockets.delete(socket));
			});
			srv.once("error", reject);
			srv.listen(listenPort, host, () => {
				server = srv;
				log(`phone access: listening (HTTPS) on ${host}:${srv.address().port}`);
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
		// Close what the device still has open (event and turn streams), on
		// both sides. Its token already fails every new request.
		const open = activeByDevice.get(deviceId);
		activeByDevice.delete(deviceId);
		for (const { res, upstream } of open ?? []) {
			closeUpstream(upstream);
			res.destroy();
		}
		lastSeenSaved.delete(deviceId);
		log(`phone access: revoked ${deviceId}${open?.size ? ` and closed ${open.size} open request(s)` : ""}`);
	}

	return { start, stop, startPairing, cancelPairing, pairingPayload, addresses, revoke, running: () => server !== null, address: () => server?.address() ?? null, pin: () => certificate?.pin ?? null };
}

module.exports = {
	createPhoneAccessStore,
	createPhoneGateway,
	phoneRouteAllowed,
	phoneWriteFor,
	checkFolderAction,
	reachableAddresses,
	MAX_FOLDERS,
	MAX_FOLDER_TEXT,
	hashToken,
	DEFAULT_PORT,
	PAIRING_TTL_MS,
	PROTOCOL,
};
