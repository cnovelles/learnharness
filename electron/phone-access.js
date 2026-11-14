"use strict";

/* Phone access window script (mobile fork). Runs in the sandboxed renderer. */
const api = window.phoneAccess;
const $ = (id) => document.getElementById(id);
let pairTimer = null;

function text(el, value) {
	el.textContent = value;
}

function fmt(iso) {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

function render(state) {
	if (!state) return;
	text($("status"), state.running ? "On" : state.enabled ? "Not running" : "Off");
	text($("statusDetail"), state.running ? `Listening on port ${state.port}.` : "The phone cannot connect.");
	text($("toggle"), state.enabled ? "Turn off" : "Turn on");
	$("toggle").dataset.enabled = String(state.enabled);
	$("error").hidden = !state.error;
	text($("error"), state.error ?? "");
	$("pairSection").hidden = !state.running;
	$("addressSection").hidden = !state.running;
	if (!state.running) hidePair();

	const addresses = $("addresses");
	addresses.replaceChildren(
		...state.addresses.map((a) => {
			const li = document.createElement("li");
			const code = document.createElement("code");
			text(code, a.url);
			const kind = document.createElement("span");
			kind.className = "small";
			text(kind, `  ${a.kind === "tailscale" ? "Tailscale" : "Local network"} (${a.interface})`);
			li.append(code, kind);
			return li;
		}),
	);
	if (!state.addresses.length) {
		const li = document.createElement("li");
		li.className = "small";
		text(li, "No network address found. Connect to Wi-Fi or Tailscale.");
		addresses.append(li);
	}

	const devices = $("devices");
	devices.replaceChildren(
		...state.devices.map((d) => {
			const li = document.createElement("li");
			li.className = "row";
			const info = document.createElement("div");
			const name = document.createElement("div");
			text(name, d.name);
			const seen = document.createElement("div");
			seen.className = "small";
			text(seen, `Paired ${fmt(d.createdAt)} · last seen ${fmt(d.lastSeenAt)}`);
			info.append(name, seen);
			const remove = document.createElement("button");
			remove.className = "danger";
			text(remove, "Remove");
			remove.addEventListener("click", async () => {
				$("pairResult").hidden = true;
				render(await api.revoke(d.id));
			});
			li.append(info, remove);
			return li;
		}),
	);
	if (!state.devices.length) {
		const li = document.createElement("li");
		li.className = "small";
		text(li, "No phones are paired.");
		devices.append(li);
	}
}

function hidePair() {
	clearInterval(pairTimer);
	pairTimer = null;
	$("pairBox").hidden = true;
	text($("pair"), "Show QR code");
}

async function showPair() {
	$("pairResult").hidden = true;
	const result = await api.pair();
	if (!result || result.error) {
		$("error").hidden = false;
		text($("error"), result?.error ?? "Pairing failed.");
		return;
	}
	// The SVG comes from the qrcode library in the main process (no script content).
	const doc = new DOMParser().parseFromString(result.svg, "image/svg+xml");
	$("qr").replaceChildren(document.importNode(doc.documentElement, true));
	$("pairBox").hidden = false;
	text($("pair"), "New code");
	clearInterval(pairTimer);
	const tick = () => {
		const left = Math.max(0, Math.round((result.expiresAt - Date.now()) / 1000));
		text($("pairDetail"), left > 0
			? `Scan this code with the LearnHarness phone app. It works one time and expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.`
			: "This code has expired. Show a new one.");
		if (left === 0) clearInterval(pairTimer);
	};
	tick();
	pairTimer = setInterval(tick, 1000);
}

$("toggle").addEventListener("click", async () => {
	$("toggle").disabled = true;
	try {
		render(await api.setEnabled($("toggle").dataset.enabled !== "true"));
	} finally {
		$("toggle").disabled = false;
	}
});
$("pair").addEventListener("click", () => void showPair());
$("copyPairing").addEventListener("click", async () => {
	const result = await api.copyPairing();
	if (!result || result.error) {
		$("error").hidden = false;
		text($("error"), result?.error ?? "Copy failed.");
		return;
	}
	text($("copyPairing"), "Copied");
	setTimeout(() => text($("copyPairing"), "Copy pairing text"), 2000);
});
api.onChanged(render);
api.onPairCancelled(() => {
	hidePair();
	$("pairResult").hidden = false;
	text($("pairResult"), "Someone entered too many wrong codes, so the code was cancelled. Show a new QR code.");
});
api.onPaired((device) => {
	hidePair();
	$("pairResult").hidden = false;
	text($("pairResult"), `${device.name} is paired. To pair another phone, show a new QR code.`);
});
api.state().then(render);
