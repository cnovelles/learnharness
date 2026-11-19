/**
 * A fetch that acts like the phone: it trusts no CA and checks the SPKI pin
 * of the server certificate after the TLS handshake and BEFORE it sends a
 * byte of the request. A server that fails the pin gets no headers, no body
 * and no token.
 */
import tls from "node:tls";
import { createRequire } from "node:module";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciInit } from "undici";

const require = createRequire(import.meta.url);
const { spkiPin } = require("../../electron/phone-access-tls.cjs");

export class PinMismatchError extends Error {
	constructor(readonly expected: string, readonly actual: string | null) {
		super(`certificate pin mismatch: expected ${expected}, got ${actual ?? "no certificate"}`);
		this.name = "PinMismatchError";
	}
}

/** Pin checks done by this fetch: one entry for each new TLS connection. */
export interface PinnedFetch {
	(url: string, init?: RequestInit): Promise<Response>;
	checks: { expected: string; actual: string | null; ok: boolean }[];
	close(): Promise<void>;
}

export function pinnedFetch(pin: string): PinnedFetch {
	const checks: PinnedFetch["checks"] = [];
	const dispatcher = new Agent({
		connect(options, callback) {
			let done = false;
			const finish = (err: Error | null, socket: tls.TLSSocket | null) => {
				if (done) return;
				done = true;
				callback(err, socket as never);
			};
			const socket = tls.connect({
				host: options.hostname,
				port: Number(options.port) || 443,
				// The pin is the trust decision, not a CA or a host name.
				rejectUnauthorized: false,
				ALPNProtocols: ["http/1.1"],
			});
			socket.once("secureConnect", () => {
				const raw = socket.getPeerX509Certificate()?.raw;
				const actual = raw ? spkiPin(raw) : null;
				const ok = actual === pin;
				checks.push({ expected: pin, actual, ok });
				if (ok) return finish(null, socket);
				socket.destroy();
				finish(new PinMismatchError(pin, actual), null);
			});
			socket.once("error", (err) => finish(err, null));
			return socket as never;
		},
	});
	const fn = ((url: string, init?: RequestInit) => undiciFetch(url, { ...(init as UndiciInit), dispatcher }) as unknown as Promise<Response>) as PinnedFetch;
	fn.checks = checks;
	fn.close = () => dispatcher.close();
	return fn;
}
