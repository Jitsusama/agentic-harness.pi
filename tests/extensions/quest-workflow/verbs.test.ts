import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { questIdFromCwd } from "../../../extensions/quest-workflow/verbs/lifecycle";
import {
	clearPersonResolvers,
	setResolutionFallback,
} from "../../../lib/people/index";
import {
	clearUrlFetchers,
	parseQuestFrontMatter,
	registerUrlFetcher,
	serializeQuestFrontMatter,
} from "../../../lib/quest/index";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index";
import {
	clearTerminalDrivers,
	registerTerminalDriver,
} from "../../../lib/terminal/index";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return {
		setSessionName: () => {},
	} as unknown as Parameters<typeof handle>[1];
}

function fakeCtx(cwd: string, sessionId = "sess-1") {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as Parameters<typeof handle>[2];
}

function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

const envGuard = createEnvGuard();

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-verbs-"));
	clearRefTypes();
	registerBuiltinRefTypes();
	clearUrlFetchers();
	clearTerminalDrivers();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	clearRefTypes();
	clearUrlFetchers();
	clearTerminalDrivers();
	envGuard.leave();
});

async function createQuest(
	state: ReturnType<typeof buildState>,
	title: string,
) {
	const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "create",
		title,
	});
	if (!result.ok) throw new Error(result.guidance);
	return result.details as { id: string; path: string };
}

describe("questIdFromCwd", () => {
	function addTree(readmePath: string, treePath: string): void {
		const text = readFileSync(readmePath, "utf8");
		const block = `\ntrees:\n  - path: ${treePath}\n    providerId: dev-tree\n    repoRoot: ${treePath}\n    origin: scaffolded\n---\n`;
		writeFileSync(readmePath, text.replace(/\n---\n/, block));
	}

	it("prefers a live quest over a sealed one sharing a tree path", async () => {
		const state = buildState();
		const treePath = join(tmpRoot, "shared-tree");
		mkdirSync(treePath, { recursive: true });
		// Sealed quest created first, so without a status preference its
		// tree would win the tie by iteration order.
		const sealed = await createQuest(state, "Sealed");
		const live = await createQuest(state, "Live");
		addTree(sealed.path, treePath);
		addTree(live.path, treePath);
		const withSeal = readFileSync(sealed.path, "utf8").replace(
			/^status: active$/m,
			"status: concluded",
		);
		writeFileSync(sealed.path, withSeal);

		expect(questIdFromCwd(state, treePath)).toBe(live.id);
	});
});

describe("reorder verbs", () => {
	it("top moves the loaded quest to rank 1 and shifts siblings to fixed positions", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		const c = await createQuest(state, "Charlie");

		// Seed deterministic positions with explicit
		// before/after actions rather than sink. Every quest
		// starts at rank 1, so a sink-only seed relies on the
		// rank tiebreaker (alphabetical id sort), and ids
		// carry random 6-char suffixes that don't honour the
		// Alpha/Bravo/Charlie creation order. The explicit
		// placements below make the seed order independent
		// of the id suffixes.
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: b.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "after",
			target: a.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: c.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "after",
			target: b.id,
		});
		// Now ranks are: Alpha=1, Bravo=2, Charlie=3.

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "top",
		});
		expect(result.ok).toBe(true);

		// After `top` on Charlie: Charlie=1, Alpha=2,
		// Bravo=3. Each rank is asserted exactly.
		const cText = readFileSync(c.path, "utf8");
		expect(cText).toMatch(/^rank: 1$/m);
		const aText = readFileSync(a.path, "utf8");
		expect(aText).toMatch(/^rank: 2$/m);
		const bText = readFileSync(b.path, "utf8");
		expect(bText).toMatch(/^rank: 3$/m);
	});

	it("excludes a sealed same-bucket quest from the reorder", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		const c = await createQuest(state, "Charlie");
		// Simulate legacy drift: seal Bravo but leave it in the live
		// bucket, the exact shape the status cascade now prevents.
		const sealed = readFileSync(b.path, "utf8").replace(
			/^status: active$/m,
			"status: concluded",
		);
		writeFileSync(b.path, sealed);
		const bRankBefore = readFileSync(b.path, "utf8").match(
			/^rank: (\d+)/m,
		)?.[1];

		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: c.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "top" });

		const bRankAfter = readFileSync(b.path, "utf8").match(/^rank: (\d+)/m)?.[1];
		expect(bRankAfter).toBe(bRankBefore);
		// Charlie took rank 1 and Alpha followed; Bravo stayed put.
		expect(readFileSync(c.path, "utf8")).toMatch(/^rank: 1$/m);
		expect(readFileSync(a.path, "utf8")).toMatch(/^rank: 2$/m);
	});

	it("before/after needs a target", async () => {
		const state = buildState();
		await createQuest(state, "Alpha");
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "before",
		});
		expect(result.ok).toBe(false);
	});
});

