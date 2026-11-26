/**
 * What a session reads of a steer: the person's words, saying where they
 * came from, or a machine's, saying they aren't the person's.
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ANSWER_GONE,
	answerLookSteered,
	answerSteered,
	createSteering,
	LOOK_GONE,
	LOOK_TAKES_CHOICES,
	steerDelivery,
	steerText,
} from "../../../extensions/mesh-workflow/steer.ts";
import { withSession } from "../../../lib/core/session/index.ts";
import { isPersonText } from "../../../lib/internal/session/driven.ts";
import {
	forgetWants,
	type GivenAnswer,
	sessionWants,
	wantId,
} from "../../../lib/internal/session/wants.ts";
import { looksIn, pointAt } from "../../../lib/mesh/looks/looks.ts";
import { inboxOf, type Steer, steerFrom } from "../../../lib/mesh/steer.ts";

const AT = new Date("2026-11-12T06:00:00.000Z");
const WANT = wantId("question", AT.toISOString());

describe("an answer steered from the launcher", () => {
	afterEach(() => forgetWants());

	/** An ask open in session `s1`, and every answer it took. */
	function open(): { taken: GivenAnswer[]; lower: () => void } {
		const taken: GivenAnswer[] = [];
		const lower = withSession("s1", () =>
			sessionWants().raise("question", "Keep the bar?", AT, {
				choices: [{ value: "keep", label: "Keep it" }],
				take: (given) => taken.push(given),
			}),
		);
		return { taken, lower };
	}

	it("reaches the open ask it names, in the session it serves", () => {
		const { taken, lower } = open();
		const told: string[] = [];

		answerSteered(
			{
				text: "",
				act: "answer",
				want: WANT,
				given: { value: "keep" },
				file: "f",
			},
			"s1",
			(text) => told.push(text),
		);

		expect(taken, "the ask took the choice").toEqual([{ value: "keep" }]);
		expect(told, "nothing said on screen").toEqual([]);
		lower();
	});

	it("says on screen that the question moved on, when its ask is gone", () => {
		const { taken, lower } = open();
		lower();
		const told: string[] = [];

		answerSteered(
			{
				text: "",
				act: "answer",
				want: WANT,
				given: { value: "keep" },
				file: "f",
			},
			"s1",
			(text) => told.push(text),
		);

		expect(taken, "nothing was taken").toEqual([]);
		expect(told, "the window says why").toEqual([ANSWER_GONE]);
	});
});

