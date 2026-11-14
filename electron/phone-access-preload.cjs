"use strict";

/* Phone access window bridge (mobile fork). Only this window loads it. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("phoneAccess", {
	state: () => ipcRenderer.invoke("lh:phone:state"),
	setEnabled: (enabled) => ipcRenderer.invoke("lh:phone:set-enabled", enabled === true),
	pair: () => ipcRenderer.invoke("lh:phone:pair"),
	cancelPair: () => ipcRenderer.invoke("lh:phone:cancel-pair"),
	copyPairing: () => ipcRenderer.invoke("lh:phone:copy-pairing"),
	revoke: (deviceId) => ipcRenderer.invoke("lh:phone:revoke", String(deviceId)),
	onPaired: (cb) => {
		const listener = (_event, device) => cb(device);
		ipcRenderer.on("lh:phone:paired", listener);
		return () => ipcRenderer.removeListener("lh:phone:paired", listener);
	},
	onChanged: (cb) => {
		const listener = (_event, snapshot) => cb(snapshot);
		ipcRenderer.on("lh:phone:changed", listener);
		return () => ipcRenderer.removeListener("lh:phone:changed", listener);
	},
});
