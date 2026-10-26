import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CommitHookOptions,
	ensureCommitHook,
	GIT_PROBE_TIMEOUT_MS,
	installCommitHook,
	repoRootOf,
} from "../../../lib/core/attribution/commit-hook.ts";

const OPTIONS: CommitHookOptions = {
	marker: "test-hook",
	chainedSuffix: "test-chained",
	gateTest: "true",
	trailerExpr: '"x"',
};

/** Past the clock by enough to absorb a busy machine, short of the hang. */
const MARGIN_MS = 2500;

/** How long fn took, in milliseconds. */
function timed(fn: () => void): number {
	const started = Date.now();
	fn();
	return Date.now() - started;
}

// The interceptor asks git where a repo keeps its hooks before every
// bash call, synchronously, so a git that never answers (a hung network
// mount, a filesystem that stopped responding) froze pi entirely: no
// render, no key, no Escape. `exec` keeps the fake's sleep in the
// process the clock kills, as a real hung git would be.
describe("a git that never answers the hooks probe", () => {
	let bin: string;
	let dir: string;
	let path: string | undefined;

	beforeEach(() => {
		bin = mkdtempSync(join(tmpdir(), "fake-git-"));
		dir = mkdtempSync(join(tmpdir(), "not-probed-"));
		const git = join(bin, "git");
		writeFileSync(git, "#!/bin/sh\nexec sleep 30\n");
		chmodSync(git, 0o755);
		path = process.env.PATH;
		process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
	});

	afterEach(() => {
		process.env.PATH = path;
		rmSync(bin, { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	});

	it("is given up on at its clock, so the command goes ahead", () => {
		const installed = new Set<string>();
		const took = timed(() => ensureCommitHook(dir, installed, OPTIONS));
		expect(took).toBeLessThan(GIT_PROBE_TIMEOUT_MS + MARGIN_MS);
	}, 40_000);

	it("is not asked again for the same directory this session", () => {
		const installed = new Set<string>();
		ensureCommitHook(dir, installed, OPTIONS);
		const took = timed(() => ensureCommitHook(dir, installed, OPTIONS));
		expect(took).toBeLessThan(500);
	}, 80_000);

	it("says an install was not made because git did not answer", () => {
		let result: unknown;
		const took = timed(() => {
			result = installCommitHook(dir, OPTIONS);
		});
		expect(result).toEqual({
			installed: false,
			reason: "git did not answer",
		});
		expect(took).toBeLessThan(GIT_PROBE_TIMEOUT_MS + MARGIN_MS);
	}, 40_000);

	it("gives no repo root rather than waiting on one", () => {
		let root: string | null = "unset";
		const took = timed(() => {
			root = repoRootOf(dir);
		});
		expect(root).toBeNull();
		expect(took).toBeLessThan(GIT_PROBE_TIMEOUT_MS + MARGIN_MS);
	}, 40_000);
});