describe("alias verbs", () => {
	it("adds and removes an alias", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		const add = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "alias-add",
			ref: "github-pr:shop/world#47281",
		});
		expect(add.ok).toBe(true);
		const text = readFileSync(a.path, "utf8");
		expect(text).toContain("type: github-pr");
		expect(text).toContain("value: shop/world#47281");

		const remove = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "alias-remove",
			ref: "github-pr:shop/world#47281",
		});
		expect(remove.ok).toBe(true);
		const after = readFileSync(a.path, "utf8");
		// Frontmatter `aliases` list should be empty; Journey
		// log keeps the historical mention.
		expect(after).toMatch(/aliases: \[\s*\]/);
	});

	it("refuses an unrecognised input", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "alias-add",
			ref: "not a valid alias",
		});
		expect(result.ok).toBe(false);
	});
});

describe("session verbs", () => {
	it("attaches the current session and then detaches it", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		const attach = await handle(state, fakePi(), fakeCtx(tmpRoot, "sess-99"), {
			action: "session-attach",
			name: "investigation",
		});
		expect(attach.ok).toBe(true);
		let text = readFileSync(a.path, "utf8");
		expect(text).toContain("id: sess-99");
		expect(text).toContain("name: investigation");
		expect(text).toContain("status: active");

		const detach = await handle(state, fakePi(), fakeCtx(tmpRoot, "sess-99"), {
			action: "session-detach",
		});
		expect(detach.ok).toBe(true);
		text = readFileSync(a.path, "utf8");
		expect(text).toMatch(/status: detached/);
	});
});

describe("find / who / links", () => {
	it("find returns matches by query and respects since/until filters", async () => {
		const state = buildState();
		const a = await createQuest(state, "Authentication bug");
		await createQuest(state, "Unrelated");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "find",
			query: "authentication",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		const rows = (result.details as { listing: { rows: { id: string }[] } })
			.listing.rows;
		expect(rows.some((r) => r.id === a.id)).toBe(true);
	});

	it("who filters Cast bullets across quests", async () => {
		const state = buildState();
		const a = await createQuest(state, "Quest A");
		// Inject a Cast bullet.
		const aPath = (a as { path: string }).path;
		const text = readFileSync(aPath, "utf8").replace(
			"- **owner**: _name or @handle_",
			"- **owner**: Joel Gerber. Coordinates the campaign.",
		);
		writeFileSync(aPath, text, "utf8");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "who",
			name: "joel",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		const hits = (result.details as { hits: { subject: string }[] }).hits;
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].subject.toLowerCase()).toContain("joel");
	});

	it("links projects outgoing and incoming references", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		// Inject a mention of A's id into B's body.
		const bText = readFileSync(b.path, "utf8").replace(
			"## 🌄 Journey",
			`## 🌄 Journey\n\n- **2026-06-03**: Mentions ${a.id}.\n\n## (oldjourney)`,
		);
		writeFileSync(b.path, bText, "utf8");

		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "links",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		const links = (
			result.details as {
				links: {
					incoming: { questId: string }[];
					outgoing: { quests: { id: string }[] };
				};
			}
		).links;
		expect(links.incoming.some((e) => e.questId === b.id)).toBe(true);
	});
});

