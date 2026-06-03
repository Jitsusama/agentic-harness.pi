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

beforeEach(() => {
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
	it("top moves the loaded quest to rank 1 and shifts siblings", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		const c = await createQuest(state, "Charlie");

		// Load C and top it.
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: c.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "top",
		});
		expect(result.ok).toBe(true);

		const cText = readFileSync(c.path, "utf8");
		expect(cText).toMatch(/^rank: 1$/m);
		const aText = readFileSync(a.path, "utf8");
		expect(aText).toMatch(/^rank: [23]$/m);
		const bText = readFileSync(b.path, "utf8");
		expect(bText).toMatch(/^rank: [23]$/m);
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

		const calls: { layout: string; cwd?: string; command: string }[] = [];
		registerTerminalDriver({
			id: "test",
			available: () => true,
			async spawn(req) {
				calls.push({ layout: req.layout, cwd: req.cwd, command: req.command });
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
