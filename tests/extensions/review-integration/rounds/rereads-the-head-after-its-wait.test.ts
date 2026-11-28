/**
 * A council and a stack round read their change again once their wait
 * for a start is over, since the wait can last hours. On 28 November a
 * council on mycelium#572 reviewed a head the change had moved past by
 * its start, a stack round read heads five commits old, and two councils
 * failed every reviewer on a snapshot folder gone by theirs. Driven with
 * everything past the material stubbed, so what is tried is only what
 * the round reads after its wait. The tree stub answers as the work
 * broker does: the same folder for a commit while it stands, dated by
 * each ask, and a new one once a sweep took it. A stack round bound for
 * a room that is gone by its start waits again on this machine's bars,
 * so it reads and builds once more after that second wait too.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askCouncil } from "../../../../extensions/review-integration/tools/ask-council.ts";
import { askStack } from "../../../../extensions/review-integration/tools/ask-stack.ts";

/** What the stubs read and record, set by each case. */
const state = vi.hoisted(() => ({
	root: "",
	/** Each change's head now, by its label. */
	heads: new Map<string, string>(),
	/** The stack's changes, by label, lowest first. */
	stack: [] as string[],
	/** What happens while the round waits for its start. */
	during: (): void => undefined,
	/** What happens while it waits again, on this machine's bars. */
	later: (): void => undefined,
	/** How many times the round waited for a start. */
	waits: 0,
	/** The room the tip's reviewers would run on now, or nothing. */
	room: undefined as { place: { machine: string } } | undefined,
	/** The room each started round's reviewers were handed. */
	roomsGiven: [] as unknown[],
	/** Each commit a tree was asked for at, in order. */
	asks: [] as string[],
	/** Each commit a new tree folder was cut at, in order. */
	cuts: [] as string[],
	/** The change's base now. */
	base: "base0000",
	/** Whether reading the change throws. */
	unreadable: false,
	/** Whether reading a reviewer's lens throws. */
	lensBreaks: false,
	/** Whether the round's start came without a wait. */
	noWait: false,
	/** The head each diff a council's prompt was made from was read at. */
	prompted: [] as (string | undefined)[],
	/** The heads each started stack round recorded as read. */
	stackSent: [] as string[][],
	/** The folder each cut made, in order. */
	trees: [] as string[],
	/** A head the ledger refuses a council at. */
	ledgerRefuses: undefined as string | undefined,
	/** A head no tree can be cut at. */
	treeRefuses: undefined as string | undefined,
	/** How many times the round gave its start back. */
	released: 0,
	/** The head each started round read. */
	witnessed: [] as (string | undefined)[],
	/** The heads each started stack round read, tip last. */
	stackRead: [] as (string | undefined)[][],
	/** The folder each started round's reviewers start in. */
	startedIn: [] as string[],
}));

vi.mock(
	"../../../../extensions/review-integration/tools/ask-roster.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../extensions/review-integration/tools/ask-roster.ts")
		>()),
		rosterOrThrow: async () => ({
			roster: { reviewers: [{ id: "r1" }] },
			chosen: "the roster",
		}),
	}),
);

vi.mock(
	"../../../../extensions/review-integration/tools/ask-round.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../extensions/review-integration/tools/ask-round.ts")
		>()),
		claimIdentities: async () => undefined,
		chartersFor: async () => {
			if (state.lensBreaks)
				throw new Error("The repo's lens couldn't be read.");
			return new Map();
		},
		awaitRosterStart: async () => {
			state.waits += 1;
			if (state.waits === 1) state.during();
			else state.later();
			return {
				...(state.noWait ? {} : { waited: "It waited 3 hours for its start." }),
				release: async () => {
					state.released += 1;
				},
			};
		},
	}),
);

vi.mock(
	"../../../../extensions/review-integration/work.ts",
	async (importOriginal) => {
		const { existsSync, mkdirSync } = await import("node:fs");
		const { join } = await import("node:path");
		return {
			...(await importOriginal<
				typeof import("../../../../extensions/review-integration/work.ts")
			>()),
			treeForRound: async (_repo: unknown, commit: string) => {
				state.asks.push(commit);
				if (commit === state.treeRefuses) {
					return { refusal: `No tree can be cut at ${commit}.` };
				}
				const path = join(state.root, `snapshot-${commit}`);
				if (!existsSync(path)) {
					mkdirSync(path);
					state.cuts.push(commit);
					state.trees.push(path);
				}
				return { path };
			},
		};
	},
);

