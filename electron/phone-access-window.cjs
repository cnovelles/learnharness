"use strict";

/**
 * Phone access window + IPC (mobile fork). Main process only.
 * The window is a local file page with its own minimal preload. It can turn
 * the gateway on or off, show a one-use pairing QR code and revoke devices.
 * It never receives a device token: tokens go only to the phone, once.
 */

const path = require("node:path");
// Core + SVG renderer only: the package entry also loads pngjs, which the
// packaged shell does not ship (see electron-builder.yml).
const QRCodeCore = require("qrcode/lib/core/qrcode");
const QRCodeSVG = require("qrcode/lib/renderer/svg-tag");

function qrSVG(payload) {
	return QRCodeSVG.render(QRCodeCore.create(payload, { errorCorrectionLevel: "M" }), { margin: 1 });
}
const { createPhoneAccessStore, createPhoneGateway, reachableAddresses } = require("./phone-access.cjs");

/** `electron` is injected by main.cjs (its own module objects), so test
 * harnesses that fake Electron also fake this window. */
function createPhoneAccess({ electron, file, target, info, log }) {
	const { BrowserWindow, ipcMain, shell } = electron;
	const store = createPhoneAccessStore(file);
	const gateway = createPhoneGateway({ store, target, info, log });
	let win = null;
	let lastError = null;

	function snapshot() {
		const state = store.read();
		return {
			enabled: state.enabled,
			running: gateway.running(),
			port: state.port,
			error: lastError,
			addresses: reachableAddresses().map((a) => ({ ...a, url: `http://${a.address}:${state.port}` })),
			devices: state.devices.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt })),
		};
	}

	function push() {
		if (win && !win.isDestroyed()) win.webContents.send("lh:phone:changed", snapshot());
	}

	async function setEnabled(enabled) {
		store.update((state) => ({ ...state, enabled }));
		lastError = null;
		if (enabled) {
			try {
				await gateway.start();
			} catch (err) {
				lastError = err.code === "EADDRINUSE" ? `Port ${store.read().port} is in use by another program.` : String(err.message ?? err);
				log(`phone access: start failed: ${err.message ?? err}`);
			}
		} else {
			await gateway.stop();
		}
		push();
		return snapshot();
	}

	async function startIfEnabled() {
		try {
			if (store.read().enabled) await setEnabled(true);
		} catch (err) {
			lastError = String(err.message ?? err);
			log(`phone access: ${lastError}`);
		}
	}

	const fromWindow = (event) => win && !win.isDestroyed() && event.sender === win.webContents;

	ipcMain.handle("lh:phone:state", (event) => (fromWindow(event) ? snapshot() : null));
	ipcMain.handle("lh:phone:set-enabled", (event, enabled) => (fromWindow(event) ? setEnabled(enabled === true) : null));
	ipcMain.handle("lh:phone:pair", async (event) => {
		if (!fromWindow(event)) return null;
		if (!gateway.running()) return { error: "Turn on phone access first." };
		const { code, expiresAt } = gateway.startPairing();
		const payload = gateway.pairingPayload(code);
		const svg = qrSVG(payload);
		return { svg, expiresAt, urls: JSON.parse(payload).urls };
	});
	ipcMain.handle("lh:phone:cancel-pair", (event) => {
		if (fromWindow(event)) gateway.cancelPairing();
	});
	ipcMain.handle("lh:phone:revoke", (event, deviceId) => {
		if (!fromWindow(event) || typeof deviceId !== "string") return null;
		gateway.revoke(deviceId);
		push();
		return snapshot();
	});

	function openWindow() {
		if (win && !win.isDestroyed()) {
			win.focus();
			return;
		}
		win = new BrowserWindow({
			width: 520,
			height: 720,
			title: "Phone Access",
			backgroundColor: "#141414",
			resizable: true,
			webPreferences: {
				contextIsolation: true,
				sandbox: true,
				nodeIntegration: false,
				preload: path.join(__dirname, "phone-access-preload.cjs"),
			},
		});
		win.webContents.on("will-navigate", (event) => event.preventDefault());
		win.webContents.setWindowOpenHandler(({ url }) => {
			if (url.startsWith("https://")) void shell.openExternal(url);
			return { action: "deny" };
		});
		win.on("closed", () => {
			gateway.cancelPairing();
			win = null;
		});
		void win.loadFile(path.join(__dirname, "phone-access.html"));
	}

	return { openWindow, startIfEnabled, stop: () => gateway.stop(), gateway, store };
}

module.exports = { createPhoneAccess };
