import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../../../lib/internal/quest/discovery";

let root: string;

function writeQuest(id: string, title: string, status = "active"): void {
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true });
	const fm = [
		"---",
		`id: ${id}`,
		"kind: quest",
		"parent: null",
		`status: ${status}`,
		"priority: active",
		"rank: 1",
		"started: 2026-06-04",
		"updated: 2026-06-04",
		"aliases: []",
		"sessions: []",
		"---",
		"",
		`# ${title}`,
		"",
	].join("\n");
	writeFileSync(join(dir, "README.md"), fm);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "disc-cache-"));
	clearDiscoveryCache();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	clearDiscoveryCache();
});

describe("discoverQuests caching", () => {
	it("returns the same result reference while the tree is unchanged", () => {
		writeQuest("QEST-20260604-AAA111", "Alpha");
		const first = discoverQuests(root);
		const second = discoverQuests(root);
		expect(second).toBe(first);
	});

	it("recomputes after a README content change", () => {
		writeQuest("QEST-20260604-AAA111", "Alpha");
		const first = discoverQuests(root);
		expect(first.index.quests.get("QEST-20260604-AAA111")?.doc.title).toBe(
			"Alpha",
		);

		// Re-title the quest; the content length changes too.
		writeQuest("QEST-20260604-AAA111", "Alpha renamed for real");
		const second = discoverQuests(root);
		expect(second).not.toBe(first);
		expect(second.index.quests.get("QEST-20260604-AAA111")?.doc.title).toBe(
			"Alpha renamed for real",
		);
	});

	it("recomputes after a new quest appears", () => {
		writeQuest("QEST-20260604-AAA111", "Alpha");
		const first = discoverQuests(root);
		expect(first.index.quests.size).toBe(1);

		writeQuest("QEST-20260604-BBB222", "Bravo");
		const second = discoverQuests(root);
		expect(second).not.toBe(first);
		expect(second.index.quests.size).toBe(2);
	});

	it("recomputes after a same-byte-size in-place edit", () => {
		// "active" and "paused" are both six characters, so size and a
		// coarse mtime cannot distinguish them; only content can.
		writeQuest("QEST-20260604-AAA111", "Alpha", "active");
		const first = discoverQuests(root);
		expect(
			first.index.quests.get("QEST-20260604-AAA111")?.doc.frontMatter.status,
		).toBe("active");

		writeQuest("QEST-20260604-AAA111", "Alpha", "paused");
		const second = discoverQuests(root);
		expect(second).not.toBe(first);
		expect(
			second.index.quests.get("QEST-20260604-AAA111")?.doc.frontMatter.status,
		).toBe("paused");
	});

	it("recomputes when a layout-drift entry appears at the root", () => {
		writeQuest("QEST-20260604-AAA111", "Alpha");
		const first = discoverQuests(root);
		expect(first.errors).toEqual([]);

		// A stray non-quest directory at the root is a layout error the
		// uncached walk reports; the signature must notice it.
		mkdirSync(join(root, "stray-dir"), { recursive: true });
		const second = discoverQuests(root);
		expect(second).not.toBe(first);
	});

	it("clearDiscoveryCache forces a fresh walk", () => {
		writeQuest("QEST-20260604-AAA111", "Alpha");
		const first = discoverQuests(root);
		clearDiscoveryCache();
		const second = discoverQuests(root);
		expect(second).not.toBe(first);
	});
});