vi.mock("../../../../lib/core/review/index.ts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../lib/core/review/index.ts")
	>()),
	createRunStore: () => ({
		list: async () => [],
		record: async () => undefined,
	}),
	createFindingStore: () => ({ record: async () => [] }),
	councilNotEarned: (_earlier: unknown, head: string | undefined) =>
		head === state.ledgerRefuses
			? `A council already read ${head}.`
			: undefined,
	guidanceFor: async () => ({}),
	councilPrompt: (input: { diff: { at?: string } }) => {
		state.prompted.push(input.diff.at);
		return "the council's prompt";
	},
	stackPrompt: () => "the stack's prompt",
	runCouncil: async (input: { witness?: string }) => {
		state.witnessed.push(input.witness);
		return { run: { id: "council-1" }, warnings: [] };
	},
	runStackCouncil: async (input: { witnesses: string[] }) => {
		state.stackSent.push(input.witnesses);
		return { run: { id: "stack-1" }, warnings: [] };
	},
}));

vi.mock(
	"../../../../lib/core/review/ask/stack-witness.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../lib/core/review/ask/stack-witness.ts")
		>()),
		stackWitnesses: async (
			_exec: unknown,
			_path: string,
			_tip: string,
			heads: Map<string, string | undefined>,
		) => {
			state.stackRead.push([...heads.values()]);
			const held = [...heads].flatMap(([ref, head]) =>
				head === undefined ? [] : [[ref, head] as const],
			);
			return { held: new Map(held), unheld: [] };
		},
	}),
);

vi.mock(
	"../../../../extensions/review-integration/tools/ask-room.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../extensions/review-integration/tools/ask-room.ts")
		>()),
		briefFitsARoom: () => state.room !== undefined,
		roomFor: async () => state.room,
	}),
);

vi.mock(
	"../../../../extensions/review-integration/tools/ask-answer.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../extensions/review-integration/tools/ask-answer.ts")
		>()),
		answerFor: () => "Answered.",
		keptOnLedger: async () => [],
	}),
);

vi.mock(
	"../../../../extensions/review-integration/tools/ask-reviewer.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../extensions/review-integration/tools/ask-reviewer.ts")
		>()),
		deps: (
			_change: unknown,
			path: string,
			_watch: unknown,
			_charters: unknown,
			_round: unknown,
			room: unknown,
		) => {
			state.startedIn.push(path);
			state.roomsGiven.push(room);
			return { ask: async () => undefined, warmed: async () => undefined };
		},
	}),
);

vi.mock(
	"../../../../extensions/review-integration/engine.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../extensions/review-integration/engine.ts")
		>()),
		reviewEngine: async () => ({
			engine: {
				bound: async () => ({ diffModel: async () => ({ files: [] }) }),
			},
		}),
	}),
);

/** The head a change was built on, and the one it moved to. */
const A = "aaaaaaaa11111111";
const B = "bbbbbbbb22222222";
const C = "cccccccc33333333";

const CHANGE = "o/r#1";

/** A change as the round knows it, by its label. */
const changeRef = (label: string) => ({
	label,
	id: label,
	repo: { key: "github:o/r" },
});

/** The change's proposal as its head now stands. */
const proposalOf = (label: string) => {
	if (state.unreadable) throw new Error("The host didn't answer.");
	return {
		ref: changeRef(label),
		headCommit: state.heads.get(label),
		baseCommit: state.base,
	};
};

/**
 * A target bound to `CHANGE`, or to the stack `state.stack` names. Its
 * diff is read once, at the head there when it was bound, as a real
 * bound target's is.
 */
const bindNow = () => {
	const at = state.heads.get(CHANGE);
	return {
		repo: { key: "github:o/r" },
		provider: { id: "github" },
		proposal: async () => proposalOf(CHANGE),
		diffModel: async () => ({ files: [], at }),
		stack: async () => ({
			nodes: state.stack.map((label) => ({
				ref: `refs/heads/${label}`,
				change: proposalOf(label),
			})),
		}),
	};
};

const seat = () => ({ cwd: state.root, place: {}, said: [] });

const council = () =>
	askCouncil(
		bindNow() as never,
		changeRef(CHANGE) as never,
		{ action: "council" },
		seat() as never,
		{} as never,
		async () => bindNow() as never,
	);

const stackRound = () =>
	askStack(
		{} as never,
		bindNow() as never,
		{ action: "stack" },
		seat() as never,
		{ progress: () => undefined } as never,
	);

const textOf = (answer: { content: { type: string; text?: string }[] }) =>
	answer.content.map((part) => part.text ?? "").join("");

