/**
 * Where the quests live as the config says now, read by a sweep outside
 * every host, which mustn't take trees by the wrong quests.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { questsRootNow } from "../../../extensions/quest-workflow/config.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "quest-config-"));
	vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
	vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/** Write `text` where the package's config is read from. */
function config(text: string): void {
	const folder = join(root, "config", "pi", "agentic-harness.pi");
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "config.json"), text);
}

it("reads the quests root the config names", async () => {
	const quests = join(root, "quests");
	config(
		JSON.stringify({
			version: 1,
			sections: { "quest-workflow": { questsRoot: quests } },
		}),
	);

	expect(await questsRootNow(), "where the quests live").toBe(quests);
});

it("throws for a section that won't parse, whose quests root would be dropped with it", async () => {
	config(
		JSON.stringify({
			version: 1,
			sections: {
				"quest-workflow": { questsRoot: join(root, "quests"), spawnHost: 42 },
			},
		}),
	);

	await expect(questsRootNow(), "where the quests live").rejects.toThrow(
		"spawnHost",
	);
});

it("throws for a config that won't load, rather than reading the data folder's", async () => {
	config("{ not json");

	await expect(questsRootNow(), "where the quests live").rejects.toThrow(
		"Could not parse package config",
	);
});
