/**
 * Sweeping node's compile cache in the runtime folder: what no process
 * read or wrote for a day goes, what was used stays, and a start within
 * an hour of the last sweep walks nothing.
 */
import {
	existsSync,
	lstatSync,
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	IDLE_COMPILED_MS,
	SWEEP_EVERY_MS,
	sweepIdleCompiled,
} from "../../../../lib/internal/fence/compile-cache-sweep.ts";

const NOW = Date.parse("2026-11-23T08:00:00Z");
const HOUR = 60 * 60 * 1000;

let folder = "";

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "compile-sweep-"));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

/** An entry at `path` last read at `read` and written at `written`. */
function entry(path: string, written: number, read = written): string {
	const at = join(folder, path);
	mkdirSync(join(at, ".."), { recursive: true });
	writeFileSync(at, "compiled");
	utimesSync(at, new Date(read), new Date(written));
	return at;
}

describe("sweeping node's compile cache", () => {
	it("removes what was neither read nor written for a day, and keeps what was", () => {
		const idle = entry("v24-x64-1/a", NOW - 2 * IDLE_COMPILED_MS);
		const written = entry("v24-x64-1/b", NOW - HOUR);
		const read = entry("v24-x64-2/c", NOW - 2 * IDLE_COMPILED_MS, NOW - HOUR);

		const swept = sweepIdleCompiled(folder, NOW);

		expect(swept).toEqual({ walked: true, removed: 1 });
		expect(existsSync(idle), "the idle entry").toBe(false);
		expect(existsSync(written), "the one written lately").toBe(true);
		expect(existsSync(read), "the one read lately").toBe(true);
		expect(existsSync(join(folder, "v24-x64-1")), "node's own folder").toBe(
			true,
		);
	});

	it("walks it at most once an hour, so a storm of starts sweeps once", () => {
		sweepIdleCompiled(folder, NOW);
		const idle = entry("v24-x64-1/a", NOW - 2 * IDLE_COMPILED_MS);

		expect(sweepIdleCompiled(folder, NOW + HOUR / 2)).toEqual({
			walked: false,
			removed: 0,
		});
		expect(existsSync(idle), `${idle} is there`).toBe(true);

		expect(sweepIdleCompiled(folder, NOW + SWEEP_EVERY_MS)).toEqual({
			walked: true,
			removed: 1,
		});
	});

	it("removes an idle link without following it", () => {
		const outside = mkdtempSync(join(tmpdir(), "compile-sweep-out-"));
		try {
			const kept = join(outside, "kept");
			writeFileSync(kept, "not node's");
			utimesSync(
				kept,
				new Date(NOW - 2 * IDLE_COMPILED_MS),
				new Date(NOW - 2 * IDLE_COMPILED_MS),
			);
			const link = join(folder, "link");
			symlinkSync(outside, link);
			const long = new Date(NOW - 2 * IDLE_COMPILED_MS);
			lutimesSync(link, long, long);

			sweepIdleCompiled(folder, NOW);

			expect(() => lstatSync(link), "the idle link").toThrow();
			expect(existsSync(kept), "what the link names").toBe(true);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("does nothing, without throwing, where there is no folder", () => {
		expect(sweepIdleCompiled(join(folder, "none"), NOW)).toEqual({
			walked: false,
			removed: 0,
		});
	});
});
