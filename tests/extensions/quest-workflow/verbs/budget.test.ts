/**
 * What a quest's budget does: the budget verb, what a quest keeps, what
 * a session is told and journals when a budget can't be drawn on, and
 * what a folder's provider answers.
 *
 * Long because every case shares one fixture, the quest store, the
 * registered providers and the session's journal, set up and torn down
 * around each; split by concern, each file would repeat it whole.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BUDGET_ASKED_AGAIN_MOST_MS,
	BUDGET_ASKED_AGAIN_MS,
	budgetEntryView,
	budgetOfFolder,
	keepQuestBudget,
	undrawable,
} from "../../../../extensions/quest-workflow/budget.ts";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import {
	emptyOverlay,
	processOverlay,
} from "../../../../lib/budget/environment.ts";
import {
	type BudgetAnswer,
	registerBudgetProvider,
} from "../../../../lib/budget/provider.ts";
import { BUDGET_SETTLED } from "../../../../lib/budget/record.ts";
import { parseQuestFrontMatter } from "../../../../lib/internal/quest/documents/frontmatter.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { createEnvGuard, journeyOf, refused, succeeded } from "../_helpers.ts";

let tmpRoot: string;
const kept: Record<string, string | undefined> = {};
const KEY = "BUDGET_TEST_KEY";

/** A bus as pi's: handlers by channel, called in order. */
function bus() {
	const handlers = new Map<string, ((data: unknown) => void)[]>();
	return {
		on(channel: string, handler: (data: unknown) => void) {
			handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
			return () => {};
		},
		emit(channel: string, data?: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
	};
}

/** The custom entries the session under test wrote, as its branch. */
let written: { type: string; customType: string; data: unknown }[] = [];

/**
 * What each pi in a test is handed, so that all of them append to the
 * one branch. The tool runs and the budget keeper are two parts of one
 * session, and the keeper reads back what was written.
 */
const intoTheBranch = {
	appendEntry: (customType: string, data?: unknown) => {
		written.push({ type: "custom", customType, data });
	},
};

/** What every keeper here is handed, so none writes to the machine's journal. */
const quiet = { journal: () => undefined };

/** The budgets the session's log says, in the order it said them. */
function recorded(): unknown[] {
	return written
		.filter((entry) => entry.customType === "budget")
		.map((entry) => entry.data);
}
function fakeCtx(cwd = tmpRoot) {
	return {
		cwd,
		sessionManager: { getSessionId: () => "s", isPersisted: () => true },
	} as unknown as Parameters<typeof handle>[2];
}

const envGuard = createEnvGuard();
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "budget-"));
	written = [];
	for (const key of [
		"HOME",
		"XDG_STATE_HOME",
		"PI_BUDGET",
		"PI_BUDGET_KEYS",
		KEY,
	])
		kept[key] = process.env[key];
	delete process.env.PI_BUDGET;
	delete process.env.PI_BUDGET_KEYS;
	process.env.HOME = tmpRoot;
	process.env.XDG_STATE_HOME = join(tmpRoot, "state");
	process.env[KEY] = "personal";
	Object.assign(processOverlay(), emptyOverlay());
	processOverlay().laid.clear();
});
afterEach(() => {
	processOverlay().laid.clear();
	for (const [key, value] of Object.entries(kept)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

async function quests() {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const run = (params: Parameters<typeof handle>[3]) =>
		handle(state, fakePi(intoTheBranch), fakeCtx(), params);
	succeeded(await run({ action: "create", title: "Delta Work" }));
	const top = state.questId as string;
	succeeded(
		await run({
			action: "create",
			title: "One Piece of It",
			kind: "subquest",
			parent: top,
		}),
	);
	const child = readdirSync(join(tmpRoot, "quests")).find(
		(id) => id !== top,
	) as string;
	return { state, run, top, child };
}

/** The quests with the top naming budget delta, and a keeper on a fresh bus. */
async function deltaKept() {
	const made = await quests();
	await made.run({ action: "budget", id: made.top, ref: "delta" });
	const events = bus();
	const keeper = keepQuestBudget(
		fakePi({ ...intoTheBranch, events }),
		made.state,
		quiet,
	);
	return { ...made, events, keeper };
}

/** A budget provider on the bus that answers each name with `resolve`. */
function provide(
	events: ReturnType<typeof bus>,
	id: string,
	resolve: Parameters<typeof registerBudgetProvider>[1]["resolve"],
): void {
	registerBudgetProvider(events, { id, precedence: 0, resolve });
}

function budgetIn(questsRoot: string, id: string): unknown {
	const readme = readFileSync(join(questsRoot, id, "README.md"), "utf8");
	return parseQuestFrontMatter(readme)?.frontMatter._extra?.budget;
}

describe("the budget verb", () => {
	it("names a quest's budget, journals it, and its subquests draw on it", async () => {
		const { state, run, top, child } = await quests();

		const named = succeeded(
			await run({ action: "budget", id: top, ref: "delta" }),
		);
		const inherited = succeeded(await run({ action: "budget", id: child }));

		expect(budgetIn(state.questsRoot, top)).toBe("delta");
		expect(named.message).toContain(`${top} draws on budget delta`);
		expect(inherited.message).toContain(
			`${child} draws on budget delta, as ${top} names`,
		);
		expect(journeyOf(join(state.questsRoot, top))).toContain("Budget: delta");
	});

	it("says none past the parent, and inherit takes the quest's own away", async () => {
		const { state, run, top, child } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });

		const none = succeeded(
			await run({ action: "budget", id: child, ref: "none" }),
		);
		expect(none.message).toContain("draws on no budget");

		succeeded(await run({ action: "budget", id: child, ref: "inherit" }));
		expect(budgetIn(state.questsRoot, child)).toBeUndefined();
	});

	it("refuses a name that could be a path, writing nothing", async () => {
		const { state, run, top } = await quests();
		const before = readFileSync(
			join(state.questsRoot, top, "README.md"),
			"utf8",
		);

		const result = refused(
			await run({ action: "budget", id: top, ref: "../keys" }),
		);

		expect(result.guidance).toContain("can't be a budget's name");
		expect(readFileSync(join(state.questsRoot, top, "README.md"), "utf8")).toBe(
			before,
		);
	});
});

describe("a quest made where a budget's work is", () => {
	/** Quest state with a keeper whose provider `id` names delta for `folder`. */
	function placed(folder: () => string, id = "places") {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const events = bus();
		keepQuestBudget(fakePi({ ...intoTheBranch, events }), state, quiet);
		registerBudgetProvider(events, {
			id,
			precedence: 0,
			resolve: async () => ({ kind: "unknown" }),
			budgetFor: async (asked) => (asked === folder() ? "delta" : undefined),
		});
		const run = (params: Parameters<typeof handle>[3]) =>
			handle(state, fakePi(intoTheBranch), fakeCtx(), params);
		return { state, run };
	}

	it("is born on that budget, and its first line says which", async () => {
		const { state, run } = placed(() => tmpRoot);

		const made = succeeded(
			await run({ action: "create", title: "An Incident" }),
		);

		const id = state.questId as string;
		expect(budgetIn(state.questsRoot, id)).toBe("delta");
		expect(made.message.split("\n")[0]).toContain(
			'drawing on budget delta, which "places" says',
		);
		expect(journeyOf(join(state.questsRoot, id))).toContain(
			`Budget: delta, which "places" says work in "${tmpRoot}" draws on`,
		);
	});

	it("quotes a provider whose id would break the line, in the first line and the Journey", async () => {
		const { state, run } = placed(() => tmpRoot, "two\nlines");

		const made = succeeded(
			await run({ action: "create", title: "An Incident" }),
		);

		const id = state.questId as string;
		expect(made.message.split("\n")[0]).toContain(
			'drawing on budget delta, which "two\\nlines" says',
		);
		expect(journeyOf(join(state.questsRoot, id))).toContain(
			'Budget: delta, which "two\\nlines" says work in',
		);
	});

	it("asks about a relative folder as the absolute one it names", async () => {
		const { state } = placed(() => process.cwd());

		succeeded(
			await handle(state, fakePi(intoTheBranch), fakeCtx("."), {
				action: "create",
				title: "Here",
			}),
		);

		expect(budgetIn(state.questsRoot, state.questId as string)).toBe("delta");
	});

	it("names a subquest whose ancestors name nothing for its folder too", async () => {
		const { state, run } = placed(() => "/elsewhere");
		succeeded(await run({ action: "create", title: "Unnamed" }));
		const top = state.questId as string;
		const here = placed(() => tmpRoot);

		const made = succeeded(
			await here.run({
				action: "create",
				title: "Under It",
				kind: "subquest",
				parent: top,
			}),
		);

		expect(budgetIn(state.questsRoot, made.details?.id as string)).toBe(
			"delta",
		);
		expect(budgetIn(state.questsRoot, top)).toBeUndefined();
	});

	it("quotes the folder in the Journey, so its name can't add a line", async () => {
		const odd = join(tmpRoot, "two\nlines");
		const { state } = placed(() => odd);
		const ctx = { ...fakeCtx(), cwd: odd } as Parameters<typeof handle>[2];

		succeeded(
			await handle(state, fakePi(intoTheBranch), ctx, {
				action: "create",
				title: "Odd",
			}),
		);

		const journey = journeyOf(join(state.questsRoot, state.questId as string));
		expect(journey).toContain(JSON.stringify(odd));
		expect(journey).not.toContain("\nlines");
	});

	it("keeps what a parent names, none included, rather than the folder's", async () => {
		const { state, run } = placed(() => "/elsewhere");
		succeeded(await run({ action: "create", title: "Personal" }));
		const top = state.questId as string;
		succeeded(await run({ action: "budget", id: top, ref: "none" }));
		const here = placed(() => tmpRoot);

		const made = succeeded(
			await here.run({
				action: "create",
				title: "Under It",
				kind: "subquest",
				parent: top,
			}),
		);

		const child = made.details?.id as string;
		expect(budgetIn(state.questsRoot, child)).toBeUndefined();
		expect(made.message).not.toContain("drawing on budget");
	});

	it("names nothing where no provider names the folder's budget", async () => {
		const { state, run } = placed(() => "/elsewhere");

		const made = succeeded(await run({ action: "create", title: "Mine" }));

		expect(budgetIn(state.questsRoot, state.questId as string)).toBeUndefined();
		expect(made.message).not.toContain("drawing on budget");
	});
});

describe("the session's budget", () => {
	function ui() {
		const notices: string[] = [];
		return {
			notices,
			ctx: {
				ui: {
					notify: (message: string) => notices.push(message),
					theme: { fg: (_colour: string, text: string) => text },
				},
				sessionManager: { getBranch: () => written },
			} as unknown as Parameters<ReturnType<typeof keepQuestBudget>["keep"]>[0],
		};
	}

	it("is the loaded quest's, laid over the environment and lifted on unload", async () => {
		const { run, child, events, keeper } = await deltaKept();
		const answers: Record<string, BudgetAnswer> = {
			delta: { kind: "drawn", env: { [KEY]: "team" }, label: "delta (dev)" },
		};
		provide(
			events,
			"test",
			async (name) => answers[name] ?? { kind: "unknown" },
		);
		const seen = ui();
		const settled: unknown[] = [];
		events.on(BUDGET_SETTLED, (data) => settled.push(data));

		await run({ action: "load", id: child });
		await keeper.keep(seen.ctx);
		expect(process.env[KEY], "the subquest draws on its parent's").toBe("team");
		expect(settled.at(-1), "the footer hears it").toEqual({ name: "delta" });

		await run({ action: "unload" });
		await keeper.keep(seen.ctx);
		expect(process.env[KEY], "the person's key is back").toBe("personal");
		expect(settled.at(-1)).toEqual({ name: null });
	});

	it("stays on the default and says why once when no provider knows the name", async () => {
		const { state, run, top } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		const keeper = keepQuestBudget(fakePi(intoTheBranch), state, quiet);
		const seen = ui();

		await run({ action: "load", id: top });
		await keeper.keep(seen.ctx);
		await keeper.keep(seen.ctx);

		expect(process.env[KEY]).toBe("personal");
		expect(seen.notices).toEqual([
			"No budget provider is installed, so budget delta means nothing yet; model calls use the session's default.",
		]);
	});

	it("makes a second keep wait on the draw already on its way", async () => {
		const { run, top, events, keeper } = await deltaKept();
		let answer: (value: BudgetAnswer) => void = () => {};
		provide(
			events,
			"slow",
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		await run({ action: "load", id: top });

		void keeper.keep(ui().ctx);
		const second = keeper.keep(ui().ctx);
		answer({ kind: "drawn", env: { [KEY]: "slow" }, label: "x" });
		await second;

		expect(process.env[KEY], "drawn by the time the second returns").toBe(
			"slow",
		);
	});

	it("takes the budget up once a provider registers late", async () => {
		const { run, top, events, keeper } = await deltaKept();
		await run({ action: "load", id: top });
		await keeper.keep(ui().ctx);

		provide(events, "late", async () => ({
			kind: "drawn",
			env: { [KEY]: "late" },
			label: "x",
		}));
		await new Promise((resolve) => setImmediate(resolve));

		expect(process.env[KEY]).toBe("late");
	});

	describe("after a reload", () => {
		const STALE =
			"This extension ctx is stale after session replacement or reload.";

		/** A context that throws on every read once its session is replaced, as pi's does. */
		function replaceable() {
			const live = ui().ctx;
			let stale = false;
			const read = <T>(value: T): T => {
				if (stale) throw new Error(STALE);
				return value;
			};
			const ctx = {
				get ui() {
					return read(live.ui);
				},
				get sessionManager() {
					return read(live.sessionManager);
				},
			} as unknown as typeof live;
			return {
				ctx,
				goStale: () => {
					stale = true;
				},
			};
		}

		it("drops an answer that lands after the session was replaced", async () => {
			const { run, top, events, keeper } = await deltaKept();
			let answer: (value: BudgetAnswer) => void = () => {};
			provide(
				events,
				"slow",
				() =>
					new Promise((resolve) => {
						answer = resolve;
					}),
			);
			await run({ action: "load", id: top });
			const session = replaceable();
			const entries = written.length;

			// As the ask at start, which nothing awaits, meets a reload.
			const asked = keeper.keep(session.ctx);
			keeper.forget();
			session.goStale();
			answer({ kind: "drawn", env: { [KEY]: "late" }, label: "x" });

			await expect(asked, "it read the replaced context").resolves.toBe(
				undefined,
			);
			expect(process.env[KEY], "the replaced load laid a budget").toBe(
				"personal",
			);
			expect(written.length, "the replaced load wrote to the log").toBe(
				entries,
			);
		});

		it("takes a session up again with its next keep", async () => {
			const { run, top, events, keeper } = await deltaKept();
			provide(events, "test", async () => ({
				kind: "drawn",
				env: { [KEY]: "team" },
				label: "x",
			}));
			await run({ action: "load", id: top });
			await keeper.keep(ui().ctx);

			keeper.forget();
			process.env[KEY] = "personal";
			await keeper.keep(ui().ctx);

			expect(process.env[KEY], "the same name was asked again").toBe("team");
		});
	});

	describe("once it couldn't be drawn on", () => {
		/** The quests with the top naming delta, kept on a clock the test turns. */
		async function onAClock() {
			const made = await quests();
			await made.run({ action: "budget", id: made.top, ref: "delta" });
			const events = bus();
			const clock = { at: 0 };
			const keeper = keepQuestBudget(
				fakePi({ ...intoTheBranch, events }),
				made.state,
				{ ...quiet, now: () => clock.at },
			);
			let answer: BudgetAnswer = {
				kind: "unavailable",
				reason: "It didn't answer within 5 s.",
			};
			let asked = 0;
			provide(events, "plane", async () => {
				asked++;
				return answer;
			});
			await made.run({ action: "load", id: made.top });
			return {
				keeper,
				clock,
				asked: () => asked,
				answers: (next: BudgetAnswer) => {
					answer = next;
				},
			};
		}

		it("asks again a while later, so a session missed at a reload ends on its budget", async () => {
			const { keeper, clock, answers } = await onAClock();
			await keeper.keep(ui().ctx);
			expect(process.env[KEY]).toBe("personal");

			answers({ kind: "drawn", env: { [KEY]: "team" }, label: "Delta" });
			clock.at += BUDGET_ASKED_AGAIN_MS;
			await keeper.keep(ui().ctx);

			expect(process.env[KEY], "the next turn draws on the quest's").toBe(
				"team",
			);
			expect(recorded().at(-1), "the log ends on the quest's").toMatchObject({
				name: "delta",
			});
		});

		it("is asked again at the next keep, as a restart's load passes", async () => {
			const { keeper, asked } = await onAClock();
			await keeper.keep(ui().ctx);
			await keeper.keep(ui().ctx);
			expect(asked()).toBe(2);
		});

		it("isn't asked again before the wait is out once a retry missed, so a provider that's down costs few turns", async () => {
			const { keeper, clock, asked } = await onAClock();
			await keeper.keep(ui().ctx);
			await keeper.keep(ui().ctx);
			clock.at += BUDGET_ASKED_AGAIN_MS - 1;
			await keeper.keep(ui().ctx);
			expect(asked()).toBe(2);

			clock.at += 1;
			await keeper.keep(ui().ctx);
			await keeper.keep(ui().ctx);
			expect(asked(), "once more, then waits again").toBe(3);

			clock.at += BUDGET_ASKED_AGAIN_MS;
			await keeper.keep(ui().ctx);
			expect(asked(), "the wait doubles once it misses again").toBe(3);
			clock.at += BUDGET_ASKED_AGAIN_MS;
			await keeper.keep(ui().ctx);
			expect(asked()).toBe(4);

			for (let miss = 0; miss < 5; miss++) {
				clock.at += BUDGET_ASKED_AGAIN_MOST_MS;
				await keeper.keep(ui().ctx);
			}
			expect(asked()).toBe(9);
			clock.at += BUDGET_ASKED_AGAIN_MOST_MS - 1;
			await keeper.keep(ui().ctx);
			expect(asked(), "the wait stops growing at its longest").toBe(9);
			clock.at += 1;
			await keeper.keep(ui().ctx);
			expect(asked()).toBe(10);
		});

		it("says nothing new when a retry misses again, though the provider's words change", async () => {
			const { keeper, clock, answers } = await onAClock();
			const seen = ui();
			await keeper.keep(seen.ctx);
			const entries = recorded().length;

			answers({ kind: "unavailable", reason: "It said something else." });
			clock.at += BUDGET_ASKED_AGAIN_MS;
			await keeper.keep(seen.ctx);

			expect(recorded().length, "no entry a minute").toBe(entries);
			expect(seen.notices).toHaveLength(1);
		});

		it("isn't asked again when the session was started on the quest's budget", async () => {
			process.env.PI_BUDGET = "delta";
			process.env.PI_BUDGET_KEYS = KEY;
			const { keeper, clock, asked } = await onAClock();
			await keeper.keep(ui().ctx);
			clock.at += BUDGET_ASKED_AGAIN_MS * 3;
			await keeper.keep(ui().ctx);
			expect(asked()).toBe(1);
		});

		it("is asked again when the session was started on the quest's budget's name without its keys", async () => {
			process.env.PI_BUDGET = "delta";
			delete process.env.PI_BUDGET_KEYS;
			const { keeper, clock, asked } = await onAClock();
			const seen = ui();
			await keeper.keep(seen.ctx);
			await keeper.keep(seen.ctx);
			clock.at += BUDGET_ASKED_AGAIN_MS;
			await keeper.keep(seen.ctx);
			expect(asked(), "the host's key bills a name with no keys").toBe(3);
			expect(seen.notices).toHaveLength(1);
		});

		it("keeps no control characters from a provider's words", () => {
			expect(
				undrawable("delta", {
					kind: "unavailable",
					provider: "plane",
					reason: "bad\u001b]0;owned\u0007 key",
				}),
			).not.toMatch(/\p{Cc}/u);
		});

		it("isn't asked again once it's drawn", async () => {
			const { keeper, clock, asked, answers } = await onAClock();
			answers({ kind: "drawn", env: { [KEY]: "team" }, label: "Delta" });
			await keeper.keep(ui().ctx);
			clock.at += BUDGET_ASKED_AGAIN_MS * 3;
			await keeper.keep(ui().ctx);
			expect(asked()).toBe(1);
		});

		it("asks once for a burst of keeps on one session, as its turns start at once", async () => {
			const { keeper, clock, asked } = await onAClock();
			await keeper.keep(ui().ctx);
			clock.at += BUDGET_ASKED_AGAIN_MS;

			const seen = ui();
			await Promise.all(
				Array.from({ length: 40 }, () => keeper.keep(seen.ctx)),
			);

			expect(asked(), "the one due, and no more while it's on its way").toBe(2);
		});

		it("says it couldn't be drawn on once, however often it's asked again", async () => {
			const { keeper, clock } = await onAClock();
			const seen = ui();
			for (let turn = 0; turn < 3; turn++) {
				await keeper.keep(seen.ctx);
				clock.at += BUDGET_ASKED_AGAIN_MS;
			}

			expect(seen.notices).toHaveLength(1);
		});
	});

	it("asks again when the budget is named again, as after writing its file", async () => {
		const { run, top, events, keeper } = await deltaKept();
		const answers: Record<string, BudgetAnswer> = {};
		provide(
			events,
			"files",
			async (name) => answers[name] ?? { kind: "unknown" },
		);
		await run({ action: "load", id: top });
		await keeper.keep(ui().ctx);
		await keeper.keep(ui().ctx);

		answers.delta = { kind: "drawn", env: { [KEY]: "file" }, label: "x" };
		await keeper.keep(ui().ctx);
		expect(
			process.env[KEY],
			"an unchanged name isn't asked on every tool call once retried",
		).toBe("personal");

		await run({ action: "budget", id: top, ref: "delta" });
		await keeper.keep(ui().ctx, { again: true });
		expect(process.env[KEY]).toBe("file");
	});
});

describe("the budget in the session's log", () => {
	function ctx() {
		return {
			ui: {
				notify: () => {},
				theme: { fg: (_colour: string, text: string) => text },
			},
			sessionManager: { getBranch: () => written },
		} as unknown as Parameters<ReturnType<typeof keepQuestBudget>["keep"]>[0];
	}

	it("says each budget drawn on once, and the default when it's put down", async () => {
		const { run, child, events, keeper } = await deltaKept();
		provide(events, "test", async (name) =>
			name === "delta"
				? { kind: "drawn", env: { [KEY]: "team" }, label: "Delta team" }
				: { kind: "unknown" },
		);

		await run({ action: "unload" });
		await keeper.keep(ctx());
		await run({ action: "load", id: child });
		await keeper.keep(ctx());
		await keeper.keep(ctx());
		await run({ action: "unload" });
		await keeper.keep(ctx());

		expect(recorded()).toEqual([
			{ v: 1, name: null },
			{ v: 1, name: "delta", label: "Delta team", provider: "test" },
			{ v: 1, name: null },
		]);
		expect(process.env.PI_BUDGET, "lifted with the budget").toBeUndefined();
	});

	it("says the default when the quest's budget can't be drawn on, and which it couldn't and why", async () => {
		const { state, run, top } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		const keeper = keepQuestBudget(fakePi(intoTheBranch), state, quiet);

		await run({ action: "load", id: top });
		await keeper.keep(ctx());
		await keeper.keep(ctx(), { again: true });

		expect(recorded(), "the session spends its default, once").toEqual([
			{
				v: 1,
				name: null,
				unresolved: {
					budget: "delta",
					missing: "no budget provider is installed",
				},
			},
		]);
	});

	it("says a provider's reason as what's missing when it can't draw on the name", async () => {
		const { run, top, events, keeper } = await deltaKept();
		provide(events, "vault", async () => ({
			kind: "unavailable",
			reason: "Its key file isn't there.",
		}));

		await run({ action: "load", id: top });
		await keeper.keep(ctx());

		expect(recorded()).toEqual([
			{
				v: 1,
				name: null,
				unresolved: {
					budget: "delta",
					missing: '"vault": "Its key file isn\'t there."',
				},
			},
		]);
	});

	it("says it again, in the log and the journal, when only what's missing changes on asking again", async () => {
		const { state, run, top } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		const events = bus();
		const lines: string[] = [];
		const keeper = keepQuestBudget(
			fakePi({ ...intoTheBranch, events }),
			state,
			{ journal: (line) => lines.push(line) },
		);
		await run({ action: "load", id: top });
		await keeper.keep(ctx());

		provide(events, "vault", async () => ({
			kind: "unavailable",
			reason: "Locked\nfor now.",
		}));
		await keeper.keep(ctx(), { again: true });

		expect(recorded().map((record) => JSON.stringify(record))).toEqual([
			expect.stringContaining("no budget provider is installed"),
			expect.stringContaining("Locked for now."),
		]);
		expect(lines).toEqual([
			expect.stringContaining("no budget provider is installed"),
			expect.stringContaining("Locked for now."),
		]);
	});

	it("says a provider's reason on one line in the notice", async () => {
		const { state, run, top } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		const events = bus();
		provide(events, "vault", async () => ({
			kind: "unavailable",
			reason: "Locked\nfor now.",
		}));
		const notices: string[] = [];
		const keeper = keepQuestBudget(
			fakePi({ ...intoTheBranch, events }),
			state,
			quiet,
		);
		const seen = {
			...ctx(),
			ui: { notify: (message: string) => notices.push(message) },
		} as unknown as ReturnType<typeof ctx>;

		await run({ action: "load", id: top });
		await keeper.keep(seen);

		expect(notices).toEqual([expect.stringContaining("Locked for now.")]);
		expect(notices[0]).not.toContain("\n");
	});

	it("says the default once a budget it missed gives way to none", async () => {
		const { run, top, keeper } = await deltaKept();
		await run({ action: "load", id: top });
		await keeper.keep(ctx());

		await run({ action: "unload" });
		await keeper.keep(ctx());

		expect(recorded()).toEqual([
			{
				v: 1,
				name: null,
				unresolved: {
					budget: "delta",
					missing: "no budget provider is installed",
				},
			},
			{ v: 1, name: null },
		]);
	});

	it("keeps a provider's words on one line and cut short", async () => {
		const { run, top, events, keeper } = await deltaKept();
		provide(events, "vault", async () => ({
			kind: "unavailable",
			reason: `first\nsecond ${"x".repeat(400)}`,
		}));

		await run({ action: "load", id: top });
		await keeper.keep(ctx());

		const missing = String(
			(recorded()[0] as { unresolved: { missing: string } }).unresolved.missing,
		);
		// Its break a space, and the first 200 characters of its words kept.
		const kept = `first second ${"x".repeat(400)}`.slice(0, 200);
		expect(missing).toBe(`"vault": ${JSON.stringify(`${kept} (cut short)`)}`);
	});

	it("keeps a provider's words whole at 200 characters", async () => {
		const { run, top, events, keeper } = await deltaKept();
		const words = "y".repeat(200);
		provide(events, "vault", async () => ({
			kind: "unavailable",
			reason: words,
		}));

		await run({ action: "load", id: top });
		await keeper.keep(ctx());

		expect(recorded()).toEqual([
			{
				v: 1,
				name: null,
				unresolved: { budget: "delta", missing: `"vault": "${words}"` },
			},
		]);
	});

	it("says a provider gave no reason, rather than fail, when its reason isn't words", async () => {
		const { run, top, events, keeper } = await deltaKept();
		provide(events, "vault", async () => ({
			kind: "unavailable",
			reason: 7 as unknown as string,
		}));

		await run({ action: "load", id: top });
		await keeper.keep(ctx());

		expect(recorded()).toEqual([
			{
				v: 1,
				name: null,
				unresolved: {
					budget: "delta",
					missing: '"vault": "(no reason given)"',
				},
			},
		]);
	});

	it("names the budget the session was started on as what model calls use, when it misses the quest's", async () => {
		const { state, run, top } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		process.env.PI_BUDGET = "aquifer";
		const lines: string[] = [];
		const notices: string[] = [];
		const keeper = keepQuestBudget(fakePi(intoTheBranch), state, {
			journal: (line) => lines.push(line),
		});
		const seen = {
			...ctx(),
			ui: { notify: (message: string) => notices.push(message) },
		} as unknown as ReturnType<typeof ctx>;

		await run({ action: "load", id: top });
		await keeper.keep(seen);

		const started = "budget aquifer, which this session was started on";
		expect(recorded()).toEqual([
			{
				v: 1,
				name: "aquifer",
				unresolved: {
					budget: "delta",
					missing: "no budget provider is installed",
				},
			},
		]);
		expect(lines).toEqual([
			expect.stringContaining(`model calls use ${started}`),
		]);
		expect(notices).toEqual([
			expect.stringContaining(`model calls use ${started}.`),
		]);
		const theme = { fg: (_colour: string, text: string) => text };
		expect(
			budgetEntryView(recorded()[0], theme)?.render(300).join("\n"),
		).toContain(`model calls use ${started}.`);
	});

	it("misses nothing when the session was started on the very budget the quest names", async () => {
		const { state, run, top } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		process.env.PI_BUDGET = "delta";
		process.env.PI_BUDGET_KEYS = KEY;
		const lines: string[] = [];
		const notices: string[] = [];
		const keeper = keepQuestBudget(fakePi(intoTheBranch), state, {
			journal: (line) => lines.push(line),
		});
		const seen = {
			...ctx(),
			ui: { notify: (message: string) => notices.push(message) },
		} as unknown as ReturnType<typeof ctx>;

		await run({ action: "load", id: top });
		await keeper.keep(seen);

		expect(recorded()).toEqual([{ v: 1, name: "delta" }]);
		expect(lines).toEqual([]);
		expect(notices).toEqual([]);
	});

	it("says it again when a resumed branch's default was its own word, not a budget it missed", async () => {
		const { state, run, top } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		written.push({
			type: "custom",
			customType: "budget",
			data: { v: 1, name: null },
		});
		const keeper = keepQuestBudget(fakePi(intoTheBranch), state, quiet);

		await run({ action: "load", id: top });
		await keeper.keep(ctx());

		expect(recorded().at(-1)).toEqual({
			v: 1,
			name: null,
			unresolved: {
				budget: "delta",
				missing: "no budget provider is installed",
			},
		});
		expect(recorded()).toHaveLength(2);
	});

	it("says the budget a session was started on when it lays none of its own", async () => {
		const { state } = await quests();
		process.env.PI_BUDGET = "aquifer";
		const keeper = keepQuestBudget(fakePi(intoTheBranch), state, quiet);

		await keeper.keep(ctx());

		expect(recorded()).toEqual([{ v: 1, name: "aquifer" }]);
	});

	it("draws a line in the session for a budget it missed, and nothing for one it drew", () => {
		const theme = { fg: (_colour: string, text: string) => text };
		const missed = budgetEntryView(
			{
				v: 1,
				name: null,
				unresolved: { budget: "delta", missing: "vault: no key." },
			},
			theme,
		);
		expect(missed?.render(200).join("\n")).toContain(
			"Budget delta isn't drawn on (vault: no key.)",
		);
		expect(
			budgetEntryView(
				{ v: 1, name: "delta", label: "d", provider: "p" },
				theme,
			),
		).toBeUndefined();
		expect(budgetEntryView({ v: 1, name: null }, theme)).toBeUndefined();
		expect(budgetEntryView("nonsense", theme)).toBeUndefined();
	});

	it("says nothing again when the branch already says it, as on a resume", async () => {
		const { state } = await quests();
		written.push({
			type: "custom",
			customType: "budget",
			data: { v: 1, name: null },
		});
		const keeper = keepQuestBudget(fakePi(intoTheBranch), state, quiet);

		await keeper.keep(ctx());

		expect(recorded()).toHaveLength(1);
	});
});

describe("why a budget can't be drawn on", () => {
	it("quotes each provider it names, so an id can't add a line", () => {
		const said = [
			undrawable("delta", {
				kind: "unavailable",
				provider: "a\nb",
				reason: "Locked.",
			}),
			undrawable("delta", { kind: "unknown", asked: ["a\nb", "c"] }),
		];
		expect(said).toEqual([
			expect.stringContaining('("a\\nb"): Locked.'),
			expect.stringContaining('(asked "a\\nb", "c")'),
		]);
		expect(said.join("").split("\n")).toHaveLength(1);
	});
});

describe("a budget that can't be drawn on, in the journal", () => {
	function ctx() {
		return {
			ui: {
				notify: () => {},
				theme: { fg: (_colour: string, text: string) => text },
			},
			sessionManager: { getBranch: () => written },
		} as unknown as Parameters<ReturnType<typeof keepQuestBudget>["keep"]>[0];
	}

	it("is a warning naming the budget and what's missing, once while it stays missed", async () => {
		const { state, run, top } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		const lines: string[] = [];
		const keeper = keepQuestBudget(fakePi(intoTheBranch), state, {
			journal: (line) => lines.push(line),
		});

		await run({ action: "load", id: top });
		await keeper.keep(ctx());
		// Asked again, so the second settles too and finds the log says it.
		await keeper.keep(ctx(), { again: true });

		expect(lines).toEqual([
			expect.stringContaining(
				`quest ${top} names budget delta, which can't be drawn on: no budget provider is installed`,
			),
		]);
	});

	it("goes on when the journal can't be written, saying it on the screen and in the log", async () => {
		const { state, run, top } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		const notices: string[] = [];
		const keeper = keepQuestBudget(fakePi(intoTheBranch), state, {
			journal: () => {
				throw new Error("the journal is shut");
			},
		});
		const seen = {
			...ctx(),
			ui: { notify: (message: string) => notices.push(message) },
		} as unknown as ReturnType<typeof ctx>;

		await run({ action: "load", id: top });
		await expect(keeper.keep(seen)).resolves.toBeUndefined();

		expect(notices).toHaveLength(1);
		expect(recorded()).toHaveLength(1);
	});

	// The late case is the host's alone, which says it the same way
	// (tests/lib/budget/host.test.ts); the keeper's deadline is pi's 5 s.
	it("says a provider that failed asked about a folder, and that its answer is passed over", async () => {
		const { state } = await quests();
		const lines: string[] = [];
		const events = bus();
		keepQuestBudget(fakePi({ ...intoTheBranch, events }), state, {
			journal: (line) => lines.push(line),
		});
		registerBudgetProvider(events, {
			id: "vault",
			precedence: 0,
			resolve: async () => ({ kind: "unknown" }),
			budgetFor: async () => {
				throw new Error("budgets.json isn't JSON");
			},
		});

		expect(await budgetOfFolder(state, "/src/delta")).toBeUndefined();

		expect(lines).toEqual([
			'budget provider "vault" couldn\'t say which budget "/src/delta" draws on, so its answer is passed over: "it failed: budgets.json isn\'t JSON"',
		]);
	});
});
