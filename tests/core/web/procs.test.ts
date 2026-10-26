import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findProcsByProfile,
	PS_TIMEOUT_MS,
	verifyBrowser,
} from "../../../lib/core/web/procs.ts";

/** Past the clock by enough to absorb a busy machine, short of the hang. */
const MARGIN_MS = 2500;

/** fn's answer and how long it took, in milliseconds. */
function timed<T>(fn: () => T): { answer: T; took: number } {
	const started = Date.now();
	const answer = fn();
	return { answer, took: Date.now() - started };
}

// These run synchronously, one of them from process exit, where a ps
// that never answered left pi unable to quit. A probe that runs out its
// clock answers the safe way: not ours to kill, and not known to be gone.
describe("a ps that never answers", () => {
	let bin: string;
	let path: string | undefined;

	beforeEach(() => {
		bin = mkdtempSync(join(tmpdir(), "fake-ps-"));
		const ps = join(bin, "ps");
		writeFileSync(ps, "#!/bin/sh\nexec sleep 30\n");
		chmodSync(ps, 0o755);
		path = process.env.PATH;
		process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
	});

	afterEach(() => {
		process.env.PATH = path;
		rmSync(bin, { recursive: true, force: true });
	});

	it("is given up on when confirming a browser is ours, which it then is not", () => {
		const { answer, took } = timed(() =>
			verifyBrowser(process.pid, "/nowhere/profile"),
		);
		expect(took).toBeLessThan(PS_TIMEOUT_MS + MARGIN_MS);
		expect(answer).toBe(false);
	}, 40_000);

	it("is given up on when finding a profile's processes, which are then unknown", () => {
		const { answer, took } = timed(() =>
			findProcsByProfile("/nowhere/profile"),
		);
		expect(took).toBeLessThan(PS_TIMEOUT_MS + MARGIN_MS);
		expect(answer).toBeUndefined();
	}, 40_000);
});

describe("a ps that answers", () => {
	it("still confirms nothing for a profile no process names", () => {
		expect(verifyBrowser(process.pid, "/nowhere/profile")).toBe(false);
		expect(findProcsByProfile("/nowhere/profile")).toEqual([]);
	});
});
