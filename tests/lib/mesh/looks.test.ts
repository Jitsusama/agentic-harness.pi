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
import {
	answerLook,
	expireLooks,
	type LookState,
	leaveSeenLooks,
	looksIn,
	MOST_CHOICES,
	pointAt,
	refusalOf,
	resolveLooks,
	resolveLooksOfQuests,
	SHOWING_LASTS_MS,
	withdrawLook,
} from "../../../lib/mesh/looks.ts";
import { questEnded } from "../../../lib/mesh/presence.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "looks-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pr = {
	kind: "pr" as const,
	target: "https://github.com/Jitsusama/agentic-harness.pi/pull/1070",
	title: "Quest carry",
	why: "It moves a quest's sessions between machines; worth a read before you use it.",
	ask: "Nothing, just to see.",
};
const who = { session: "S1", address: "85PKB2", quest: "QEST-1" };

/** The launcher marking look `id` as the person left it. */
function mark(id: string, state: LookState): void {
	const file = join(dir, `${id}.json`);
	const look: Record<string, unknown> = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...look, state }));
}

// Joel, 8 November: "make sure they don't time out and don't get
// confused with other things".
describe("the person's look list", () => {
	it("keeps each look whole, with whose it is, what and why, newest first", () => {
		pointAt(dir, pr, who, new Date("2026-11-08T09:00:00Z"));
		const file = {
			kind: "file" as const,
			target: "/home/joel/src/core.nix/modules/pi/chime.nix",
			title: "The chime",
			why: "The ding you asked for; its pitch is set here.",
			ask: "Say whether it should be lower: keep it or drop it a tone.",
		};
		pointAt(dir, file, who, new Date("2026-11-08T09:05:00Z"));

		expect(looksIn(dir).map((look) => look.title)).toEqual([
			"The chime",
			"Quest carry",
		]);
		expect(looksIn(dir)[1]).toMatchObject({
			v: 1,
			session: "S1",
			address: "85PKB2",
			quest: "QEST-1",
			kind: "pr",
			target: pr.target,
			why: pr.why,
			ask: pr.ask,
			state: "waiting",
		});
	});

	it("keeps a look pointed at again in its place rather than adding it twice", () => {
		pointAt(dir, pr, who, new Date("2026-11-08T09:00:00Z"));
		pointAt(
			dir,
			{ ...pr, title: "Quest carry, merged" },
			who,
			new Date("2026-11-08T10:00:00Z"),
		);

		expect(looksIn(dir)).toHaveLength(1);
		expect(looksIn(dir)[0]).toMatchObject({
			title: "Quest carry, merged",
			at: "2026-11-08T09:00:00.000Z",
		});
		// Another session pointing at the same thing is a look of its own.
		pointAt(dir, pr, { session: "S2" }, new Date("2026-11-08T10:01:00Z"));
		expect(looksIn(dir)).toHaveLength(2);
	});

	it("keeps a look until the launcher takes it, whatever its age", () => {
		pointAt(dir, pr, who, new Date("2026-01-01T00:00:00Z"));

		expect(looksIn(dir)).toHaveLength(1);
	});

	it("reads past a file it can't make sense of, and an empty folder as none", () => {
		writeFileSync(join(dir, "torn.json"), "{not json");
		expect(looksIn(dir)).toEqual([]);
		expect(looksIn(join(dir, "none"))).toEqual([]);
	});

	// Joel, 8 November: anything that no longer needs him clears itself.
	it("resolves a waiting look at a change once it merges, its tabs included", () => {
		pointAt(
			dir,
			{ ...pr, target: `${pr.target}/files` },
			who,
			new Date("2026-11-08T09:00:00Z"),
		);
		const other = {
			...pr,
			target: "https://github.com/Jitsusama/agentic-harness.pi/pull/1071",
		};
		pointAt(dir, other, who, new Date("2026-11-08T09:01:00Z"));

		const merged = new Date("2026-11-08T12:00:00Z");
		expect(resolveLooks(dir, `${pr.target}/`, "merged", merged)).toBe(1);
		const [newest, first] = looksIn(dir);
		expect(first).toMatchObject({
			state: "resolved",
			how: "merged",
			resolvedAt: "2026-11-08T12:00:00.000Z",
			at: "2026-11-08T09:00:00.000Z",
		});
		expect(newest?.state).toBe("waiting");
	});

	it("resolves a look the person opened once its change merges", () => {
		const look = pointAt(dir, pr, who);
		mark(look.id, "opened");

		expect(resolveLooks(dir, pr.target, "merged"), "the opened look").toBe(1);
		expect(looksIn(dir)[0]?.state).toBe("resolved");
	});

	it("leaves a look at a file as it is", () => {
		const file = {
			kind: "file" as const,
			target: "/home/joel/notes.md",
			title: "Notes",
			why: "Yours.",
			ask: "Nothing, just to see.",
		};
		pointAt(dir, file, who);
		expect(resolveLooks(dir, "/home/joel/notes.md", "closed")).toBe(0);
		expect(resolveLooks(dir, "", "closed")).toBe(0);
		expect(looksIn(dir)[0]?.state).toBe("waiting");
	});

	it("refuses a look with no why, or one that can't open in its place", () => {
		expect(refusalOf({ ...pr, why: " " })).toMatch(
			/why the person should look/,
		);
		expect(refusalOf({ ...pr, title: "" })).toMatch(/what it is/);
		expect(
			refusalOf({ ...pr, target: "Jitsusama/agentic-harness.pi#1070" }),
		).toMatch(/by its URL/);
		expect(
			refusalOf({ ...pr, kind: "file", target: "modules/pi/chime.nix" }),
		).toMatch(/absolute path/);
		expect(refusalOf(pr)).toBeUndefined();
	});
});

