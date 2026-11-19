#!/usr/bin/env node
// Mobile fork: a personal desktop build for one Mac (issue 15 of the phone app).
//
// It is `desktop:dist` without the upstream release parts:
//   - the arch of this Mac (os.arch()), not arm64 only;
//   - no signing and no notarization (the upstream team's certificate and
//     notary profile are not ours);
//   - only the .app (`--dir`), no dmg or zip, and no publish;
//   - its own output folder, `dist-personal/`. It never removes or writes
//     `dist/`, because an installed app can run from there.
//
// Result: dist-personal/mac/LearnHarness.app (x64) or
// dist-personal/mac-arm64/LearnHarness.app (arm64).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT = "dist-personal";
const ARCH = os.arch();

if (process.platform !== "darwin") {
	console.error("desktop:personal builds the macOS app. Run it on a Mac.");
	process.exit(1);
}
if (ARCH !== "x64" && ARCH !== "arm64") {
	console.error(`desktop:personal supports x64 and arm64, not ${ARCH}.`);
	process.exit(1);
}

function run(command, args, env = {}) {
	console.log(`\n[desktop-personal] ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: ROOT,
		stdio: "inherit",
		env: { ...process.env, ...env },
	});
	if (result.status !== 0) {
		console.error(`[desktop-personal] failed: ${command} ${args.join(" ")}`);
		process.exit(result.status ?? 1);
	}
}

fs.rmSync(path.join(ROOT, OUTPUT), { recursive: true, force: true });
fs.rmSync(path.join(ROOT, ".next", "standalone"), { recursive: true, force: true });

run("npm", ["run", "build"]);
run("node", ["scripts/smoke-provider-runtime.mjs"]);
run("node", ["scripts/build-server.mjs"]);
run("node", ["scripts/smoke-server.mjs"]);
run(
	"npx",
	[
		"electron-builder",
		"--mac",
		`--${ARCH}`,
		"--dir",
		"--publish",
		"never",
		`-c.directories.output=${OUTPUT}`,
		"-c.mac.identity=null",
		"-c.mac.notarize=false",
	],
	{
		DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
		CSC_IDENTITY_AUTO_DISCOVERY: "false",
	},
);

const appDir = ARCH === "arm64" ? "mac-arm64" : "mac";
console.log(`\n[desktop-personal] done: ${path.join(OUTPUT, appDir, "LearnHarness.app")}`);
