/**
 * Start the real upstream server (`next dev`) for an integration test
 * (mobile fork, issue 01).
 *
 * Isolation: HOME, LH_DATA_DIR and LH_AUTH_FILE all point into a new
 * temporary folder. Provider keys, tokens and secrets from the parent
 * environment are removed, and LH_IGNORE_ENV_KEYS=1 is set. The user's real
 * data folder is never read or written.
 *
 * `next dev` keeps a lock in `.next/dev`. If another dev server (for example
 * `npm run desktop:dev`) holds it, the child exits at once and `start`
 * rejects with the server's own message.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

export interface DevServer {
	url: string;
	home: string;
	dataDir: string;
	/** The server's stdout + stderr so far. */
	log(): string;
	stop(): Promise<void>;
}

export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address() as net.AddressInfo;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/** The parent env without credentials and without dev or test switches. */
export function isolatedEnv(env: NodeJS.ProcessEnv, home: string): Record<string, string | undefined> {
	const clean = Object.fromEntries(
		Object.entries(env).filter(
			([key]) =>
				!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) &&
				!/^(AWS_|GOOGLE_|GCLOUD_|CLOUDSDK_|AZURE_|ANTHROPIC_|OPENAI_|OPENROUTER_|GEMINI_|CUSTOM_OPENAI_|DEEPGRAM_|LH_|NEXT_|__NEXT)/.test(key) &&
				!["NODE_ENV", "NODE_OPTIONS", "NODE_PATH", "NODE_TEST_CONTEXT", "PORT", "ELECTRON_RUN_AS_NODE"].includes(key),
		),
	);
	return {
		...clean,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(home, "config"),
		XDG_CACHE_HOME: path.join(home, "cache"),
		LH_DATA_DIR: path.join(home, "data"),
		LH_AUTH_FILE: path.join(home, "auth.json"),
		LH_IGNORE_ENV_KEYS: "1",
		NEXT_TELEMETRY_DISABLED: "1",
	};
}

export async function startDevServer(options: { env?: Record<string, string>; headers?: Record<string, string>; bootTimeoutMs?: number } = {}): Promise<DevServer> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-int-"));
	const dataDir = path.join(home, "data");
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(path.join(home, "auth.json"), "{}\n");
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	let output = "";
	const child: ChildProcess = spawn(process.execPath, [NEXT_BIN, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
		cwd: ROOT,
		// next dev sets NODE_ENV itself; the parent test env must not leak in.
		env: { ...isolatedEnv(process.env, home), ...options.env } as unknown as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	child.stdout?.on("data", (b: Buffer) => (output += b.toString()));
	child.stderr?.on("data", (b: Buffer) => (output += b.toString()));
	let exited: number | null | undefined;
	child.on("exit", (code) => (exited = code));

	const stop = async () => {
		if (exited === undefined && child.pid) {
			const done = new Promise((resolve) => child.once("exit", resolve));
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				/* already gone */
			}
			const timer = setTimeout(() => {
				try {
					process.kill(-child.pid!, "SIGKILL");
				} catch {
					/* already gone */
				}
			}, 5000);
			await done;
			clearTimeout(timer);
		}
		// Next's worker processes can still write under HOME after the parent
		// exits. Wait until the whole process group is gone.
		const groupAlive = () => {
			try {
				process.kill(-child.pid!, 0);
				return true;
			} catch {
				return false;
			}
		};
		for (let i = 0; i < 40 && child.pid && groupAlive(); i++) await new Promise((r) => setTimeout(r, 250));
		// Next's telemetry flush runs detached (its own session) at shutdown and
		// creates Library/Preferences under HOME. Remove again if it comes back.
		for (let i = 0; i < 16; i++) {
			if (fs.existsSync(home)) fs.rmSync(home, { recursive: true, force: true });
			await new Promise((r) => setTimeout(r, 250));
		}
	};

	// Ready = a cheap GET route answers 200 (it compiles on first request).
	const deadline = Date.now() + (options.bootTimeoutMs ?? 180_000);
	while (Date.now() < deadline) {
		if (exited !== undefined) {
			await stop();
			throw new Error(`next dev exited (code ${exited}) before it was ready. Is another dev server running (npm run desktop:dev)?\n${output.slice(-4000)}`);
		}
		try {
			const res = await fetch(`${url}/api/settings`, { headers: options.headers, signal: AbortSignal.timeout(60_000) });
			await res.arrayBuffer();
			if (res.status === 200) return { url, home, dataDir, log: () => output, stop };
			if (res.status !== 404 && res.status < 500) {
				await stop();
				throw new Error(`next dev answered ${res.status} on /api/settings. Pass the desktop header if LH_DESKTOP_SERVER is set.\n${output.slice(-4000)}`);
			}
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("next dev answered")) throw err;
			/* not listening yet */
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	await stop();
	throw new Error(`next dev was not ready in time.\n${output.slice(-4000)}`);
}