// Joel, 11 November: "anything that is going to fight for my attention is
// easy for me to engage with, even if i engage with it later. if it is no
// longer applicable because i took too long and things have changed, it
// should disappear."
describe("a look written for the person", () => {
	it("keeps what he's asked to do, and refuses a look that doesn't say", () => {
		pointAt(dir, pr, who);

		expect(looksIn(dir)[0]?.ask, "the ask is kept whole").toBe(
			"Nothing, just to see.",
		);
		expect(refusalOf({ ...pr, ask: "" }), "no ask").toMatch(
			/what the person is asked to do/,
		);
	});

	it.each([
		["a mesh message's id", { why: "As settled in [4a4ae257], it restarts." }],
		["a quest's id", { title: "QEST-20261025-85PKB2's restart" }],
		["a session's address", { why: "WCJQSG wants it read." }],
		["code", { ask: "Run `/harness restart` once." }],
		["a path", { why: "The design is in ~/src/core.nix/design.md." }],
		["a path", { ask: "Read /home/joel/notes/plan.md first." }],
	])("refuses the agents' own talk: %s", (_what, part) => {
		expect(refusalOf({ ...pr, ...part }), JSON.stringify(part)).toMatch(
			/can't place|name no path/,
		);
	});

	it("refuses a why past a sentence and an ask past a line", () => {
		const many = (n: number) =>
			Array.from({ length: n }, () => "word").join(" ");

		expect(refusalOf({ ...pr, why: many(41) }), "a 41-word why").toMatch(
			/at most 40 words/,
		);
		expect(refusalOf({ ...pr, ask: many(31) }), "a 31-word ask").toMatch(
			/at most 30 words/,
		);
		expect(
			refusalOf({ ...pr, why: many(40), ask: many(30) }),
			"at the limits",
		).toBeUndefined();
	});

	it("reads plain words with capitals and numbers as his", () => {
		expect(
			refusalOf({
				...pr,
				title: "The bar at 76 columns",
				why: "Your status bar showed only dotfiles at 76 columns; now it keeps the model, the cost and the branch.",
				ask: "Say whether it reads right in a narrow window: keep it, or tell me what to drop.",
			}),
		).toBeUndefined();
	});

	it("is taken back by its session once it no longer applies", () => {
		const at = new Date("2026-11-11T22:00:00Z");
		pointAt(dir, pr, who);
		pointAt(dir, pr, { session: "S2" });

		expect(
			withdrawLook(dir, { session: "S1" }, "pr", pr.target, at),
			"S1's look",
		).toBe(true);
		const mine = looksIn(dir).find((look) => look.session === "S1");
		const theirs = looksIn(dir).find((look) => look.session === "S2");
		expect(mine).toMatchObject({
			state: "resolved",
			how: "taken back",
			resolvedAt: "2026-11-11T22:00:00.000Z",
		});
		expect(theirs?.state, "another session's look stays").toBe("waiting");
		expect(
			withdrawLook(dir, { session: "S1" }, "pr", pr.target, at),
			"nothing left to take back",
		).toBe(false);
	});

	// 2RCBOJ, 12 November: 5SQB3O's withdraw found nothing once Joel had
	// opened the look, and a quest's later session couldn't take back what
	// an earlier one raised.
	it("is taken back once opened, by a later session on its quest, at any of its tabs", () => {
		const look = pointAt(dir, pr, who);
		mark(look.id, "opened");

		expect(
			withdrawLook(
				dir,
				{ session: "S9", quest: "QEST-1" },
				"pr",
				`${pr.target}/checks`,
			),
			"a later session of QEST-1",
		).toBe(true);
		expect(looksIn(dir)[0]).toMatchObject({
			state: "resolved",
			how: "taken back",
		});
	});

	it("isn't taken back by another quest's session", () => {
		pointAt(dir, pr, who);

		expect(
			withdrawLook(dir, { session: "S9", quest: "QEST-2" }, "pr", pr.target),
			"QEST-2's session",
		).toBe(false);
		expect(looksIn(dir)[0]?.state).toBe("waiting");
	});

	it("goes when the quest it was for ends, and only then", () => {
		const opened = pointAt(dir, pr, who);
		mark(opened.id, "opened");
		pointAt(
			dir,
			{ ...pr, target: `${pr.target}2` },
			{ session: "S3", quest: "QEST-2" },
		);
		pointAt(dir, { ...pr, target: `${pr.target}3` }, { session: "S4" });

		expect(
			resolveLooksOfQuests(dir, (quest) => quest === "QEST-1"),
			"QEST-1's one look",
		).toBe(1);
		const byQuest = Object.fromEntries(
			looksIn(dir).map((look) => [look.quest ?? "none", look]),
		);
		expect(byQuest["QEST-1"]).toMatchObject({
			state: "resolved",
			how: "its quest ended",
		});
		expect(byQuest["QEST-2"]?.state, "a live quest's look stays").toBe(
			"waiting",
		);
		expect(byQuest.none?.state, "a look for no quest stays").toBe("waiting");
	});
});