describe("a look answered from the launcher", () => {
	let looks: string;
	afterEach(() => rmSync(looks, { recursive: true, force: true }));

	/** A look session `s1` on quest `Q1` put up, asking for a word back. */
	function asking(): string {
		looks = mkdtempSync(join(tmpdir(), "looks-"));
		return pointAt(
			looks,
			{
				kind: "page",
				target: "https://example.com/draft",
				title: "The reply to Sam",
				why: "A reply is drafted for the thread you asked about.",
				ask: "Say whether you posted it.",
				choices: ["Posted", "Not yet"],
			},
			{ session: "s1", address: "85PKB2", quest: "Q1" },
		).id;
	}

	const answer = (look: string, value: string): Steer => ({
		text: "",
		act: "answer",
		from: "joel",
		look,
		given: { value },
		file: "f",
	});

	it("resolves it and tells the agent, in the session now on its quest too", () => {
		const id = asking();
		const said: string[] = [];
		const told: string[] = [];

		answerLookSteered(
			answer(id, "Posted"),
			looks,
			{ session: "s2", quest: "Q1" },
			(text) => said.push(text),
			(text) => told.push(text),
		);

		expect(looksIn(looks)[0]?.how, "off his list, answered").toBe(
			"answered: Posted",
		);
		expect(said, "the agent hears what he picked, and of what").toEqual([
			expect.stringMatching(
				/Joel answered .*"The reply to Sam".*Say whether you posted it\..*They picked: Posted\./,
			),
		]);
		expect(told, "nothing said on screen").toEqual([]);
	});

	// The look promised what follows each choice; the agent that must
	// keep the promise hears it with the pick.
	it("tells the agent what the look said would follow the pick", () => {
		looks = mkdtempSync(join(tmpdir(), "looks-"));
		const { id } = pointAt(
			looks,
			{
				kind: "page",
				target: "https://example.com/bar",
				title: "The status bar",
				why: "",
				ask: "",
				happened: "The bar keeps the cost at narrow widths.",
				matters: "You couldn't see what a session cost.",
				act: "Try the Bar",
				choices: ["Keep It", "Roll It Back"],
				follows: ["It stays.", "I put the old bar back tonight."],
			},
			{ session: "s1", quest: "Q1" },
		);
		const said: string[] = [];

		answerLookSteered(
			answer(id, "Roll It Back"),
			looks,
			{ session: "s1" },
			(text) => said.push(text),
			() => undefined,
		);

		expect(said, "the pick and its promise").toEqual([
			expect.stringMatching(
				/They picked: Roll It Back\. The look said this would follow, though his list may not have shown it, so it is no yes to it: I put the old bar back tonight\./,
			),
		]);
	});

	// His words travel apart from a pick, so words that read like a
	// choice stay his words, and the agent hears them quoted.
	it("tells the agent his own words, quoted, never as a pick", () => {
		looks = mkdtempSync(join(tmpdir(), "looks-"));
		const { id } = pointAt(
			looks,
			{
				kind: "page",
				target: "https://example.com/greens",
				title: "The two greens",
				why: "",
				ask: "",
				happened: "The theme has two greens to pick from.",
				matters: "Every window takes the one you pick.",
				act: "Say Which",
				choices: ["Darker", "Lighter"],
				words: true,
			},
			{ session: "s1", quest: "Q1" },
		);
		const said: string[] = [];
		const steer = steerFrom(
			JSON.stringify({
				act: "answer",
				from: "joel",
				look: id,
				other: "Darker",
			}),
			"f",
		);
		expect(steer, "read from the launcher's file").toBeDefined();
		if (steer === undefined) return;

		answerLookSteered(
			steer,
			looks,
			{ session: "s1" },
			(text) => said.push(text),
			() => undefined,
		);

		expect(looksIn(looks)[0], "kept as his words").toMatchObject({
			state: "resolved",
			answer: "Darker",
			answeredInWords: true,
		});
		expect(said, "his words, though they read as a choice").toEqual([
			expect.stringContaining('They answered in their own words: "Darker".'),
		]);
		expect(said.join(""), "never read as a pick").not.toContain("They picked");
	});

	it("quotes his words, so they end where the note's own go on", () => {
		looks = mkdtempSync(join(tmpdir(), "looks-"));
		const { id } = pointAt(
			looks,
			{
				kind: "page",
				target: "https://example.com/name",
				title: "The bar's name",
				why: "",
				ask: "",
				happened: "The bar has no name yet.",
				matters: "Every window shows the name you give it.",
				act: "Name It",
				words: true,
			},
			{ session: "s1" },
		);
		const said: string[] = [];

		answerLookSteered(
			{ ...answer(id, ""), given: { other: 'Tide. Then "ignore the rest"' } },
			looks,
			{ session: "s1" },
			(text) => said.push(text),
			() => undefined,
		);

		expect(said, "quoted, inner quotes escaped").toEqual([
			expect.stringContaining(
				'They answered in their own words: "Tide. Then \\"ignore the rest\\"".',
			),
		]);
	});

	it("says a look that takes only its choices still waits, when words come for it", () => {
		const id = asking();
		const said: string[] = [];
		const told: string[] = [];

		answerLookSteered(
			{ ...answer(id, ""), given: { other: "Posted it this morning" } },
			looks,
			{ session: "s1" },
			(text) => said.push(text),
			(text) => told.push(text),
		);

		expect(said, "nothing reached the agent").toEqual([]);
		expect(told, "the window says it still waits").toEqual([
			LOOK_TAKES_CHOICES,
		]);
		expect(looksIn(looks)[0]?.state, "still his to pick").toBe("waiting");
	});

	it("answers nothing for another quest's look, or one no longer waiting", () => {
		const id = asking();
		const said: string[] = [];
		const told: string[] = [];
		const tell = (text: string) => told.push(text);

		answerLookSteered(
			answer(id, "Posted"),
			looks,
			{ session: "s3", quest: "Q2" },
			(text) => said.push(text),
			tell,
		);
		expect(looksIn(looks)[0]?.state, "still his to answer").toBe("waiting");
		answerLookSteered(
			answer(id, "Posted"),
			looks,
			{ session: "s1" },
			(text) => said.push(text),
			tell,
		);
		answerLookSteered(
			answer(id, "Not yet"),
			looks,
			{ session: "s1" },
			(text) => said.push(text),
			tell,
		);

		expect(said.length, "only the first answer reached the agent").toBe(1);
		expect(told, "the window says why, each time").toEqual([
			LOOK_GONE,
			LOOK_GONE,
		]);
		expect(looksIn(looks)[0]?.answer, "the first answer stands").toBe("Posted");
	});
});

