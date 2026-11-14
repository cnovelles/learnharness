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

function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-phone-win-"));
	const fake = fakeElectron();
	const access = createPhoneAccess({
		electron: fake.electron,
		file: path.join(dir, "phone-access.json"),
		target: () => ({ url: "http://127.0.0.1:1" }),
		info: { name: "Test Mac", version: "test" },
		log: () => {},
	});
	// Port 0: never collide with a running app.
	access.store.update((s: any) => ({ ...s, port: 0 }));
	access.openWindow();
	const win = fake.windows[0];
	return { fake, access, win, call: (channel: string, ...args: unknown[]) => fake.invoke(channel, win.webContents, ...args) };
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
	const { call, fake, access } = setup();
	const state = await call("lh:phone:set-enabled", true);
	assert.equal(state.running, true);
	const shown = await call("lh:phone:pair");
	assert.match(shown.svg, /^<svg/);
	assert.equal(JSON.stringify(shown).includes("code"), false, "the window result holds no code field");

	assert.deepEqual(await call("lh:phone:copy-pairing"), { ok: true });
	const payload = JSON.parse(fake.clipboard());
	assert.equal(payload.lh, 1);
	assert.equal(payload.name, "Test Mac");
	assert.deepEqual(payload.urls, shown.urls);
	assert.equal(typeof payload.code, "string");

	// The copied code pairs exactly once through the real gateway.
	const port = access.gateway.address().port;
	const pair = (code: string) => fetch(`http://127.0.0.1:${port}/phone/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Sim" }) });
	assert.equal((await pair(payload.code)).status, 200);
	assert.equal((await pair(payload.code)).status, 401);

	const after = await call("lh:phone:state");
	assert.equal(after.devices.length, 1);
	assert.deepEqual(Object.keys(after.devices[0]).sort(), ["createdAt", "id", "lastSeenAt", "name"], "no token hash reaches the page");
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
	const { call, fake, access } = setup();
	await call("lh:phone:set-enabled", true);
	await call("lh:phone:pair");
	await call("lh:phone:copy-pairing");
	const { code } = JSON.parse(fake.clipboard());
	const port = access.gateway.address().port;
	const res = await fetch(`http://127.0.0.1:${port}/phone/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
	const { deviceId, token } = await res.json();
	const state = await call("lh:phone:revoke", deviceId);
	assert.deepEqual(state.devices, []);
	assert.ok(fake.sent.some((m) => m.channel === "lh:phone:changed" && m.value.devices.length === 0));
	const ping = await fetch(`http://127.0.0.1:${port}/phone/v1/ping`, { headers: { authorization: `Bearer ${token}` } });
	assert.equal(ping.status, 401);
	await access.stop();
});

test("a phone that pairs makes the window drop the spent code and list the device", async () => {
	const { call, fake, access } = setup();
	await call("lh:phone:set-enabled", true);
	await call("lh:phone:pair");
	await call("lh:phone:copy-pairing");
	const { code } = JSON.parse(fake.clipboard());
	fake.sent.length = 0;
	const port = access.gateway.address().port;
	const res = await fetch(`http://127.0.0.1:${port}/phone/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Test iPhone" }) });
	assert.equal(res.status, 200);
	assert.deepEqual(fake.sent.find((m) => m.channel === "lh:phone:paired")?.value, { name: "Test iPhone" });
	const changed = fake.sent.find((m) => m.channel === "lh:phone:changed");
	assert.deepEqual(changed?.value.devices.map((d: any) => d.name), ["Test iPhone"]);
	assert.deepEqual(await call("lh:phone:copy-pairing"), { error: "Show a new QR code first." }, "the spent payload is gone");
	await access.stop();
});
