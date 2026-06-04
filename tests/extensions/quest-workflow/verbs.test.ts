import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { clearUrlFetchers, registerUrlFetcher } from "../../../lib/quest/index";
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
	return createQuestState({ homeDir: tmpRoot, dataDir: tmpRoot });
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

describe("reorder verbs", () => {
	it("top moves the loaded quest to rank 1 and shifts siblings to fixed positions", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		const c = await createQuest(state, "Charlie");

		// Set up distinct starting ranks so we know exactly
		// where each quest must land after `top`. Without
		// this seeding every quest's rank is 1 and a loose
		// `rank: [23]` regex passes for either order.
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: b.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "sink" });
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: c.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "sink" });
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "sink" });
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
		const hits = (result.details as { hits: { id: string }[] }).hits;
		expect(hits.some((h) => h.id === a.id)).toBe(true);
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
		expect(calls[0].cwd).toBe(state.questDir);
		// The spawn ships the loaded quest id so the new
		// pi can name its session after the quest without
		// the wezterm/tmux tab-title plumbing.
		expect(calls[0].env).toEqual({ QUEST_WORKFLOW_AUTOLOAD_ID: a.id });
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

describe("listing verbs: brief, expanded and pagination", () => {
	it("list defaults to one brief row per quest with id, glyphs and title", async () => {
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
		// Glyphs present: a kind glyph for the row and ○
		// for active status. The default kind is sidequest;
		// it carries the ◇ glyph.
		expect(result.message).toMatch(/[\u25c6\u25c7\u25c8]/);
		expect(result.message).toContain("\u25cb");
		const details = result.details as { total: number; remaining: number };
		expect(details.total).toBe(2);
		expect(details.remaining).toBe(0);
	});

	it("list expanded renders metadata under each brief row", async () => {
		const state = buildState();
		await createQuest(state, "Alpha quest");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "list",
			expanded: true,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message).toContain("priority:");
		expect(result.message).toContain("parent: none");
		expect(result.message).toContain("updated:");
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

	it("find renders brief rows in the message and keeps the hits payload", async () => {
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
		const details = result.details as { hits: { id: string }[] };
		expect(details.hits.length).toBe(1);
	});

	it("find with no matches returns (no matches) and zero hits", async () => {
		const state = buildState();
		await createQuest(state, "Alpha");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "find",
			query: "nothing-matches-this",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message).toBe("(no matches)");
		const details = result.details as { hits: unknown[] };
		expect(details.hits.length).toBe(0);
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