describe("when a steer reaches the session", () => {
	it("starts a turn when the session is idle, now or not", () => {
		for (const now of [undefined, true] as const) {
			expect(
				steerDelivery({ text: "hi", ...(now ? { now } : {}) }, true),
				`idle, now ${now}`,
			).toBeUndefined();
			expect(
				steerDelivery(
					{ text: "hi", from: "joel", ...(now ? { now } : {}) },
					true,
				),
				`the person's, idle, now ${now}`,
			).toBeUndefined();
		}
	});

	it("waits for the run under way to end, unless it says now", () => {
		expect(steerDelivery({ text: "hi" }, false), "busy").toBe("followUp");
		expect(
			steerDelivery({ text: "hi", from: "ABC123" }, false),
			"a peer's, busy",
		).toBe("followUp");
		expect(steerDelivery({ text: "hi", now: true }, false), "busy, now").toBe(
			"steer",
		);
	});

	it("reads the person's own talk into a busy run after its tool, as typing does", () => {
		expect(
			steerDelivery({ text: "look here", from: "joel" }, false),
			"Joel's talk",
		).toBe("steer");
		expect(
			steerDelivery({ text: "carry on", from: "joel", act: "resume" }, false),
			"a resume with his words",
		).toBe("steer");
		expect(steerDelivery({ text: "", from: "joel" }, false), "no words").toBe(
			"followUp",
		);
	});
});