describe("spawn verbs", () => {
	it("dispatches the request through the registered terminal driver", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});

		const calls: {
			layout: string;
			cwd?: string;
			command: string;
			env?: Readonly<Record<string, string>>;
		}[] = [];
		registerTerminalDriver({
			id: "test",
			available: () => true,
			async spawn(req) {
				calls.push({
					layout: req.layout,
					cwd: req.cwd,
					command: req.command,
					env: req.env,
				});
			},
		});

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "spawn-tab",
		});
		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].layout).toBe("tab");
		expect(calls[0].command).toBe("pi");
		// With no tree registered, spawn lands in the live session's
		// cwd (the running test process, so its identity probes as
		// live), ahead of the quest dir in the resolution order.
		expect(calls[0].cwd).toBe(tmpRoot);
		// The spawn ships the loaded quest id so the new
		// pi can name its session after the quest without
		// the wezterm/tmux tab-title plumbing.
		expect(calls[0].env).toEqual({ QUEST_WORKFLOW_AUTOLOAD_ID: a.id });
	});

	it("prefers a registered tree path over the quest dir", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});

		// Register a real tree directory in the quest frontmatter.
		const treeDir = join(tmpRoot, "work-tree");
		mkdirSync(treeDir, { recursive: true });
		const readmePath = join(state.questDir as string, "README.md");
		const parsed = parseQuestFrontMatter(readFileSync(readmePath, "utf8"));
		if (!parsed) throw new Error("could not parse quest frontmatter");
		parsed.frontMatter.trees = [{ path: treeDir, providerId: "git-worktree" }];
		writeFileSync(
			readmePath,
			`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
		);

		const calls: { cwd?: string }[] = [];
		registerTerminalDriver({
			id: "test",
			available: () => true,
			async spawn(req) {
				calls.push({ cwd: req.cwd });
			},
		});

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "spawn-tab",
		});
		expect(result.ok).toBe(true);
		expect(calls[0].cwd).toBe(treeDir);
		if (!result.ok) throw new Error("expected ok");
		expect((result.details as { cwdSource?: string }).cwdSource).toBe("tree");
	});

	it("spawn-tab id:OTHER targets the other quest without mutating loaded state", async () => {
		const state = buildState();
		const loaded = await createQuest(state, "Loaded");
		const other = await createQuest(state, "Other");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: loaded.id,
		});

		const calls: {
			cwd?: string;
			env?: Readonly<Record<string, string>>;
		}[] = [];
		registerTerminalDriver({
			id: "test",
			available: () => true,
			async spawn(req) {
				calls.push({ cwd: req.cwd, env: req.env });
			},
		});

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "spawn-tab",
			id: other.id,
		});
		expect(result.ok).toBe(true);
		expect(calls[0].env).toEqual({ QUEST_WORKFLOW_AUTOLOAD_ID: other.id });
		expect(calls[0].cwd).not.toBe(state.questDir);
		expect(calls[0].cwd).toContain(other.id);
		// The caller's loaded state must not have changed.
		expect(state.questId).toBe(loaded.id);
	});

	it("spawn-tab refuses with a clean message when the id is unknown", async () => {
		const state = buildState();
		await createQuest(state, "Loaded");
		registerTerminalDriver({
			id: "test",
			available: () => true,
			async spawn() {
				/* not reached */
			},
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "spawn-tab",
			id: "QEST-29991231-MISSING",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unexpected ok");
		expect(result.guidance).toContain("No quest with id");
	});
});

describe("URL-seeded create", () => {
	it("dedups against an existing quest with the same alias", async () => {
		const state = buildState();
		// First quest: add the alias.
		const a = await createQuest(state, "Quest with alias");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "alias-add",
			ref: "github-pr:shop/world#47281",
		});

		// Try to create another from the URL form (the
		// github-pr ref type knows how to parse the URL).
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			url: "https://github.com/shop/world/pull/47281",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.guidance).toContain(a.id);
		}
	});

	it("seeds title and originator from a registered fetcher", async () => {
		const state = buildState();
		registerUrlFetcher({
			type: "github-pr",
			async fetch() {
				return {
					title: "Seeded title",
					excerpt: "Body content",
					originator: { type: "github", value: "octocat" },
				};
			},
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			url: "https://github.com/shop/world/pull/99999",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		const path = (result.details as { path: string }).path;
		const text = readFileSync(path, "utf8");
		expect(text).toContain("# Seeded title");
		expect(text).toContain("Body content");
		expect(text).toContain("@octocat");
	});

	it("refuses with guidance when neither URL hint nor title is given", async () => {
		const state = buildState();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			url: "https://github.com/shop/world/pull/77777",
		});
		// No fetcher registered, no title param: refuse.
		expect(result.ok).toBe(false);
	});
});

describe("action aliases and refusals", () => {
	it("status is a synonym for show on a loaded quest", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha quest");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "status",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message).toContain(a.id);
	});

	it("refuses unknown actions with a Levenshtein suggestion", async () => {
		const state = buildState();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "lst",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unexpected ok");
		expect(result.guidance).toContain('Did you mean "list"');
	});
});

describe("create rank assignment", () => {
	function rankOf(path: string): number {
		const parsed = parseQuestFrontMatter(readFileSync(path, "utf8"));
		if (!parsed) throw new Error("unreadable quest frontmatter");
		return parsed.frontMatter.rank;
	}

	it("gives quests in the same group distinct, increasing ranks", async () => {
		const state = buildState();
		const first = await createQuest(state, "First top-level");
		const second = await createQuest(state, "Second top-level");
		const third = await createQuest(state, "Third top-level");

		const ranks = [rankOf(first.path), rankOf(second.path), rankOf(third.path)];
		expect(new Set(ranks).size).toBe(3);
		expect(ranks[0]).toBeLessThan(ranks[1]);
		expect(ranks[1]).toBeLessThan(ranks[2]);
	});
});

describe("list filters", () => {
	it("list priority:driving returns only driving quests and the count matches", async () => {
		const state = buildState();
		const driving = await createQuest(state, "Driving quest");
		await createQuest(state, "Active quest");
		await createQuest(state, "Queued quest");

		// Move the first one to driving so we have a known
		// distribution: 1 driving, 2 active (the default).
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: driving.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "drive" });

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "list",
			priority: "driving",
		});
		if (!result.ok) throw new Error(result.guidance);
		const details = result.details as {
			listing: { rows: { id: string; priority: string }[] };
			total: number;
		};
		expect(details.total).toBe(1);
		expect(details.listing.rows.length).toBe(1);
		expect(details.listing.rows[0].id).toBe(driving.id);
		expect(details.listing.rows[0].priority).toBe("driving");
	});

	it("sorts a sealed quest after a live one even when it outranks by priority", async () => {
		const state = buildState();
		const live = await createQuest(state, "Live active quest");
		const sealed = await createQuest(state, "Sealed driving quest");

		// Drive then conclude the second quest: it keeps its driving
		// priority while sealed, the exact drift the sort must ignore.
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: sealed.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "drive" });
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "conclude",
			id: sealed.id,
		});

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "list",
		});
		if (!result.ok) throw new Error(result.guidance);
		const ids = (
			result.details as { listing: { rows: { id: string }[] } }
		).listing.rows.map((r) => r.id);
		expect(ids.indexOf(live.id)).toBeLessThan(ids.indexOf(sealed.id));
	});

	it("list kind:quest excludes sidequests and subquests", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");

		const child = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Child",
			parent: parent.id,
			kind: "subquest",
		});
		if (!child.ok) throw new Error(child.guidance);
		const top = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Top-level quest",
			kind: "quest",
		});
		if (!top.ok) throw new Error(top.guidance);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "list",
			kind: "quest",
		});
		if (!result.ok) throw new Error(result.guidance);
		const details = result.details as {
			listing: { rows: { id: string; kind: string }[] };
			total: number;
		};
		for (const r of details.listing.rows) expect(r.kind).toBe("quest");
		expect(details.total).toBe(details.listing.rows.length);
	});
});

describe("show by id", () => {
	it("projects another quest read-only without changing the loaded quest", async () => {
		const state = buildState();
		const loaded = await createQuest(state, "Loaded quest");
		const other = await createQuest(state, "Other quest");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: loaded.id,
		});

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "show",
			id: other.id,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message).toContain(other.id);
		expect(result.message).toContain("Other quest");
		// The loaded quest is unchanged.
		expect(state.questId).toBe(loaded.id);
		expect((result.details as { readOnly?: boolean }).readOnly).toBe(true);
	});

	it("refuses an unknown id", async () => {
		const state = buildState();
		await createQuest(state, "Only quest");
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "show",
			id: "QEST-20260604-NOPE00",
		});
		expect(result.ok).toBe(false);
	});
});

describe("listing verbs: brief, expanded and pagination", () => {
	it("list defaults to one parsable brief row per quest with id, words and title", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha quest");
		await createQuest(state, "Bravo quest");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "list",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message).toContain(a.id);
		expect(result.message).toContain("Alpha quest");
		expect(result.message).toContain("Bravo quest");
		// R1: the brief text the agent reads carries parsable
		// words, not glyphs. The default kind is sidequest.
		expect(result.message).toContain("kind=sidequest");
		expect(result.message).toContain("status=active");
		expect(result.message).not.toMatch(/[\u25c6\u25c7\u25c8]/);
		const details = result.details as { total: number; remaining: number };
		expect(details.total).toBe(2);
		expect(details.remaining).toBe(0);
	});

	it("list attaches expansion rows for the renderResult to draw on Ctrl-O", async () => {
		const state = buildState();
		await createQuest(state, "Alpha quest");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "list",
		});
		if (!result.ok) throw new Error(result.guidance);
		// Brief content stays as one line per row: no priority
		// or updated metadata leaks into what the model reads.
		expect(result.message).not.toContain("priority:");
		expect(result.message).not.toContain("parent:");
		// The structured listing payload carries the rich
		// fields the result renderer reformats on Ctrl-O.
		const details = result.details as {
			listing: {
				rows: Array<{
					id: string;
					title: string | null;
					priority: string;
					parent: string | null;
					updated: string;
				}>;
			};
		};
		expect(details.listing.rows.length).toBe(1);
		expect(details.listing.rows[0].title).toBe("Alpha quest");
		expect(details.listing.rows[0].priority).toBe("active");
		expect(details.listing.rows[0].parent).toBeNull();
		expect(details.listing.rows[0].updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("list with limit and offset slices the brief view and surfaces a tail", async () => {
		const state = buildState();
		for (let i = 0; i < 5; i++) {
			await createQuest(state, `Quest ${i}`);
		}

		const page = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "list",
			limit: 2,
			offset: 1,
		});
		if (!page.ok) throw new Error(page.guidance);
		const details = page.details as {
			total: number;
			offset: number;
			limit: number;
			remaining: number;
		};
		expect(details.total).toBe(5);
		expect(details.offset).toBe(1);
		expect(details.limit).toBe(2);
		expect(details.remaining).toBe(2);
		expect(page.message).toContain("and 2 more (offset 3 to continue)");
	});

	it("find renders brief rows in the message and attaches a listing payload", async () => {
		const state = buildState();
		const a = await createQuest(state, "Authentication bug");
		await createQuest(state, "Unrelated quest");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "find",
			query: "authentication",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message).toContain(a.id);
		expect(result.message).toContain("Authentication bug");
		expect(result.message).not.toContain("Unrelated quest");
		const details = result.details as {
			listing: { rows: { id: string; title: string | null }[] };
		};
		expect(details.listing.rows.length).toBe(1);
		expect(details.listing.rows[0].id).toBe(a.id);
	});

	it("find with no matches returns (no matches) and an empty listing", async () => {
		const state = buildState();
		await createQuest(state, "Alpha");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "find",
			query: "nothing-matches-this",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message).toBe("(no matches)");
		const details = result.details as { listing: { rows: unknown[] } };
		expect(details.listing.rows.length).toBe(0);
	});

	it("who renders one row per Cast bullet across quests", async () => {
		const state = buildState();
		const a = await createQuest(state, "Quest A");
		const aPath = (a as { path: string }).path;
		const text = readFileSync(aPath, "utf8").replace(
			"- **owner**: _name or @handle_",
			"- **owner**: Joel Gerber. Coordinates the campaign.",
		);
		writeFileSync(aPath, text, "utf8");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "who",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message).toContain("Joel Gerber (owner)");
		expect(result.message).toContain(a.id);
	});

	it("who skips scaffold placeholder cast subjects", async () => {
		const state = buildState();
		await createQuest(state, "Quest A");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "who",
		});
		if (!result.ok) throw new Error(result.guidance);
		// A fresh quest's scaffold leaves the cast bullet at
		// `_name or @handle_`. `who` should not list that as a
		// real bullet; an unfiltered call against a tree of
		// only fresh quests reports no cast bullets.
		expect(result.message).toContain("(no cast bullets");
	});

	it("who returns (no cast bullets) when the filter matches nothing", async () => {
		const state = buildState();
		await createQuest(state, "Quest A");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "who",
			name: "absolutely-nobody-with-this-name",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message).toContain("(no cast bullets");
	});

	it("show splits inbound echoes into Produced by and Referenced by", async () => {
		const state = buildState();
		const target = await createQuest(state, "Target quest");
		const producer = await createQuest(state, "Producer quest");
		const referrer = await createQuest(state, "Referrer quest");

		// Producer's body mentions the target with the → sigil.
		const pPath = (producer as { path: string }).path;
		const pText = readFileSync(pPath, "utf8").replace(
			"## 🌄 Journey",
			`## 🌄 Journey\n\n- **2026-06-03**: Synthesized findings → ${target.id}.\n\n## (oldjourney)`,
		);
		writeFileSync(pPath, pText, "utf8");

		// Referrer's body mentions the target without the sigil.
		const rPath = (referrer as { path: string }).path;
		const rText = readFileSync(rPath, "utf8").replace(
			"## 🌄 Journey",
			`## 🌄 Journey\n\n- **2026-06-03**: Cross-link to ${target.id}.\n\n## (oldjourney)`,
		);
		writeFileSync(rPath, rText, "utf8");

		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: target.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "show",
		});
		if (!result.ok) throw new Error(result.guidance);

		expect(result.message).toContain("Produced by");
		expect(result.message).toContain("Referenced by");
		const producedSection = result.message
			.split("Referenced by")[0]
			.split("Produced by")[1];
		const referencedSection = result.message.split("Referenced by")[1];
		expect(producedSection).toContain(producer.id);
		expect(producedSection).not.toContain(referrer.id);
		expect(referencedSection).toContain(referrer.id);
		expect(referencedSection).not.toContain(producer.id);
	});

	it("tree renders an indented brief listing across the forest", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent quest");
		const child = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Child quest",
			parent: parent.id,
			kind: "subquest",
		});
		if (!child.ok) throw new Error(child.guidance);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message).toContain("Parent quest");
		expect(result.message).toContain("Child quest");
		const lines = result.message.split("\n");
		const parentLine = lines.find((l) => l.includes("Parent quest"));
		const childLine = lines.find((l) => l.includes("Child quest"));
		expect(parentLine?.startsWith(" ")).toBeFalsy();
		expect(childLine?.startsWith("  ")).toBe(true);
	});
});

