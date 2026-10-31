/**
 * The file that says a pi is running a turn a person typed, which the
 * traffic shaper reads to send that turn's request first.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	typedDir,
	typedTurns,
} from "../../../../lib/internal/priority/typed.ts";

describe("a turn a person typed", () => {
	let runtime: string;
	let dir: string;
	const file = () => join(dir, "4242");

	beforeEach(() => {
		runtime = mkdtempSync(join(tmpdir(), "typed-"));
		dir = typedDir({ XDG_RUNTIME_DIR: runtime }) ?? "";
	});
	afterEach(() => rmSync(runtime, { recursive: true, force: true }));

	it("is said from the input until the turn it started ends", () => {
		expect(dir).toBe(join(runtime, "pi", "typed"));
		const turns = typedTurns(dir, 4242);
		turns.typed(1);
		expect(existsSync(file())).toBe(true);
		turns.began(2);
		turns.ended();
		expect(existsSync(file())).toBe(false);
	});

	it("is never said for a turn nobody typed", () => {
		const turns = typedTurns(dir, 4242);
		turns.began(1);
		turns.ended();
		expect(existsSync(file())).toBe(false);
	});

	it("stays for the next turn when a person typed during this one", () => {
		const turns = typedTurns(dir, 4242);
		turns.typed(1);
		turns.began(2);
		turns.typed(3);
		turns.ended();
		expect(existsSync(file())).toBe(true);
		turns.began(4);
		turns.ended();
		expect(existsSync(file())).toBe(false);
	});

	it("says whether it holds, even where it can't write the file", () => {
		const turns = typedTurns(undefined, 4242);
		expect(turns.held()).toBe(false);
		turns.typed(1);
		expect(turns.held()).toBe(true);
		turns.began(2);
		turns.ended();
		expect(turns.held()).toBe(false);
	});

	it("goes with the session, and says nothing with no runtime folder", () => {
		const turns = typedTurns(dir, 4242);
		turns.typed(1);
		turns.stop();
		expect(existsSync(file())).toBe(false);
		expect(typedDir({})).toBeUndefined();
		expect(() => typedTurns(undefined).typed()).not.toThrow();
	});
});