beforeEach(() => {
	state.root = mkdtempSync(join(tmpdir(), "rereads-"));
	vi.stubEnv("XDG_STATE_HOME", join(state.root, "state"));
	state.heads = new Map([[CHANGE, A]]);
	state.stack = [];
	state.during = () => undefined;
	state.later = () => undefined;
	state.waits = 0;
	state.room = undefined;
	state.roomsGiven = [];
	state.asks = [];
	state.cuts = [];
	state.base = "base0000";
	state.unreadable = false;
	state.lensBreaks = false;
	state.noWait = false;
	state.prompted = [];
	state.stackSent = [];
	state.trees = [];
	state.ledgerRefuses = undefined;
	state.treeRefuses = undefined;
	state.released = 0;
	state.witnessed = [];
	state.stackRead = [];
	state.startedIn = [];
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(state.root, { recursive: true, force: true });
});

describe("a council that waited for its start", () => {
	it("reviews the head the change moved to, and says so", async () => {
		state.during = () => state.heads.set(CHANGE, B);

		const answer = textOf(await council());

		expect(state.cuts, "a tree cut at each head").toEqual([A, B]);
		expect(state.witnessed, "the round reads the head now").toEqual([B]);
		expect(state.prompted, "and the diff there now").toEqual([A, B]);
		expect(state.startedIn).toEqual([state.trees[1]]);
		expect(answer).toContain(
			"While it waited, a head moved, so it reads what is there now: o/r#1 from aaaaaaaa to bbbbbbbb.",
		);
		expect(state.released, "the start it held is kept").toBe(0);
	});

	it("gives its start back when the moved head is refused", async () => {
		state.ledgerRefuses = B;
		state.during = () => state.heads.set(CHANGE, B);

		const answer = textOf(await council());

		expect(answer).toContain(`A council already read ${B}.`);
		expect(state.witnessed, "nothing started").toEqual([]);
		expect(state.released).toBe(1);
	});

	it("asks for its still tree again, dating it, and cuts no other", async () => {
		const answer = textOf(await council());

		expect(state.asks, "asked again after the wait").toEqual([A, A]);
		expect(state.cuts).toEqual([A]);
		expect(state.witnessed).toEqual([A]);
		expect(answer).not.toContain("While it waited,");
	});

	it("asks for nothing again when it didn't wait", async () => {
		state.noWait = true;
		state.during = () => state.heads.set(CHANGE, B);

		await council();

		expect(state.asks).toEqual([A]);
		expect(state.witnessed).toEqual([A]);
	});

	it("gives its start back when a council on its still head opened meanwhile", async () => {
		state.during = () => {
			state.ledgerRefuses = A;
		};

		const answer = textOf(await council());

		expect(answer).toContain(`A council already read ${A}.`);
		expect(state.witnessed, "nothing started").toEqual([]);
		expect(state.released).toBe(1);
	});

	it("reads the diff there now when its base moved under a still head", async () => {
		state.during = () => {
			state.base = "base1111";
		};

		const answer = textOf(await council());

		expect(state.prompted).toEqual([A, A]);
		expect(answer).toContain(
			"While it waited, a base moved, so it reads the diff there is now: o/r#1 from base0000 to base1111.",
		);
		expect(state.released).toBe(0);
	});

	it("gives its start back when the change can't be read again", async () => {
		state.during = () => {
			state.unreadable = true;
		};

		const answer = textOf(await council());

		expect(answer).toContain("couldn't be read again");
		expect(answer).toContain("The host didn't answer");
		expect(answer).toContain("ask again once the change reads");
		expect(state.witnessed).toEqual([]);
		expect(state.released).toBe(1);
	});

	it("gives its start back when building again throws", async () => {
		state.during = () => {
			state.lensBreaks = true;
		};

		const answer = textOf(await council());

		expect(answer).toContain("The repo's lens couldn't be read");
		expect(state.witnessed).toEqual([]);
		expect(state.released).toBe(1);
	});

	it("cuts its tree again when its folder went while it waited, and starts", async () => {
		state.during = () =>
			rmSync(state.trees[0] ?? "", { recursive: true, force: true });

		const answer = textOf(await council());

		expect(state.cuts).toEqual([A, A]);
		expect(state.startedIn, "its reviewers start in a folder there").toEqual([
			state.trees[1],
		]);
		expect(existsSync(state.startedIn[0] ?? "")).toBe(true);
		expect(state.witnessed).toEqual([A]);
		expect(answer).toContain(
			"While it waited, the tree it was to read was gone, so it was cut again.",
		);
		expect(state.released).toBe(0);
	});
});

