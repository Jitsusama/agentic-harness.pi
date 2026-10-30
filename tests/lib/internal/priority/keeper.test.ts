import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mayKeep,
	NEWER_KEEPER_MS,
	RESTAMP_MS,
} from "../../../../lib/internal/priority/keeper.ts";

const NOW = Date.parse("2026-10-30T23:10:00Z");
const KEEP_EVERY_MS = 2_000;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "keeper-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function stamped(): unknown {
	return JSON.parse(readFileSync(join(dir, "rules.json"), "utf8"));
}

describe("the rules a keeper keeps by", () => {
	it("are stamped now and then, not at every keep", () => {
		expect(mayKeep(dir, 2, NOW)).toBe(true);
		for (let at = NOW; at < NOW + RESTAMP_MS; at += KEEP_EVERY_MS) {
			expect(mayKeep(dir, 2, at)).toBe(true);
		}
		expect(stamped(), "unchanged while it is fresh").toEqual({
			version: 2,
			at: NOW,
		});

		mayKeep(dir, 2, NOW + RESTAMP_MS);
		expect(stamped()).toEqual({ version: 2, at: NOW + RESTAMP_MS });
	});

	it("are said at once when they change", () => {
		mayKeep(dir, 1, NOW);
		mayKeep(dir, 2, NOW + KEEP_EVERY_MS);
		expect(stamped()).toEqual({ version: 2, at: NOW + KEEP_EVERY_MS });
	});

	it("still hold an older keeper back between a newer one's stamps", () => {
		mayKeep(dir, 2, NOW);
		mayKeep(dir, 2, NOW + RESTAMP_MS - 1);
		expect(mayKeep(dir, 1, NOW + RESTAMP_MS - 1)).toBe(false);
		expect(mayKeep(dir, 1, NOW + NEWER_KEEPER_MS)).toBe(true);
	});
});
