import { describe, expect, it } from "vitest";
import {
	createSubagentHealthCheck,
	detectStaleInstallInStderr,
	STALE_RUNTIME_WARNING_PREFIX,
} from "../../../lib/subagent/health";

// The pi binary is captured at module load. If pi gets
// updated (or nix-gc'd) mid-session, the path the parent
// process is running from disappears from disk and any
// `pi` subprocess spawned with parent-derived extension
// paths fails. These tests cover the pre-dispatch
// existence check and the post-spawn stderr pattern
// detector that together let the dispatcher surface a
// clear "restart pi" advisory instead of a generic
// retry suggestion.

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
		expect(message?.startsWith(STALE_RUNTIME_WARNING_PREFIX)).toBe(true);
	});
});
