import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	countRedraws,
	MOST_LOG_BYTES,
	REDRAW_LOG,
	REDRAW_SETTING,
} from "../../../extensions/terminal-modes-widget/redraws.ts";
import type { SessionEnvironment } from "../../../lib/core/session/host.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "redraws-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An environment of its own, as a session's is. */
function environment(given: Record<string, string> = {}): SessionEnvironment {
	const values = new Map(Object.entries(given));
	return {
		get: (name) => values.get(name),
		set: (name, value) => {
			values.set(name, value);
		},
		delete: (name) => {
			values.delete(name);
		},
		snapshot: () => Object.fromEntries(values),
	};
}

// Joel, 11 November: ask dialogs lose their text as a reply streams in.
// Counting which full redraw comes most says what the fix must stop.
describe("pi-tui's log of full redraws", () => {
	it("is turned on as a session starts, unless the person set it", () => {
		const unset = environment();
		countRedraws(unset, dir);
		expect(unset.get(REDRAW_SETTING), "on by default").toBe("1");

		const off = environment({ [REDRAW_SETTING]: "0" });
		countRedraws(off, dir);
		expect(off.get(REDRAW_SETTING), "his own setting stands").toBe("0");
	});

	it("is set aside once past its size, keeping one older copy", () => {
		const log = join(dir, REDRAW_LOG);
		writeFileSync(log, "x".repeat(MOST_LOG_BYTES + 1));
		countRedraws(environment(), dir);
		expect(existsSync(log), "a fresh log starts").toBe(false);
		expect(statSync(`${log}.1`).size, "the old one kept").toBe(
			MOST_LOG_BYTES + 1,
		);

		writeFileSync(log, "short\n");
		countRedraws(environment(), dir);
		expect(readFileSync(log, "utf8"), "a short log is left").toBe("short\n");
	});

	it("starts with no log at all", () => {
		expect(
			() => countRedraws(environment(), dir),
			"nothing to set aside",
		).not.toThrow();
	});
});