describe("create validation", () => {
	it("refuses an out-of-vocabulary priority instead of minting an invisible quest", async () => {
		const state = buildState();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Bad Priority",
			priority: "high",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.guidance).toMatch(/priority/i);
	});

	it("refuses a parent that does not exist", async () => {
		const state = buildState();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Orphan",
			parent: "QEST-20260101-NOEXST",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.guidance).toMatch(/parent/i);
	});

	it("accepts a valid priority and an existing parent", async () => {
		const state = buildState();
		const parent = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Real Parent",
		});
		if (!parent.ok) throw new Error(parent.guidance);
		const parentId = (parent.details as { id: string }).id;
		const child = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Real Child",
			kind: "subquest",
			parent: parentId,
			priority: "queued",
		});
		expect(child.ok).toBe(true);
	});
});

describe("show surfaces unresolved cast per the resolution fallback", () => {
	it("warns about a cast bullet that resolves to no identity", async () => {
		clearPersonResolvers();
		setResolutionFallback("warn");
		const state = buildState();
		const q = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Cast Quest",
		});
		if (!q.ok) throw new Error(q.guidance);
		const { id, path } = q.details as { id: string; path: string };
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace(
				"- **owner**: _name or @handle_",
				"- **owner**: Nobody Knows. Runs the show.",
			),
			"utf8",
		);
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "load", id });

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "show",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.message).toContain("Unresolved cast");
		expect(result.message).toContain("Nobody Knows");
	});

	it("stays silent about unresolved cast when the fallback is silent", async () => {
		clearPersonResolvers();
		setResolutionFallback("silent");
		const state = buildState();
		const q = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Silent Cast",
		});
		if (!q.ok) throw new Error(q.guidance);
		const { id, path } = q.details as { id: string; path: string };
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace(
				"- **owner**: _name or @handle_",
				"- **owner**: Nobody Knows. Runs the show.",
			),
			"utf8",
		);
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "load", id });
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "show",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.message).not.toContain("Unresolved cast");
		setResolutionFallback("warn");
	});
});
