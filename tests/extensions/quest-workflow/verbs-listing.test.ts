/**
 * The quest verbs that read quests back: list, find, who, links, tree
 * and show, their filters, brief rows, pagination and what show warns of.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handle } from "../../../extensions/quest-workflow/transitions.ts";
import {
	clearPersonResolvers,
	setResolutionFallback,
} from "../../../lib/people/index.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { fakeCtx } from "./_helpers.ts";
import { buildState, createQuest, fixture } from "./support/verbs.ts";

describe("find / who / links", () => {
	it("find returns matches by query and respects since/until filters", async () => {
		const state = buildState();
		const a = await createQuest(state, "Authentication bug");
		await createQuest(state, "Unrelated");

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "find",
			query: "authentication",
		});
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error("unreachable");
		const rows = (result.details as { listing: { rows: { id: string }[] } })
			.listing.rows;
		expect(rows).toContainEqual(expect.objectContaining({ id: a.id }));
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

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "who",
			name: "joel",
		});
		expect(result).toMatchObject({ ok: true });
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

		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: a.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "links",
		});
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error("unreachable");
		const links = (
			result.details as {
				links: {
					incoming: { questId: string }[];
					outgoing: { quests: { id: string }[] };
				};
			}
		).links;
		expect(links.incoming).toContainEqual(
			expect.objectContaining({ questId: b.id }),
		);
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
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: driving.id,
		});
		await handle(state, fakePi(), fakeCtx(fixture.root), { action: "drive" });

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
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
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: sealed.id,
		});
		await handle(state, fakePi(), fakeCtx(fixture.root), { action: "drive" });
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "conclude",
			id: sealed.id,
		});

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
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

		const child = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "create",
			title: "Child",
			parent: parent.id,
			kind: "subquest",
		});
		if (!child.ok) throw new Error(child.guidance);
		const top = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "create",
			title: "Top-level quest",
			kind: "quest",
		});
		if (!top.ok) throw new Error(top.guidance);

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
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
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: loaded.id,
		});

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "show",
			id: other.id,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message).toContain(other.id);
		expect(result.message).toContain("Other quest");
		// The loaded quest is unchanged.
		expect(state.questId).toBe(loaded.id);
		expect(result.details).toMatchObject({ readOnly: true });
	});

	it("refuses an unknown id", async () => {
		const state = buildState();
		await createQuest(state, "Only quest");
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "show",
			id: "QEST-20260604-NOPE00",
		});
		expect(result).toMatchObject({ ok: false });
	});
});

describe("listing verbs: brief, expanded and pagination", () => {
	it("list defaults to one parsable brief row per quest with id, words and title", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha quest");
		await createQuest(state, "Bravo quest");

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
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

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
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

		const page = await handle(state, fakePi(), fakeCtx(fixture.root), {
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

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
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

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
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

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "who",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message).toContain("Joel Gerber (owner)");
		expect(result.message).toContain(a.id);
	});

	it("who skips scaffold placeholder cast subjects", async () => {
		const state = buildState();
		await createQuest(state, "Quest A");

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
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

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
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

		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: target.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
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
		const child = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "create",
			title: "Child quest",
			parent: parent.id,
			kind: "subquest",
		});
		if (!child.ok) throw new Error(child.guidance);

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "tree",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message).toContain("Parent quest");
		expect(result.message).toContain("Child quest");
		const lines = result.message.split("\n");
		const parentLine = lines.find((l) => l.includes("Parent quest"));
		const childLine = lines.find((l) => l.includes("Child quest"));
		expect(parentLine ?? "").not.toMatch(/^ /);
		expect(childLine).toMatch(/^ {2}/);
	});
});

describe("show surfaces unresolved cast per the resolution fallback", () => {
	it("warns about a cast bullet that resolves to no identity", async () => {
		clearPersonResolvers();
		setResolutionFallback("warn");
		const state = buildState();
		const q = await handle(state, fakePi(), fakeCtx(fixture.root), {
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
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id,
		});

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "show",
		});
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error("unreachable");
		expect(result.message).toContain("Unresolved cast");
		expect(result.message).toContain("Nobody Knows");
	});

	it("stays silent about unresolved cast when the fallback is silent", async () => {
		clearPersonResolvers();
		setResolutionFallback("silent");
		const state = buildState();
		const q = await handle(state, fakePi(), fakeCtx(fixture.root), {
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
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id,
		});
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "show",
		});
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error("unreachable");
		expect(result.message).not.toContain("Unresolved cast");
		setResolutionFallback("warn");
	});
});
