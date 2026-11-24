/**
 * Phone Access window IPC (electron/phone-access-window.cjs) with a fake
 * Electron: only the window's own webContents can call it, the pairing QR
 * and the copied pairing text carry the same one-use payload, and the
 * window page never receives a device token or the pairing code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pinnedFetch } from "./helpers/pinned-fetch.ts";

const require = createRequire(import.meta.url);
const { createPhoneAccess } = require("../electron/phone-access-window.cjs");

function fakeElectron() {
	const handlers = new Map<string, (event: any, ...args: any[]) => any>();
	const sent: any[] = [];
	let clipboardText = "";
	const windows: any[] = [];
	class BrowserWindow {
		webContents = { send: (channel: string, value: unknown) => sent.push({ channel, value }), on: () => {}, setWindowOpenHandler: () => {} };
		listeners = new Map<string, () => void>();
		destroyed = false;
		constructor(public options: any) {
			windows.push(this);
		}
		on(name: string, fn: () => void) {
			this.listeners.set(name, fn);
		}
		isDestroyed() {
			return this.destroyed;
		}
		focus() {}
		loadFile() {
			return Promise.resolve();
		}
		close() {
			this.destroyed = true;
			this.listeners.get("closed")?.();
		}
	}
	return {
		electron: {
			BrowserWindow,
			ipcMain: { handle: (channel: string, fn: any) => handlers.set(channel, fn) },
			shell: { openExternal: async () => {} },
			clipboard: { writeText: (t: string) => (clipboardText = t) },
		},
		invoke: (channel: string, sender: unknown, ...args: unknown[]) => handlers.get(channel)!({ sender }, ...args),
		clipboard: () => clipboardText,
		windows,
		sent,
	};
}

function setup(options: { networkInterfaces?: () => Record<string, any[]>; addressCheckMs?: number } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-phone-win-"));
	const fake = fakeElectron();
	const access = createPhoneAccess({
		electron: fake.electron,
		file: path.join(dir, "phone-access.json"),
		tlsDir: path.join(dir, "tls"),
		target: () => ({ url: "http://127.0.0.1:1" }),
		info: { name: "Test Mac", version: "test" },
		log: () => {},
		...options,
	});
	// Port 0: never collide with a running app.
	access.store.update((s: any) => ({ ...s, port: 0 }));
	access.openWindow();
	const win = fake.windows[0];
	// The phone side: pinned to the gateway certificate (known once it runs).
	let client: ReturnType<typeof pinnedFetch> | null = null;
	const phone = (url: string, init?: RequestInit) => (client ??= pinnedFetch(access.gateway.pin()))(url, init);
	const stop = access.stop;
	access.stop = async () => {
		await client?.close();
		await stop();
	};
	return { fake, access, win, phone, call: (channel: string, ...args: unknown[]) => fake.invoke(channel, win.webContents, ...args) };
}

test("calls from another webContents are refused", async () => {
	const { fake, access } = setup();
	const other = { send: () => {} };
	assert.equal(await fake.invoke("lh:phone:state", other), null);
	assert.equal(await fake.invoke("lh:phone:set-enabled", other, true), null);
	assert.equal(await fake.invoke("lh:phone:pair", other), null);
	assert.equal(await fake.invoke("lh:phone:copy-pairing", other), null);
	assert.equal(access.gateway.running(), false);
});

test("pairing needs the gateway on; copy needs a shown code", async () => {
	const { call, access } = setup();
	assert.deepEqual(await call("lh:phone:pair"), { error: "Turn on phone access first." });
	assert.deepEqual(await call("lh:phone:copy-pairing"), { error: "Show a new QR code first." });
	await call("lh:phone:set-enabled", true);
	assert.equal(access.gateway.running(), true);
	await access.stop();
});

test("copied pairing text is the QR payload; the window page gets neither the code nor a token", async () => {
	const { call, fake, access, phone } = setup();
	const state = await call("lh:phone:set-enabled", true);
	assert.equal(state.running, true);
	const shown = await call("lh:phone:pair");
	assert.match(shown.svg, /^<svg/);
	assert.equal(JSON.stringify(shown).includes("code"), false, "the window result holds no code field");

	assert.deepEqual(await call("lh:phone:copy-pairing"), { ok: true });
	const payload = JSON.parse(fake.clipboard());
	assert.equal(payload.lh, 2);
	assert.equal(payload.name, "Test Mac");
	assert.deepEqual(payload.urls, shown.urls);
	assert.equal(payload.pin, access.gateway.pin(), "the QR payload carries the certificate pin");
	assert.equal(typeof payload.code, "string");

	// The copied code pairs exactly once through the real gateway.
	const port = access.gateway.address().port;
	const pair = (code: string) => phone(`https://127.0.0.1:${port}/phone/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Sim" }) });
	assert.equal((await pair(payload.code)).status, 200);
	assert.equal((await pair(payload.code)).status, 401);

	const after = await call("lh:phone:state");
	assert.equal(after.devices.length, 1);
	assert.deepEqual(Object.keys(after.devices[0]).sort(), ["createdAt", "id", "lastSeenAt", "name", "tailscale"], "no token hash reaches the page");
	await access.stop();
});

test("cancel and window close forget the copied payload", async () => {
	const { call, win, access } = setup();
	await call("lh:phone:set-enabled", true);
	await call("lh:phone:pair");
	await call("lh:phone:cancel-pair");
	assert.deepEqual(await call("lh:phone:copy-pairing"), { error: "Show a new QR code first." });
	await call("lh:phone:pair");
	win.close();
	access.openWindow();
	await access.stop();
});

test("revoke removes the device and pushes the new state to the window", async () => {
	const { call, fake, access, phone } = setup();
	await call("lh:phone:set-enabled", true);
	await call("lh:phone:pair");
	await call("lh:phone:copy-pairing");
	const { code } = JSON.parse(fake.clipboard());
	const port = access.gateway.address().port;
	const res = await phone(`https://127.0.0.1:${port}/phone/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
	const { deviceId, token } = await res.json();
	const state = await call("lh:phone:revoke", deviceId);
	assert.deepEqual(state.devices, []);
	assert.ok(fake.sent.some((m) => m.channel === "lh:phone:changed" && m.value.devices.length === 0));
	const ping = await phone(`https://127.0.0.1:${port}/phone/v1/ping`, { headers: { authorization: `Bearer ${token}` } });
	assert.equal(ping.status, 401);
	await access.stop();
});

test("a phone that pairs makes the window drop the spent code and list the device", async () => {
	const { call, fake, access, phone } = setup();
	await call("lh:phone:set-enabled", true);
	await call("lh:phone:pair");
	await call("lh:phone:copy-pairing");
	const { code } = JSON.parse(fake.clipboard());
	fake.sent.length = 0;
	const port = access.gateway.address().port;
	const res = await phone(`https://127.0.0.1:${port}/phone/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Test iPhone" }) });
	assert.equal(res.status, 200);
	assert.deepEqual(fake.sent.find((m) => m.channel === "lh:phone:paired")?.value, { name: "Test iPhone" });
	const changed = fake.sent.find((m) => m.channel === "lh:phone:changed");
	assert.deepEqual(changed?.value.devices.map((d: any) => d.name), ["Test iPhone"]);
	assert.deepEqual(await call("lh:phone:copy-pairing"), { error: "Show a new QR code first." }, "the spent payload is gone");
	await access.stop();
});

test("wrong codes that cancel the code make the window drop the dead QR code", async () => {
	const { call, fake, access, phone } = setup();
	await call("lh:phone:set-enabled", true);
	await call("lh:phone:pair");
	fake.sent.length = 0;
	const port = access.gateway.address().port;
	for (let i = 0; i < 10; i++) {
		await phone(`https://127.0.0.1:${port}/phone/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: `wrong-${i}` }) });
	}
	assert.ok(fake.sent.some((m) => m.channel === "lh:phone:pair-cancelled"));
	assert.deepEqual(await call("lh:phone:copy-pairing"), { error: "Show a new QR code first." });
	await access.stop();
});

const LAN_ONLY = () => ({ en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }] });
const WITH_TAILSCALE = () => ({ ...LAN_ONLY(), utun4: [{ address: "100.101.102.103", family: "IPv4", internal: false }] });

test("the state says if the Mac has a Tailscale address, and each device says if it got one", async () => {
	let interfaces: () => Record<string, any[]> = LAN_ONLY;
	const { call, fake, access, phone } = setup({ networkInterfaces: () => interfaces() });
	await call("lh:phone:set-enabled", true);
	assert.equal((await call("lh:phone:state")).tailscale, false);

	await call("lh:phone:pair");
	await call("lh:phone:copy-pairing");
	const { code } = JSON.parse(fake.clipboard());
	const port = access.gateway.address().port;
	const res = await phone(`https://127.0.0.1:${port}/phone/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Home phone" }) });
	assert.equal(res.status, 200);

	interfaces = WITH_TAILSCALE;
	const state = await call("lh:phone:state");
	assert.equal(state.tailscale, true);
	assert.deepEqual(state.devices.map((d: any) => [d.name, d.tailscale]), [["Home phone", false]]);
	assert.equal(state.devices[0].tokenHash, undefined, "the window never gets the token hash");
	await access.stop();
});

test("the open window gets a new state when the addresses change", async () => {
	let interfaces: () => Record<string, any[]> = LAN_ONLY;
	const { call, fake, access, win } = setup({ networkInterfaces: () => interfaces(), addressCheckMs: 10 });
	await call("lh:phone:set-enabled", true);
	fake.sent.length = 0;
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(fake.sent.filter((m) => m.channel === "lh:phone:changed").length, 0, "no push while nothing changes");

	interfaces = WITH_TAILSCALE;
	await new Promise((r) => setTimeout(r, 40));
	const pushes = fake.sent.filter((m) => m.channel === "lh:phone:changed");
	assert.equal(pushes.length, 1, "one push for one change");
	assert.equal(pushes[0].value.tailscale, true);

	win.close();
	interfaces = LAN_ONLY;
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(fake.sent.filter((m) => m.channel === "lh:phone:changed").length, 1, "no checks after the window closes");
	await access.stop();
});
