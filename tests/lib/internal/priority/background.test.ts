/**
 * The file that says a pi may yield the CPU, which the jobs-sorter reads
 * to give its scope a low weight, and which a key takes away at once.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	backgroundDir,
	backgroundTurns,
	QUIET_MS,
} from "../../../../lib/internal/priority/background.ts";

describe("a pi that may yield the CPU", () => {
	let runtime: string;
	let dir: string;
	let text: string;
	let typed: boolean;
	const file = () => join(dir, "4242");
	const follow = () =>
		backgroundTurns(dir, {
			pid: 4242,
			now: 0,
			editorText: () => text,
			typed: () => typed,
		});

	beforeEach(() => {
		runtime = mkdtempSync(join(tmpdir(), "background-"));
		dir = backgroundDir({ XDG_RUNTIME_DIR: runtime }) ?? "";
		text = "";
		typed = false;
	});
	afterEach(() => rmSync(runtime, { recursive: true, force: true }));

	it("is said once a turn nobody typed has gone a minute without a key", () => {
		expect(dir).toBe(join(runtime, "pi", "background"));
		const turns = follow();
		turns.began(1_000);
		expect(existsSync(file())).toBe(false);
		turns.settle(QUIET_MS);
		expect(existsSync(file())).toBe(true);
	});

	it("goes at the first key, and comes back only after another quiet minute", () => {
		const turns = follow();
		turns.began(QUIET_MS);
		expect(existsSync(file())).toBe(true);
		turns.key(QUIET_MS + 1);
		expect(existsSync(file())).toBe(false);
		turns.settle(QUIET_MS + 2);
		expect(existsSync(file())).toBe(false);
		turns.settle(2 * QUIET_MS + 1);
		expect(existsSync(file())).toBe(true);
	});

	it("is never said for a turn a person typed", () => {
		typed = true;
		const turns = follow();
		turns.began(QUIET_MS);
		turns.settle(2 * QUIET_MS);
		expect(existsSync(file())).toBe(false);
	});

	it("is never said while the editor holds the person's words", () => {
		text = "half a thought";
		const turns = follow();
		turns.began(QUIET_MS);
		expect(existsSync(file())).toBe(false);
		text = "";
		turns.settle(QUIET_MS + 1);
		expect(existsSync(file())).toBe(true);
	});

	it("is never said between turns, and goes when the turn or session ends", () => {
		const turns = follow();
		turns.settle(QUIET_MS);
		expect(existsSync(file())).toBe(false);
		turns.began(QUIET_MS);
		turns.ended();
		expect(existsSync(file())).toBe(false);
		turns.settle(2 * QUIET_MS);
		expect(existsSync(file())).toBe(false);
		turns.began(2 * QUIET_MS);
		turns.stop();
		expect(existsSync(file())).toBe(false);
	});

	it("keeps the full weight when the editor can't be read or there is no runtime folder", () => {
		const turns = backgroundTurns(dir, {
			pid: 4242,
			now: 0,
			editorText: () => {
				throw new Error("gone");
			},
			typed: () => false,
		});
		turns.began(QUIET_MS);
		expect(existsSync(file())).toBe(false);
		expect(backgroundDir({})).toBeUndefined();
		const none = backgroundTurns(undefined, {
			editorText: () => "",
			typed: () => false,
		});
		expect(() => none.began(Date.now() + QUIET_MS)).not.toThrow();
	});
});
