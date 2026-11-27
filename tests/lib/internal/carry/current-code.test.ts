/** Whether a carry waits on its session's reload onto its install's code. */

import { mkdirSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BEHIND_FOR_MS,
	behindItsInstall,
} from "../../../../lib/internal/carry/current-code.ts";
import { folder, removeAll } from "./support/machines.ts";

const made: string[] = [];
afterEach(() => removeAll(made));

const NOW = Date.parse("2026-11-27T10:00:00Z");
const OLD = "03c16f4cfe6b0b8ed5afba531da67409c1d6729c";
const NEXT = "1812efc7c112daf363e4b8a5619d0d2208a3ea29";
const LATEST = "9255f6d13012e75c85e1b7e9dab118755c1d7f94";

/**
 * An install of whole versions, each made the given milliseconds before
 * `NOW`, its `current` link on `current`; answers the install's folder.
 */
function install(versions: Record<string, number>, current: string): string {
	const root = folder(made, "install");
	for (const [version, ago] of Object.entries(versions)) {
		const at = join(root, "versions", version);
		mkdirSync(at, { recursive: true });
		utimesSync(at, (NOW - ago) / 1000, (NOW - ago) / 1000);
	}
	symlinkSync(join("versions", current), join(root, "current"));
	return root;
}

const minutes = (count: number) => count * 60_000;

describe("a carry from code its install has left", () => {
	it("waits on its reload once the install left it past the bar, naming both versions", () => {
		const root = install(
			{
				[OLD]: minutes(3000),
				[NEXT]: BEHIND_FOR_MS + minutes(1),
				[LATEST]: minutes(2),
			},
			LATEST,
		);

		const why = behindItsInstall(join(root, "versions", OLD), NOW);

		expect(why).toBe(
			`it runs harness ${OLD.slice(0, 12)}, which its install left 16 minutes ago for ${LATEST.slice(0, 12)}, so it may lack a carry fix; it reloads once idle, and the carry can be asked again then`,
		);
	});

	it("goes on while the install left it within the bar, since its reload is due", () => {
		const root = install(
			{ [OLD]: minutes(3000), [LATEST]: BEHIND_FOR_MS - minutes(1) },
			LATEST,
		);

		expect(behindItsInstall(join(root, "versions", OLD), NOW)).toBeUndefined();
	});

	it("goes on from the install's own version, however old", () => {
		const root = install({ [OLD]: minutes(3000) }, OLD);

		expect(behindItsInstall(join(root, "versions", OLD), NOW)).toBeUndefined();
	});

	it("goes on from code outside an install of whole versions", () => {
		const tree = folder(made, "tree");

		expect(behindItsInstall(tree, NOW)).toBeUndefined();
	});
});
