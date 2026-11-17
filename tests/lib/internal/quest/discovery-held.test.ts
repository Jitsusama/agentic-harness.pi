import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearDiscoveryCache,
	discoverQuests,
	withDiscoveryHeld,
} from "../../../../lib/internal/quest/discovery/discovery.ts";
import {
	atomicWriteFile,
	withQuestLock,
} from "../../../../lib/internal/quest/io.ts";

let root: string;

function readme(id: string, title: string): string {
	return [
		"---",
		`id: ${id}`,
		"kind: quest",
		"parent: null",
		"status: active",
		"priority: active",
		"rank: 1",
		"started: 2026-11-14",
		"updated: 2026-11-14",
		"aliases: []",
		"sessions: []",
		"---",
		"",
		`# ${title}`,
		"",
	].join("\n");
}

/** A quest written as another process would, past this one's count. */
function writeElsewhere(id: string, title: string): void {
	mkdirSync(join(root, id), { recursive: true });
	writeFileSync(join(root, id, "README.md"), readme(id, title));
}

function questIds(): string[] {
	return [...discoverQuests(root).index.quests.keys()].sort();
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "disc-held-"));
	clearDiscoveryCache();
	writeElsewhere("QEST-20261114-AAA111", "Alpha");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	clearDiscoveryCache();
});

describe("withDiscoveryHeld", () => {
	it("answers from its first walk while nothing here writes", () => {
		const seen = withDiscoveryHeld(() => {
			const first = questIds();
			writeElsewhere("QEST-20261114-BBB222", "Bravo");
			return { first, second: questIds() };
		});
		expect(seen).toEqual({
			first: ["QEST-20261114-AAA111"],
			second: ["QEST-20261114-AAA111"],
		});
		expect(questIds()).toEqual([
			"QEST-20261114-AAA111",
			"QEST-20261114-BBB222",
		]);
	});

	it("sees this process's own atomic write", () => {
		const second = withDiscoveryHeld(() => {
			questIds();
			const dir = join(root, "QEST-20261114-BBB222");
			mkdirSync(dir);
			atomicWriteFile(
				join(dir, "README.md"),
				readme("QEST-20261114-BBB222", "Bravo"),
			);
			return questIds();
		});
		expect(second).toEqual(["QEST-20261114-AAA111", "QEST-20261114-BBB222"]);
	});

	it("sees what this process wrote under a quest's lock", () => {
		const title = withDiscoveryHeld(() => {
			questIds();
			const dir = join(root, "QEST-20261114-AAA111");
			withQuestLock(dir, () =>
				writeFileSync(
					join(dir, "README.md"),
					readme("QEST-20261114-AAA111", "Alpha, retitled under the lock"),
				),
			);
			return discoverQuests(root).index.quests.get("QEST-20261114-AAA111")?.doc
				.title;
		});
		expect(title).toBe("Alpha, retitled under the lock");
	});

	it("ends when what it ran throws", () => {
		expect(() =>
			withDiscoveryHeld(() => {
				questIds();
				throw new Error("the start failed");
			}),
		).toThrow("the start failed");
		writeElsewhere("QEST-20261114-BBB222", "Bravo");
		expect(questIds()).toEqual([
			"QEST-20261114-AAA111",
			"QEST-20261114-BBB222",
		]);
	});

	it("stays open through a hold inside it", () => {
		const after = withDiscoveryHeld(() => {
			questIds();
			withDiscoveryHeld(() => questIds());
			writeElsewhere("QEST-20261114-BBB222", "Bravo");
			return questIds();
		});
		expect(after).toEqual(["QEST-20261114-AAA111"]);
	});

	it("drops what it walked when the cache is cleared, as a reload does", () => {
		const after = withDiscoveryHeld(() => {
			questIds();
			writeElsewhere("QEST-20261114-BBB222", "Bravo");
			clearDiscoveryCache();
			return questIds();
		});
		expect(after).toEqual(["QEST-20261114-AAA111", "QEST-20261114-BBB222"]);
	});
});