// The looks clock asks this each minute, so a look outlives no quest
// that ended in another session.
// 2RCBOJ, 12 November: most looks ask for a word back, and the only way
// to give it was to find the session, which may have moved on.
describe("a look answered where the person is", () => {
	const asking = {
		...pr,
		ask: "Say whether you posted it.",
		choices: ["Posted", "Not yet"],
	};

	it("keeps its choices, and resolves saying what he picked", () => {
		const look = pointAt(dir, asking, who, new Date("2026-11-12T06:00:00Z"));
		expect(look.choices, "each choice its own value").toEqual([
			{ value: "Posted", label: "Posted" },
			{ value: "Not yet", label: "Not yet" },
		]);

		const answered = answerLook(
			dir,
			look.id,
			"Not yet",
			new Date("2026-11-12T07:00:00Z"),
		);

		expect(looksIn(dir)[0], "resolved with his answer").toMatchObject({
			state: "resolved",
			how: "answered: Not yet",
			answer: "Not yet",
			answeredAt: "2026-11-12T07:00:00.000Z",
		});
		expect(answered, "answers the look as kept").toEqual(looksIn(dir)[0]);
	});

	it("answers nothing it doesn't offer, nor a look no longer waiting", () => {
		const look = pointAt(dir, asking, who);
		expect(answerLook(dir, look.id, "Maybe"), "no such choice").toBeUndefined();
		expect(answerLook(dir, "0000", "Posted"), "no such look").toBeUndefined();
		withdrawLook(dir, who, look.kind, look.target);
		expect(answerLook(dir, look.id, "Posted"), "taken back").toBeUndefined();
		expect(looksIn(dir)[0]?.how, "left as taken back").toBe("taken back");
	});

	it("refuses choices past a row's room, repeated, or not his words", () => {
		const many = Array.from(
			{ length: MOST_CHOICES + 1 },
			(_, n) => `Pick ${n}`,
		);
		for (const [choices, why] of [
			[many, "too many"],
			[["Posted", "posted"], "the same twice"],
			[["Posted", " "], "one without words"],
			[["Posted it to the channel today"], "a sentence"],
			[["Ask 85PKB2"], "a session's address"],
		] as const) {
			expect(refusalOf({ ...asking, choices }), why).toBeDefined();
		}
		expect(refusalOf(asking), "two short labels").toBeUndefined();
	});
});