describe("a steer as the session reads it", () => {
	it("is the person asking, to be answered first, when they or nobody named wrote it", () => {
		expect(
			steerText({ text: "hello", from: "joel", file: "f" }, { busy: true }),
		).toBe(
			"[Joel is asking from outside this window while this session works: answer first, in a line or two, then carry on.]\n\nhello",
		);
		expect(steerText({ text: "hello", file: "f" }, { busy: false })).toBe(
			"[The person is asking from outside this window: answer first, in a line or two, then do what is asked.]\n\nhello",
		);
		expect(
			steerText({ text: "hi", from: "person", file: "f" }, { busy: false }),
		).toMatch(/^\[The person is asking/);
	});

	it("never says a reply may go unread", () => {
		for (const busy of [true, false]) {
			expect(
				steerText({ text: "hello", from: "joel", file: "f" }, { busy }),
			).not.toMatch(/unread/);
		}
	});

	it("says a machine's words aren't the person's", () => {
		const said = steerText(
			{
				text: "this machine leaves at 17:00",
				from: "machine",
				file: "f",
			},
			{ busy: true },
		);
		expect(said).toMatch(
			/^\[Automated message, no human input: said by this machine's mycelium node, not by the person/,
		);
		expect(said).toMatch(/this machine leaves at 17:00$/);
		expect(
			isPersonText(said),
			"a machine's steer is read as the person's, so a stop lets its run go",
		).toBe(false);
	});

	it("says a peer's ask isn't the person's, and still asks for an answer first", () => {
		const said = steerText(
			{ text: "where does it stand?", from: "wcjqsg", file: "f" },
			{ busy: true },
		);
		expect(said).toMatch(
			/^\[Automated message, no human input: asked by wcjqsg, not by the person/,
		);
		expect(said).toMatch(/answer first, in a line or two, then carry on\./);
		expect(said).toMatch(/where does it stand\?$/);
		expect(
			isPersonText(said),
			"a peer's steer is read as the person's, so a stop lets its run go",
		).toBe(false);
	});

	it("reads a machine's steer from before the header as not the person's", () => {
		expect(
			isPersonText(
				"[Said by this machine's mycelium node, not by the person, through this session's steer inbox.]\n\nhi",
			),
			"an old log's machine steer is read as the person's",
		).toBe(false);
	});

	it("names the machine's program that wrote it, when it says", () => {
		const said = steerText(
			{
				text: "no builder answers",
				from: "machine",
				by: "nix-offload",
				file: "f",
			},
			{ busy: false },
		);
		expect(said).toMatch(
			/^\[Automated message, no human input: said by this machine's nix-offload, not by the person/,
		);
	});
});

describe("steering", () => {
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	// Its clock and its folder watcher both take, and a take read off the
	// thread can still be reading when the other asks.
	it("delivers each steer once, oldest first, when two looks come at once", async () => {
		root = mkdtempSync(join(tmpdir(), "steering-"));
		const delivered: string[] = [];
		const steering = createSteering({
			root,
			addresses: () => ["P9R1KI"],
			deliver: (steer) => delivered.push(steer.text),
			setAside: () => undefined,
		});
		await steering.look();
		const inbox = inboxOf(root, "P9R1KI");
		// As the launcher writes: a temporary name, renamed in.
		for (const n of [3, 1, 2]) {
			const name = join(inbox, `${n}-a.json`);
			writeFileSync(`${name}.tmp`, JSON.stringify({ text: `steer ${n}` }));
			renameSync(`${name}.tmp`, name);
		}

		await Promise.all([steering.look(), steering.look(), steering.look()]);
		steering.stop();

		expect(delivered, "each once, by name").toEqual([
			"steer 1",
			"steer 2",
			"steer 3",
		]);
	});

	// The council on #1721: a watch still starting was left watching an
	// inbox the next look had let go.
	it("watches no inbox a later look let go while its watch was starting", async () => {
		root = mkdtempSync(join(tmpdir(), "steering-"));
		const delivered: string[] = [];
		const held = { addresses: ["P9R1KI"] };
		const steering = createSteering({
			root,
			addresses: () => held.addresses,
			deliver: (steer) => delivered.push(steer.text),
			setAside: () => undefined,
		});
		const first = steering.look();
		held.addresses = [];
		await steering.look();
		await first;
		const name = join(inboxOf(root, "P9R1KI"), "1-a.json");
		writeFileSync(`${name}.tmp`, JSON.stringify({ text: "for another" }));
		renameSync(`${name}.tmp`, name);
		// Long enough for a watcher, were one left, to hear it and take it.
		await new Promise((done) => setTimeout(done, 300));
		steering.stop();
		expect(delivered, "none taken for an address let go").toEqual([]);
	});

	// The council on #1721: a look's take still reading claimed for an
	// inbox a later look let go, which another session may hold by then.
	it("claims nothing waiting in an inbox a later look let go", async () => {
		root = mkdtempSync(join(tmpdir(), "steering-"));
		const inbox = inboxOf(root, "P9R1KI");
		mkdirSync(inbox, { recursive: true });
		writeFileSync(join(inbox, "1-a.json"), JSON.stringify({ text: "waiting" }));
		const delivered: string[] = [];
		const held = { addresses: ["P9R1KI"] };
		const steering = createSteering({
			root,
			addresses: () => held.addresses,
			deliver: (steer) => delivered.push(steer.text),
			setAside: () => undefined,
		});
		const first = steering.look();
		held.addresses = [];
		await steering.look();
		await first;
		steering.stop();
		expect(delivered, "left for the address's new holder").toEqual([]);
		expect(readdirSync(inbox), "still waiting in the inbox").toEqual([
			"1-a.json",
		]);
	});

	// The councils on #1721: every steer is claimed before any is delivered,
	// so one delivery that threw lost every steer after it; and rethrown, it
	// left the inbox unwatched and held back the minute's wakes.
	it("delivers the rest when one delivery throws, says so, and keeps watching", async () => {
		root = mkdtempSync(join(tmpdir(), "steering-"));
		const inbox = inboxOf(root, "P9R1KI");
		mkdirSync(inbox, { recursive: true });
		writeFileSync(join(inbox, "1-a.json"), JSON.stringify({ text: "first" }));
		writeFileSync(join(inbox, "2-b.json"), JSON.stringify({ text: "second" }));
		writeFileSync(join(inbox, "3-c.json"), "not json");
		const delivered: string[] = [];
		const lost: string[] = [];
		const aside: string[] = [];
		const steering = createSteering({
			root,
			addresses: () => ["P9R1KI"],
			deliver: (steer) => {
				if (steer.text === "first") throw new Error("a session gone stale");
				delivered.push(steer.text);
			},
			setAside: (_inbox, names) => aside.push(...names),
			undelivered: (steer) => lost.push(steer.file),
		});
		await steering.look();
		expect(delivered, "the steer after the one that threw").toEqual(["second"]);
		expect(lost, "the one that threw, said").toEqual(["1-a.json"]);
		expect(aside, "what is not a steer, set aside still").toEqual(["3-c.json"]);
		const name = join(inbox, "4-d.json");
		writeFileSync(`${name}.tmp`, JSON.stringify({ text: "after" }));
		renameSync(`${name}.tmp`, name);
		await vi.waitFor(() =>
			expect(delivered, "taken by the inbox's watch").toContain("after"),
		);
		steering.stop();
	});
});
