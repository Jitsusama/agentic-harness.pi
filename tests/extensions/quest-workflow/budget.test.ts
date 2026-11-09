import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keepQuestBudget } from "../../../extensions/quest-workflow/budget.ts";
import { createQuestState } from "../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../extensions/quest-workflow/transitions.ts";
import {
	emptyOverlay,
	processOverlay,
} from "../../../lib/budget/environment.ts";
import {
	type BudgetAnswer,
	registerBudgetProvider,
} from "../../../lib/budget/provider.ts";
import { BUDGET_SETTLED } from "../../../lib/budget/record.ts";
import { parseQuestFrontMatter } from "../../../lib/internal/quest/frontmatter.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { createEnvGuard, journeyOf, refused, succeeded } from "./_helpers.ts";

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

/** The budgets the session's log says, in the order it said them. */
function recorded(): unknown[] {
	return written
		.filter((entry) => entry.customType === "budget")
		.map((entry) => entry.data);
}
function fakeCtx() {
	return {
		cwd: tmpRoot,
		sessionManager: { getSessionId: () => "s", isPersisted: () => true },
	} as unknown as Parameters<typeof handle>[2];
}

const envGuard = createEnvGuard();
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "budget-"));
	written = [];
	for (const key of ["HOME", "XDG_STATE_HOME", "PI_BUDGET", KEY])
		kept[key] = process.env[key];
	delete process.env.PI_BUDGET;
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
		const { state, run, top, child } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		const events = bus();
		const keeper = keepQuestBudget(fakePi({ ...intoTheBranch, events }), state);
		const answers: Record<string, BudgetAnswer> = {
			delta: { kind: "drawn", env: { [KEY]: "team" }, label: "delta (dev)" },
		};
		registerBudgetProvider(events, {
			id: "test",
			precedence: 0,
			resolve: async (name) => answers[name] ?? { kind: "unknown" },
		});
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
		const keeper = keepQuestBudget(fakePi(intoTheBranch), state);
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
		const { state, run, top } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		const events = bus();
		const keeper = keepQuestBudget(fakePi({ ...intoTheBranch, events }), state);
		let answer: (value: BudgetAnswer) => void = () => {};
		registerBudgetProvider(events, {
			id: "slow",
			precedence: 0,
			resolve: () =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		});
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
		const { state, run, top } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		const events = bus();
		const keeper = keepQuestBudget(fakePi({ ...intoTheBranch, events }), state);
		await run({ action: "load", id: top });
		await keeper.keep(ui().ctx);

		registerBudgetProvider(events, {
			id: "late",
			precedence: 0,
			resolve: async () => ({
				kind: "drawn",
				env: { [KEY]: "late" },
				label: "x",
			}),
		});
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
			const { state, run, top } = await quests();
			await run({ action: "budget", id: top, ref: "delta" });
			const events = bus();
			const keeper = keepQuestBudget(
				fakePi({ ...intoTheBranch, events }),
				state,
			);
			let answer: (value: BudgetAnswer) => void = () => {};
			registerBudgetProvider(events, {
				id: "slow",
				precedence: 0,
				resolve: () =>
					new Promise((resolve) => {
						answer = resolve;
					}),
			});
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
			const { state, run, top } = await quests();
			await run({ action: "budget", id: top, ref: "delta" });
			const events = bus();
			const keeper = keepQuestBudget(
				fakePi({ ...intoTheBranch, events }),
				state,
			);
			registerBudgetProvider(events, {
				id: "test",
				precedence: 0,
				resolve: async () => ({
					kind: "drawn",
					env: { [KEY]: "team" },
					label: "x",
				}),
			});
			await run({ action: "load", id: top });
			await keeper.keep(ui().ctx);

			keeper.forget();
			process.env[KEY] = "personal";
			await keeper.keep(ui().ctx);

			expect(process.env[KEY], "the same name was asked again").toBe("team");
		});
	});

	it("asks again when the budget is named again, as after writing its file", async () => {
		const { state, run, top } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		const events = bus();
		const keeper = keepQuestBudget(fakePi({ ...intoTheBranch, events }), state);
		const answers: Record<string, BudgetAnswer> = {};
		registerBudgetProvider(events, {
			id: "files",
			precedence: 0,
			resolve: async (name) => answers[name] ?? { kind: "unknown" },
		});
		await run({ action: "load", id: top });
		await keeper.keep(ui().ctx);

		answers.delta = { kind: "drawn", env: { [KEY]: "file" }, label: "x" };
		await keeper.keep(ui().ctx);
		expect(
			process.env[KEY],
			"an unchanged name isn't asked on every tool call",
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
		const { state, run, top, child } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		const events = bus();
		const keeper = keepQuestBudget(fakePi({ ...intoTheBranch, events }), state);
		registerBudgetProvider(events, {
			id: "test",
			precedence: 0,
			resolve: async (name) =>
				name === "delta"
					? { kind: "drawn", env: { [KEY]: "team" }, label: "Delta team" }
					: { kind: "unknown" },
		});

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

	it("says the default when the quest's budget can't be drawn on", async () => {
		const { state, run, top } = await quests();
		await run({ action: "budget", id: top, ref: "delta" });
		const keeper = keepQuestBudget(fakePi(intoTheBranch), state);

		await run({ action: "load", id: top });
		await keeper.keep(ctx());

		expect(recorded(), "the session spends its default").toEqual([
			{ v: 1, name: null },
		]);
	});

	it("says the budget a session was started on when it lays none of its own", async () => {
		const { state } = await quests();
		process.env.PI_BUDGET = "aquifer";
		const keeper = keepQuestBudget(fakePi(intoTheBranch), state);

		await keeper.keep(ctx());

		expect(recorded()).toEqual([{ v: 1, name: "aquifer" }]);
	});

	it("says nothing again when the branch already says it, as on a resume", async () => {
		const { state } = await quests();
		written.push({
			type: "custom",
			customType: "budget",
			data: { v: 1, name: null },
		});
		const keeper = keepQuestBudget(fakePi(intoTheBranch), state);

		await keeper.keep(ctx());

		expect(recorded()).toHaveLength(1);
	});
});
