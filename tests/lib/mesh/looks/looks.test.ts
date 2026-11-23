import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ANSWER_CHARACTERS,
	answerLook,
	expireLooks,
	type LookState,
	leaveSeenLooks,
	looksDue,
	looksIn,
	looksListed,
	MOST_CHOICES,
	pointAt,
	refusalOf,
	resolveLooks,
	resolveLooksOfQuests,
	SHOWING_LASTS_MS,
	withdrawLook,
} from "../../../../lib/mesh/looks/looks.ts";
import { questEnded } from "../../../../lib/mesh/presence.ts";

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

	// Y2YBTS and 85PKB2, 20 November: the launcher reads a look's cell
	// from its file rather than searching every session for it, so the
	// file names the session's own address, which no other session on its
	// quest shares, as its signing address can.
	it("names its cell by its session's own address, never its quest's", () => {
		const session = "0194a1b2-7c3d-7e4f-a5b6-c7d8eac01c97";
		pointAt(dir, pr, { ...who, session }, new Date("2026-11-20T09:00:00Z"));

		expect(looksIn(dir)[0]).toMatchObject({
			session,
			address: "85PKB2",
			cell: "EAC01C97",
		});
	});

	it("names the cell of the session that pointed at it last, once another on its quest does", () => {
		pointAt(
			dir,
			pr,
			{ ...who, session: "0194a1b2-0000-0000-0000-0000000000a1" },
			new Date("2026-11-20T09:00:00Z"),
		);
		pointAt(
			dir,
			pr,
			{ ...who, session: "0194a1b2-0000-0000-0000-0000000000b2" },
			new Date("2026-11-20T09:30:00Z"),
		);

		expect(looksIn(dir)).toHaveLength(1);
		expect(looksIn(dir)[0]).toMatchObject({
			at: "2026-11-20T09:00:00.000Z",
			cell: "000000B2",
		});
	});

	it("keeps its cell once it's answered, resolved or expired", () => {
		const session = "0194a1b2-0000-0000-0000-0000000000c3";
		const asking = { ...pr, ask: "Say whether.", choices: ["Yes", "No"] };
		const answered = pointAt(dir, asking, { ...who, session });
		const merged = pointAt(
			dir,
			{ ...pr, target: "https://github.com/Jitsusama/core.nix/pull/1" },
			{ ...who, session },
		);
		const lapsed = pointAt(
			dir,
			{ ...pr, target: "https://example.com/page", kind: "page" as const },
			{ ...who, session },
			new Date("2026-11-01T09:00:00Z"),
		);

		answerLook(dir, answered.id, { value: "Yes" });
		resolveLooks(dir, "https://github.com/Jitsusama/core.nix/pull/1", "merged");
		expect(expireLooks(dir, () => true).map((look) => look.id)).toEqual([
			lapsed.id,
		]);

		const byId = new Map(looksIn(dir).map((look) => [look.id, look]));
		for (const look of [answered, merged, lapsed]) {
			expect(byId.get(look.id)?.state, look.title).not.toBe("waiting");
			expect(byId.get(look.id)?.cell, look.title).toBe("000000C3");
		}
	});

	it("still reads a look kept before looks named their cell", () => {
		const look = pointAt(dir, pr, who);
		const file = join(dir, `${look.id}.json`);
		const { cell: _cell, ...kept } = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify(kept));

		expect(looksIn(dir)).toHaveLength(1);
		expect(looksIn(dir)[0]?.cell).toBeUndefined();
		expect(looksIn(dir)[0]?.id).toBe(look.id);
	});

	it("reads a look whose cell isn't a string as one with none", () => {
		const look = pointAt(dir, pr, who);
		const file = join(dir, `${look.id}.json`);
		const kept = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify({ ...kept, cell: { to: "OWL01" } }));

		expect(looksIn(dir)).toHaveLength(1);
		expect(looksIn(dir)[0]).not.toHaveProperty("cell");
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

	// Each conversation's looks clock reads the list every minute, and a
	// host holds them all on one thread.
	it("lists as it lists at once, letting the thread turn while it reads", async () => {
		pointAt(dir, pr, who, new Date("2026-11-08T09:00:00Z"));
		pointAt(
			dir,
			{ ...pr, target: "https://example.com/b", title: "Later" },
			who,
			new Date("2026-11-08T09:05:00Z"),
		);
		writeFileSync(join(dir, "torn.json"), "{not json");
		let turned = false;
		setImmediate(() => {
			turned = true;
		});

		const listed = await looksListed(dir);

		expect(turned, "the thread turned while the list was read").toBe(true);
		expect(listed, "newest first, the torn file passed over").toEqual(
			looksIn(dir),
		);
		expect(listed.map((look) => look.title)).toEqual(["Later", "Quest carry"]);
		await expect(looksListed(join(dir, "none"))).resolves.toEqual([]);
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
		// All digits at its end, so no session address hides in it and
		// only the quest-id pattern reads it.
		["a quest's id alone", { title: "QEST-20261025-123456's restart" }],
		["a session's address", { why: "WCJQSG wants it read." }],
		["code", { ask: "Run `/harness restart` once." }],
		["a path", { why: "The design is in ~/src/core.nix/design.md." }],
		["a path", { ask: "Read /home/joel/notes/plan.md first." }],
	])("refuses the agents' own talk: %s", (_what, part) => {
		expect(refusalOf({ ...pr, ...part }), JSON.stringify(part)).toMatch(
			/can't place|name no path/,
		);
	});

	it("names a quest's id as one", () => {
		expect(
			refusalOf({ ...pr, title: "QEST-20261025-123456's restart" }),
			"read as a quest's id, not an address",
		).toMatch(/a quest's or document's id/);
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

// Joel, 22 November: the look list is inscrutable. QGB4ON's For You
// lays a look out by what happened, why it matters, and what he presses.
describe("a look in its second form", () => {
	const bar = {
		kind: "pr" as const,
		target: "https://github.com/Jitsusama/agentic-harness.pi/pull/1378",
		title: "The status bar at narrow widths",
		why: "",
		ask: "",
		happened:
			"The status bar now keeps the model, the cost and the branch at narrow widths",
		matters:
			"At 76 columns it showed only the folder, so you couldn't see what a session cost.",
		act: "Try the Bar",
		choices: ["Keep It", "Roll It Back"],
		follows: ["It stays as it is.", "I put the old bar back tonight."],
	};

	it("keeps both forms, so a reader of only the first still shows it", () => {
		pointAt(dir, { ...bar, words: true }, who);

		expect(looksIn(dir)[0], "the look as kept").toMatchObject({
			v: 1,
			title: bar.title,
			why: `${bar.happened}. ${bar.matters}`,
			ask: "Try the Bar: Keep It, or Roll It Back.",
			choices: [
				{ value: "Keep It", label: "Keep It", follows: "It stays as it is." },
				{
					value: "Roll It Back",
					label: "Roll It Back",
					follows: "I put the old bar back tonight.",
				},
			],
			happened: bar.happened,
			matters: bar.matters,
			act: "Try the Bar",
			wants: {
				choices: [
					{ label: "Keep It", follows: "It stays as it is." },
					{ label: "Roll It Back", follows: "I put the old bar back tonight." },
				],
				words: true,
			},
			about: { kind: "pr", target: bar.target, title: bar.title },
			asks: true,
		});
	});

	it("asks nothing back when it wants nothing and only shows", () => {
		const shows = pointAt(
			dir,
			{ ...bar, act: "Just See", choices: [], follows: [] },
			who,
		);

		expect(shows.asks, "a look to see").toBe(false);
		expect(shows.wants, "nothing wanted back").toBeUndefined();
		// Only words set it asking: the act alone would ask nothing.
		expect(
			pointAt(
				dir,
				{ ...bar, act: "Just See", choices: [], follows: [], words: true },
				who,
			).asks,
			"a look he may answer in words",
		).toBe(true);
		expect(
			pointAt(dir, { ...bar, act: "Read It", choices: [], follows: [] }, who)
				.asks,
			"an act beyond seeing",
		).toBe(true);
	});

	// A parked question's prompt can open "Just look" and still ask, so
	// only a second form's act is read for seeing alone.
	it("reads a first form's ask that opens 'Just look' as asking", () => {
		// Words only the act's pattern would read as seeing alone.
		expect(
			pointAt(dir, { ...pr, ask: "Just look" }, who).asks,
			"a first form's ask, never read as an act",
		).toBe(true);
	});

	it("reads an act of Just See with its stop as seeing alone", () => {
		for (const act of ["Just See.", "Just See!"]) {
			expect(
				pointAt(
					dir,
					{
						...bar,
						target: `${bar.target}/${act === "Just See." ? "files" : "checks"}`,
						act,
						choices: [],
						follows: [],
					},
					who,
				).asks,
				act,
			).toBe(false);
		}
	});

	it("takes a happened and matters at their limits, past the first form's", () => {
		const long = {
			...bar,
			happened: `${"a".repeat(96)} ok.`,
			matters: `${"word ".repeat(39)}words`,
		};

		expect(long.happened, "happened").toHaveLength(100);
		expect(long.matters, "matters").toHaveLength(200);
		expect(refusalOf(long), "at the limits").toBeUndefined();
	});

	it("refuses a pointing in both forms, whose why and ask nothing reads", () => {
		expect(
			refusalOf({ ...bar, why: "See WCJQSG's note." }),
			"a why beside the second form",
		).toMatch(/one form, not both/);
		expect(
			refusalOf({ ...bar, ask: "Read ~/notes/plan.md" }),
			"an ask beside the second form",
		).toMatch(/one form, not both/);
	});

	it.each([
		["a name with a capital inside", { act: "Open on macOS" }],
		[
			"an abbreviation in a follows",
			{
				follows: ["It stays, e.g. at this width.", "I put it back tonight."],
			},
		],
	])("takes %s", (_what, part) => {
		expect(
			refusalOf({ ...bar, ...part }),
			JSON.stringify(part),
		).toBeUndefined();
	});

	it.each([
		["no happened", { happened: " " }, /what happened/],
		["no matters", { matters: "" }, /why what happened matters/],
		["no act", { act: "" }, /its act/],
		["a happened past 100", { happened: "a".repeat(101) }, /at most 100/],
		[
			"a happened past a sentence",
			{ happened: "Done. It works." },
			/one plain sentence/,
		],
		["a matters past 200", { matters: "a".repeat(201) }, /at most 200/],
		["an act past 4 words", { act: "Try the Bar Right Now" }, /a button/],
		["an act not in Title Case", { act: "try it" }, /a button/],
		["an act that opens on a symbol", { act: "🎉 Ship It" }, /a button/],
		["a session's address in the act", { act: "Ask WCJQSG" }, /can't place/],
		[
			"a quest's id",
			{ happened: "QEST-20261025-85PKB2 finished the bar." },
			/can't place/,
		],
		["code", { matters: "Run `pnpm check` to see it." }, /can't place/],
		[
			"a choice not in Title Case",
			{ choices: ["Keep it", "Roll It Back"] },
			/Title Case/,
		],
		[
			"choices alike",
			{ choices: ["Keep It", "Keep It"] },
			/each say something different/,
		],
		["a follows missing", { follows: ["It stays as it is."] }, /2 choices, 1/],
		[
			"a follows past a sentence",
			{ follows: ["It stays. Nothing more.", "Back tonight."] },
			/one sentence/,
		],
		[
			"a session's address",
			{ matters: "WCJQSG wants it read." },
			/can't place/,
		],
		[
			"a mesh message's id in a follows",
			{ follows: ["As in [4a4ae257].", "Back tonight."] },
			/can't place/,
		],
		["a path", { happened: "Wrote ~/notes/plan.md for you." }, /no path/],
	])("refuses %s", (_what, part, said) => {
		expect(refusalOf({ ...bar, ...part }), JSON.stringify(part)).toMatch(said);
	});

	it("reads short words inside a label as Title Case leaves them", () => {
		expect(
			refusalOf({ ...bar, act: "Look at the Bar" }),
			"Look at the Bar",
		).toBeUndefined();
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
			{ value: "Not yet" },
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
		expect(
			answerLook(dir, look.id, { value: "Maybe" }),
			"no such choice",
		).toBeUndefined();
		expect(
			answerLook(dir, look.id, { other: "Posted" }),
			"a choice's words given as his own, to a look wanting none",
		).toBeUndefined();
		expect(
			answerLook(dir, "0000", { value: "Posted" }),
			"no such look",
		).toBeUndefined();
		withdrawLook(dir, who, look.kind, look.target);
		expect(
			answerLook(dir, look.id, { value: "Posted" }),
			"taken back",
		).toBeUndefined();
		expect(looksIn(dir)[0]?.how, "left as taken back").toBe("taken back");
	});

	it("takes his own words when the look wants them, and only then", () => {
		const wordy = pointAt(
			dir,
			{
				...pr,
				why: "",
				ask: "",
				happened: "The theme has two greens to pick from.",
				matters: "Every window takes the one you pick.",
				act: "Say Which",
				words: true,
			},
			who,
		);
		const picky = pointAt(dir, { ...asking, target: `${pr.target}9` }, who);

		expect(
			answerLook(dir, wordy.id, { other: "  " }),
			"no words",
		).toBeUndefined();
		expect(
			answerLook(dir, wordy.id, { value: "the darker one" }),
			"words sent as a pick, which the look doesn't offer",
		).toBeUndefined();
		expect(
			answerLook(dir, picky.id, { other: "the darker one" }),
			"words to a look that offers only choices",
		).toBeUndefined();
		expect(
			answerLook(dir, wordy.id, { other: " the darker one " }),
			"his words",
		).toMatchObject({
			state: "resolved",
			how: "answered: the darker one",
			answer: "the darker one",
			answeredInWords: true,
		});
	});

	it("keeps no more of his words than a look holds", () => {
		const wordy = pointAt(
			dir,
			{
				...pr,
				why: "",
				ask: "",
				happened: "The theme has two greens to pick from.",
				matters: "Every window takes the one you pick.",
				act: "Say Which",
				words: true,
			},
			who,
		);
		const answered = answerLook(dir, wordy.id, {
			other: "g".repeat(ANSWER_CHARACTERS + 50),
		});
		expect(answered?.answer?.length, "cut to what a look holds").toBe(
			ANSWER_CHARACTERS,
		);
	});

	it("refuses words asked in a look's first form, which can't keep them", () => {
		expect(
			refusalOf({ ...asking, words: true }),
			"words with only why and ask",
		).toMatch(/second form/u);
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

	// The clock reads the list once, off the thread, and only a step
	// with something to do reads it again to write.
	it("says from one listing which steps have something to do, as each step finds", () => {
		const ownedHere = (look: { quest?: string }) => look.quest === "QEST-1";
		const ended = (quest: string) => quest === "QEST-2";
		const day = new Date(t0.getTime() + SHOWING_LASTS_MS);
		const none = { seen: false, expired: false, ended: false };
		expect(looksDue([], ownedHere, ended, day), "an empty list").toEqual(none);

		const shows = pointAt(dir, pr, who, t0);
		pointAt(
			dir,
			{ ...pr, target: `${pr.target}2`, ask: "Say whether to merge." },
			{ session: "S3", quest: "QEST-3" },
			t0,
		);
		expect(
			looksDue(looksIn(dir), ownedHere, ended, new Date(day.getTime() - 1)),
			"nothing due a moment early",
		).toEqual(none);
		expect(
			looksDue(looksIn(dir), ownedHere, ended, day),
			"this quest's showing look past its time",
		).toEqual({ ...none, expired: true });

		mark(shows.id, "opened");
		pointAt(
			dir,
			{ ...pr, target: `${pr.target}4` },
			{
				session: "S4",
				quest: "QEST-2",
			},
		);
		const due = looksDue(looksIn(dir), ownedHere, ended, t0);
		expect(due, "an opened showing look, and an ended quest's").toEqual({
			...none,
			seen: true,
			ended: true,
		});
		expect(leaveSeenLooks(dir, t0), "as leaving finds").toBe(1);
		expect(resolveLooksOfQuests(dir, ended, t0), "as ending finds").toBe(1);
		expect(
			looksDue(looksIn(dir), ownedHere, ended, t0),
			"none once done",
		).toEqual(none);
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

	it("holds on to no README's text once it has said", () => {
		// 16 November: 10.2 MB of the background host's heap was quest
		// READMEs read for whether a look's quest had ended, each kept
		// whole for its status alone.
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		// Sixteen, so the last README a RegExp keeps as its input is lost
		// in the margin.
		const quests = 16;
		const bodyBytes = 1024 * 1024;
		const ids = Array.from(
			{ length: quests },
			(_, at) => `QEST-20261116-PIN00${at}`,
		);
		const written = new Date(Date.now() - 60 * 60 * 1000);
		for (const id of ids) {
			quest(id, "active");
			const readme = join(dir, id, "README.md");
			writeFileSync(
				readme,
				readFileSync(readme, "utf8") +
					`\n## Summary\n\n${"A line of the quest's story.\n".repeat(bodyBytes / 29)}`,
			);
			// Written well before it is read, so its parse is kept.
			utimesSync(readme, written, written);
		}
		gc();
		const before = process.memoryUsage().heapUsed;

		const ended = ids.filter((id) => questEnded(dir, id));
		gc();
		const kept = process.memoryUsage().heapUsed - before;

		expect(ended, "none of the quests has ended").toEqual([]);
		expect(kept, "bytes still held after reading the READMEs").toBeLessThan(
			(quests * bodyBytes) / 4,
		);
	});
});
