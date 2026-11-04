import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type {
	Place,
	PlaceKind,
} from "../../../../lib/internal/links/places.ts";
import {
	originRepoOf,
	type PlaceWorld,
	targetOf,
} from "../../../../lib/internal/links/targets.ts";

const place = (kind: PlaceKind, text: string): Place => ({
	kind,
	text,
	start: 0,
	end: text.length,
});

let home: string;
let world: PlaceWorld;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "links-home-"));
	const questsRoot = join(home, "quests");
	mkdirSync(join(questsRoot, "QEST-20261104-YJJEPK", "plans"), {
		recursive: true,
	});
	writeFileSync(join(questsRoot, "QEST-20261104-YJJEPK", "README.md"), "#");
	writeFileSync(
		join(
			questsRoot,
			"QEST-20261104-YJJEPK",
			"plans",
			"PLAN-20261104-SQBRTB.md",
		),
		"#",
	);
	mkdirSync(join(questsRoot, "QEST-20261001-AAAAAA"));
	writeFileSync(join(home, "notes.md"), "#");
	world = {
		home,
		questsRoot,
		originRepo: () => ({ owner: "Jitsusama", repo: "agentic-harness.pi" }),
	};
});

describe("where a place opens", () => {
	it("opens a URL as it is", () => {
		expect(targetOf(place("url", "https://a.io/b?c=1#d"), world)).toBe(
			"https://a.io/b?c=1#d",
		);
	});

	it("opens a path that exists as a file URL, from home or absolute", () => {
		const file = pathToFileURL(join(home, "notes.md")).href;
		expect(targetOf(place("path", "~/notes.md"), world)).toBe(file);
		expect(targetOf(place("path", join(home, "notes.md")), world)).toBe(file);
	});

	it("drops a line and column from a path", () => {
		expect(targetOf(place("path", `${home}/notes.md:12:3`), world)).toBe(
			pathToFileURL(join(home, "notes.md")).href,
		);
	});

	it("opens no path that is not there", () => {
		expect(targetOf(place("path", "~/gone.md"), world)).toBeUndefined();
	});

	it("opens owner/repo#N on GitHub", () => {
		expect(targetOf(place("github-ref", "shop/world#47281"), world)).toBe(
			"https://github.com/shop/world/issues/47281",
		);
	});

	it("opens a bare #N in the session's GitHub repo, and not without one", () => {
		expect(targetOf(place("issue-number", "#959"), world)).toBe(
			"https://github.com/Jitsusama/agentic-harness.pi/issues/959",
		);
		const nowhere = { ...world, originRepo: () => undefined };
		expect(targetOf(place("issue-number", "#959"), nowhere)).toBeUndefined();
	});

	it("opens a quest's README and a document's file, and no id it can't find", () => {
		const quest = join(world.questsRoot, "QEST-20261104-YJJEPK");
		expect(targetOf(place("quest-id", "QEST-20261104-YJJEPK"), world)).toBe(
			pathToFileURL(join(quest, "README.md")).href,
		);
		expect(targetOf(place("quest-id", "PLAN-20261104-SQBRTB"), world)).toBe(
			pathToFileURL(join(quest, "plans", "PLAN-20261104-SQBRTB.md")).href,
		);
		expect(
			targetOf(place("quest-id", "RSCH-20261104-SQBRTB"), world),
		).toBeUndefined();
		expect(
			targetOf(place("quest-id", "QEST-20261231-ZZZZZZ"), world),
		).toBeUndefined();
	});
});

describe("the session's repo", () => {
	it("is its origin's owner and name when origin is GitHub", () => {
		const repo = join(home, "repo");
		mkdirSync(repo);
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync(
			"git",
			["remote", "add", "origin", "git@github.com:Jitsusama/x.y.git"],
			{ cwd: repo },
		);
		expect(originRepoOf(repo)).toEqual({ owner: "Jitsusama", repo: "x.y" });
	});

	it("is nothing elsewhere", () => {
		expect(originRepoOf(home)).toBeUndefined();
	});
});