describe("a stack round that waited for its start", () => {
	beforeEach(() => {
		state.stack = ["o/r#1", "o/r#2"];
		state.heads = new Map([
			["o/r#1", A],
			["o/r#2", C],
		]);
	});

	it("reviews the heads the stack moved to, and says so", async () => {
		state.during = () => state.heads.set("o/r#2", B);

		const answer = textOf(await stackRound());

		expect(state.cuts, "a tree cut at each tip").toEqual([C, B]);
		expect(state.stackSent, "the round records the heads now").toEqual([
			[A, B],
		]);
		expect(state.startedIn).toEqual([state.trees[1]]);
		expect(answer).toContain(
			"While it waited, a head moved, so it reads what is there now: o/r#2 from cccccccc to bbbbbbbb.",
		);
		expect(state.released).toBe(0);
	});

	it("reads a change that came into the stack while it waited", async () => {
		state.during = () => {
			state.stack.push("o/r#3");
			state.heads.set("o/r#3", B);
		};

		const answer = textOf(await stackRound());

		expect(state.cuts).toEqual([C, B]);
		expect(answer).toContain("o/r#3 came in at bbbbbbbb.");
	});

	it("reads the stack without a change that left it while it waited", async () => {
		state.during = () => {
			state.stack = ["o/r#2"];
		};

		const answer = textOf(await stackRound());

		expect(state.stackSent).toEqual([[C]]);
		expect(answer).toContain(
			"While it waited, a head moved, so it reads what is there now: o/r#1 left it.",
		);
	});

	it("gives its start back when building again throws", async () => {
		state.during = () => {
			state.lensBreaks = true;
		};

		const answer = textOf(await stackRound());

		expect(answer).toContain("The repo's lens couldn't be read");
		expect(state.startedIn).toEqual([]);
		expect(state.released).toBe(1);
	});

	it("gives its start back when the moved stack is refused", async () => {
		state.treeRefuses = B;
		state.during = () => state.heads.set("o/r#2", B);

		const answer = textOf(await stackRound());

		expect(answer).toContain(`No tree can be cut at ${B}.`);
		expect(state.startedIn, "nothing started").toEqual([]);
		expect(state.released).toBe(1);
	});

	it("asks for its still tree again, dating it, and cuts no other", async () => {
		const answer = textOf(await stackRound());

		expect(state.asks).toEqual([C, C]);
		expect(state.cuts).toEqual([C]);
		expect(state.startedIn).toEqual([state.trees[0]]);
		expect(answer).not.toContain("While it waited,");
	});

	it("reads again after its room went and it waited on the bars, reading a member pushed then", async () => {
		state.room = { place: { machine: "room-1" } };
		state.during = () => {
			state.room = undefined;
		};
		state.later = () => state.heads.set("o/r#2", B);

		const answer = textOf(await stackRound());

		expect(state.waits, "waited on the room, then on the bars").toBe(2);
		expect(state.asks, "the tree asked for after each wait").toEqual([C, C, B]);
		expect(state.cuts).toEqual([C, B]);
		expect(state.stackSent, "the round records the head now").toEqual([[A, B]]);
		expect(state.startedIn).toEqual([state.trees[1]]);
		expect(state.roomsGiven, "its reviewers run here").toEqual([undefined]);
		expect(answer).toContain(
			"While it waited, a head moved, so it reads what is there now: o/r#2 from cccccccc to bbbbbbbb.",
		);
		expect(state.released, "only the room's start given back").toBe(1);
	});

	it("gives its second start back when the stack is refused after it waited on the bars", async () => {
		state.room = { place: { machine: "room-1" } };
		state.treeRefuses = B;
		state.during = () => {
			state.room = undefined;
		};
		state.later = () => state.heads.set("o/r#2", B);

		const answer = textOf(await stackRound());

		expect(answer).toContain(`No tree can be cut at ${B}.`);
		expect(state.startedIn, "nothing started").toEqual([]);
		expect(state.released, "the room's start and the bars' one").toBe(2);
	});

	it("cuts its tree again when its folder went while it waited, and starts", async () => {
		state.during = () =>
			rmSync(state.trees[0] ?? "", { recursive: true, force: true });

		const answer = textOf(await stackRound());

		expect(state.cuts).toEqual([C, C]);
		expect(state.startedIn).toEqual([state.trees[1]]);
		expect(existsSync(state.startedIn[0] ?? "")).toBe(true);
		expect(answer).toContain(
			"While it waited, the tree it was to read was gone, so it was cut again.",
		);
		expect(state.released).toBe(0);
	});
});