// WCJQSG, 12 November, after Joel at 15:42: "look at my to look at, how
// many of those are actually useful to me as a human?" It held 45.
describe("a look list that keeps only what's useful", () => {
	const t0 = new Date("2026-11-12T09:00:00Z");
	const later = new Date("2026-11-12T09:30:00Z");

	it("folds one quest's looks at a change, its tabs and diffs, into the newest, in the older's place", () => {
		pointAt(dir, pr, who, t0);
		pointAt(
			dir,
			{
				...pr,
				kind: "diff",
				target: `${pr.target}/files#diff-1`,
				title: "Quest carry's diff",
			},
			{ session: "S2", quest: "QEST-1" },
			later,
		);

		expect(looksIn(dir), "one look for the change").toHaveLength(1);
		expect(looksIn(dir)[0]).toMatchObject({
			title: "Quest carry's diff",
			session: "S2",
			kind: "diff",
			target: `${pr.target}/files#diff-1`,
			at: t0.toISOString(),
		});
		pointAt(dir, pr, { session: "S3", quest: "QEST-2" }, later);
		expect(looksIn(dir), "another quest's look stands apart").toHaveLength(2);
	});

	it("folds a page with its fragment, and looks on one thread whatever their targets, never by title", () => {
		const page = {
			...pr,
			kind: "page" as const,
			target: "https://example.com/design",
			title: "The design",
		};
		pointAt(dir, page, who, t0);
		pointAt(dir, { ...page, target: `${page.target}#colours` }, who, later);
		expect(looksIn(dir), "a page and its fragment").toHaveLength(1);

		pointAt(dir, { ...pr, title: "The design" }, who, later);
		expect(looksIn(dir), "the same title folds nothing").toHaveLength(2);

		pointAt(dir, { ...pr, thread: "the ask" }, who, later);
		pointAt(
			dir,
			{ ...page, target: "https://example.com/other", thread: "the ask" },
			who,
			later,
		);
		expect(
			looksIn(dir).map((look) => look.target),
			"the thread folds the PR into the other page",
		).toEqual(["https://example.com/other", `${page.target}#colours`]);
	});

	it("says whether it asks for something back, and a look that only shows lasts a day", () => {
		const shows = pointAt(dir, pr, who, t0);
		const picks = pointAt(
			dir,
			{
				...pr,
				target: `${pr.target}1`,
				ask: "Nothing, just to see whether it posted.",
				choices: ["Posted", "Not yet"],
			},
			who,
			t0,
		);
		const says = pointAt(
			dir,
			{ ...pr, target: `${pr.target}2`, ask: "Say whether it reads right." },
			who,
			t0,
		);

		expect(shows, "only to see").toMatchObject({
			asks: false,
			expiresAt: new Date(t0.getTime() + SHOWING_LASTS_MS).toISOString(),
		});
		expect(picks.asks, "choices ask").toBe(true);
		expect(says.asks, "an ask in words").toBe(true);
		expect(picks.expiresAt, "a look that asks has no time").toBeUndefined();
		expect(says.expiresAt, "nor one asking in words").toBeUndefined();
	});

	it("expires what its owner holds once past its time, and answers those it expired", () => {
		const mine = pointAt(dir, pr, who, t0);
		pointAt(dir, pr, { session: "S5", quest: "QEST-5" }, t0);
		pointAt(
			dir,
			{ ...pr, target: `${pr.target}9`, ask: "Say whether to merge." },
			who,
			t0,
		);
		const day = new Date(t0.getTime() + SHOWING_LASTS_MS);
		const ownedHere = (look: { quest?: string }) => look.quest === "QEST-1";

		expect(
			expireLooks(dir, ownedHere, new Date(day.getTime() - 1)),
			"a moment early",
		).toEqual([]);
		const expired = expireLooks(dir, ownedHere, day);

		expect(
			expired.map((look) => look.id),
			"only this quest's showing look",
		).toEqual([mine.id]);
		const states = looksIn(dir).map((look) => `${look.quest} ${look.state}`);
		expect(states.sort(), "what each became").toEqual([
			"QEST-1 expired",
			"QEST-1 waiting",
			"QEST-5 waiting",
		]);
		expect(expireLooks(dir, ownedHere, day), "expired once").toEqual([]);
	});

	it("lets an opened look that only shows leave, and keeps one that asks", () => {
		const shows = pointAt(dir, pr, who, t0);
		const asks = pointAt(
			dir,
			{ ...pr, target: `${pr.target}1`, ask: "Say whether to merge." },
			who,
			t0,
		);
		mark(shows.id, "opened");
		mark(asks.id, "opened");

		expect(leaveSeenLooks(dir, later), "the showing look").toBe(1);
		const byId = Object.fromEntries(looksIn(dir).map((one) => [one.id, one]));
		expect(byId[shows.id]).toMatchObject({ state: "resolved", how: "seen" });
		expect(byId[asks.id]?.state, "the asking look stays opened").toBe("opened");
	});

	it("reads a look kept before it said whether it asks as asking", () => {
		const look = pointAt(dir, pr, who, t0);
		const file = join(dir, `${look.id}.json`);
		const {
			asks: _asks,
			expiresAt: _expires,
			...older
		} = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify({ ...older, state: "opened" }));

		expect(leaveSeenLooks(dir, later), "an older look stays").toBe(0);
		expect(expireLooks(dir, () => true, new Date("2027-01-01"))).toEqual([]);
	});
});

describe("whether a look's quest has ended", () => {
	/** A quest under `dir` standing at `status`. */
	function quest(id: string, status: string): void {
		mkdirSync(join(dir, id), { recursive: true });
		writeFileSync(
			join(dir, id, "README.md"),
			`---\nid: ${id}\nkind: quest\nparent: null\nstatus: ${status}\npriority: active\nrank: 1\nstarted: 2026-11-11\nupdated: 2026-11-11\n---\n# ${id}\n`,
		);
	}

	it("says so of a concluded or retired quest, and not of a live one", () => {
		quest("QEST-20261111-AAAAAA", "concluded");
		quest("QEST-20261111-BBBBBB", "retired");
		quest("QEST-20261111-CCCCCC", "active");

		expect(questEnded(dir, "QEST-20261111-AAAAAA"), "concluded").toBe(true);
		expect(questEnded(dir, "QEST-20261111-BBBBBB"), "retired").toBe(true);
		expect(questEnded(dir, "QEST-20261111-CCCCCC"), "active").toBe(false);
	});

	it("doesn't call a quest it can't read ended", () => {
		expect(questEnded(dir, "QEST-20261111-DDDDDD"), "no README").toBe(false);
	});
});
