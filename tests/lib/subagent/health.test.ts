import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkSubagentRuntime,
	createSubagentHealthCheck,
	detectStaleInstallInStderr,
	STALE_RUNTIME_WARNING_PREFIX,
} from "../../../lib/subagent/health.ts";

// The pi install is captured once at startup and read again at
// each dispatch. If pi gets updated (or nix-gc'd) mid-session,
// the path the parent process is running from disappears from
// disk and any `pi` subprocess spawned with parent-derived
// extension paths fails. These tests cover the pre-dispatch
// existence check and the post-spawn stderr pattern detector
// that together let the dispatcher surface a clear "restart pi"
// advisory instead of a generic retry suggestion.

const STARTUP_INSTALL_KEY = Symbol.for("pi.subagent.startupPiInstall");

// The install is read at each dispatch, so a reading healed since the
// module loaded, or one gone since, is the one the check judges.
describe("checkSubagentRuntime", () => {
	const store = globalThis as Record<symbol, unknown>;
	const before = store[STARTUP_INSTALL_KEY];
	const previous = process.env.PI_PACKAGE_DIR;
	const folders: string[] = [];
	afterEach(() => {
		store[STARTUP_INSTALL_KEY] = before;
		if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previous;
		for (const folder of folders.splice(0))
			rmSync(folder, { recursive: true, force: true });
	});

	/**
	 * A fresh temp folder, dereferenced as the heal's walk sees it,
	 * removed after the case.
	 */
	function tempFolder(): string {
		const folder = realpathSync(mkdtempSync(join(tmpdir(), "pi-health-")));
		folders.push(folder);
		return folder;
	}

	/**
	 * A package's root only inside `root`, so the heal's walk up from the
	 * entry script can't answer from a package.json above the temp folder.
	 */
	function packagesUnder(root: string) {
		return {
			holdsPackage: (dir: string) =>
				(dir === root || dir.startsWith(root + sep)) &&
				existsSync(join(dir, "package.json")),
		};
	}

	it("names a package folder gone since the module loaded", () => {
		const root = tempFolder();
		const gone = join(root, "gone-link");
		writeFileSync(join(root, "cli.js"), "");
		process.env.PI_PACKAGE_DIR = gone;
		store[STARTUP_INSTALL_KEY] = {
			node: process.execPath,
			entry: join(root, "cli.js"),
			packageDir: gone,
		};
		expect(checkSubagentRuntime(packagesUnder(root))?.path).toBe(gone);
		expect(process.env.PI_PACKAGE_DIR).toBe(gone);
	});

	it("passes once the package is found from the entry script", () => {
		const root = tempFolder();
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "package.json"), "{}");
		writeFileSync(join(root, "dist", "cli.js"), "");
		store[STARTUP_INSTALL_KEY] = {
			node: process.execPath,
			entry: join(root, "dist", "cli.js"),
			packageDir: join(root, "gone-link"),
		};
		expect(checkSubagentRuntime(packagesUnder(root))).toBeNull();
	});
});

describe("createSubagentHealthCheck", () => {
	it("returns null when every install path still exists", () => {
		const check = createSubagentHealthCheck({
			paths: [
				"/nix/store/node-22/bin/node",
				"/nix/store/abc-pi-0.75.5/dist/cli.js",
			],
			exists: () => true,
		});
		expect(check()).toBeNull();
	});

	it("reports the first missing install path", () => {
		const check = createSubagentHealthCheck({
			paths: [
				"/nix/store/node-22/bin/node",
				"/nix/store/abc-pi-0.75.3/dist/cli.js",
			],
			exists: (p) => p === "/nix/store/node-22/bin/node",
		});
		const result = check();
		expect(result).not.toBeNull();
		expect(result?.path).toBe("/nix/store/abc-pi-0.75.3/dist/cli.js");
		expect(result?.message).toMatch(/restart pi/i);
		expect(result?.message).toContain("/nix/store/abc-pi-0.75.3/dist/cli.js");
	});

	it("re-probes while healthy so a mid-session deletion is caught", () => {
		// The whole point of this module is a path that vanishes
		// mid-session. A memo of "healthy" would mask exactly that,
		// so while every path is present the check re-probes, and a
		// later deletion surfaces on the next dispatch.
		let present = true;
		const check = createSubagentHealthCheck({
			paths: ["/nix/store/abc-pi-0.75.5/dist/cli.js"],
			exists: () => present,
		});
		expect(check()).toBeNull();
		expect(check()).toBeNull();
		present = false;
		const result = check();
		expect(result).not.toBeNull();
		expect(result?.message).toMatch(/restart pi/i);
	});

	it("caches a detected failure so it never re-stats a known-dead path", () => {
		// A deleted install cannot come back without a restart, so
		// once the check has seen a missing path it fixes that
		// answer and stops probing.
		let calls = 0;
		const check = createSubagentHealthCheck({
			paths: ["/nix/store/abc-pi-0.75.3/dist/cli.js"],
			exists: () => {
				calls++;
				return false;
			},
		});
		const first = check();
		check();
		check();
		expect(first).not.toBeNull();
		expect(calls).toBe(1);
	});

	it("reports a missing package dir, not just the binary paths", () => {
		// The theme crash is a missing PI_PACKAGE_DIR, which lives
		// alongside the node and entry paths in the probe set.
		const check = createSubagentHealthCheck({
			paths: [
				"/nix/store/node-22/bin/node",
				"/nix/store/abc-pi-0.80.7/dist/cli.js",
				"/home/x/.pi/pkg/pi-0.80.7",
			],
			exists: (p) => p !== "/home/x/.pi/pkg/pi-0.80.7",
		});
		const result = check();
		expect(result?.path).toBe("/home/x/.pi/pkg/pi-0.80.7");
	});
});

describe("detectStaleInstallInStderr", () => {
	it("matches the canonical pi-pkg ENOENT shape and returns an actionable message", () => {
		const stderr = [
			"node:fs:440",
			"    return binding.readFileUtf8(path, stringToFlags(options.flag));",
			"                   ^",
			"",
			"Error: ENOENT: no such file or directory, open '/Users/joel.gerber/.pi/pkg/pi-0.75.3/package.json'",
			"    at readFileSync (node:fs:440:19)",
		].join("\n");

		const message = detectStaleInstallInStderr(stderr);
		expect(message).not.toBeNull();
		expect(message).toMatch(/restart pi/i);
		expect(message).toContain("/Users/joel.gerber/.pi/pkg/pi-0.75.3");
	});

	it("returns null on unrelated ENOENT errors", () => {
		const stderr =
			"Error: ENOENT: no such file or directory, open '/tmp/missing.json'";
		expect(detectStaleInstallInStderr(stderr)).toBeNull();
	});

	it("returns null on empty stderr", () => {
		expect(detectStaleInstallInStderr("")).toBeNull();
	});

	it("uses the warning prefix every downstream consumer can grep on", () => {
		const stderr =
			"Error: ENOENT: no such file or directory, open '/home/x/.pi/pkg/pi-1.2.3/package.json'";
		const message = detectStaleInstallInStderr(stderr);
		expect(message).not.toBeNull();
		expect(
			message?.startsWith(STALE_RUNTIME_WARNING_PREFIX),
			`${message} opens with ${STALE_RUNTIME_WARNING_PREFIX}`,
		).toBe(true);
	});
});
