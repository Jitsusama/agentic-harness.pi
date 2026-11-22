/**
 * What a quest's budget does: the budget verb, the judging that names
 * one at create and in a sweep, what a quest keeps, what a session is
 * told and journals when a budget can't be drawn on, and what a
 * folder's provider answers.
 *
 * Long because every case shares one fixture, the quest store, the
 * registered providers and the session's journal, set up and torn down
 * around each; split by concern, each file would repeat it whole.
 */

import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BUDGET_ASKED_AGAIN_MOST_MS,
	BUDGET_ASKED_AGAIN_MS,
	budgetEntryView,
	budgetOfFolder,
	CAPPED_HOLD_MS,
	keepQuestBudget,
	LOOSE_PROMPT_WAIT_MS,
	undrawable,
} from "../../../../extensions/quest-workflow/budget.ts";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import { askBudgetWhenCapped } from "../../../../lib/budget/capped.ts";
import {
	emptyOverlay,
	processOverlay,
} from "../../../../lib/budget/environment.ts";
import {
	type BudgetAnswer,
	registerBudgetProvider,
} from "../../../../lib/budget/provider.ts";
import { BUDGET_ENTRY, BUDGET_SETTLED } from "../../../../lib/budget/record.ts";
import { automatedText } from "../../../../lib/internal/automated.ts";
import { parseQuestFrontMatter } from "../../../../lib/internal/quest/documents/frontmatter.ts";
import { isRecord } from "../../../../lib/internal/record.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { until } from "../../../support/until.ts";
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
		"PI_BUDGET_CLASSIFIER",
		"PI_BUDGET_OPTED_OUT",
		"PI_BUDGET_KEYS",
		KEY,
	])
		kept[key] = process.env[key];
	delete process.env.PI_BUDGET;
	delete process.env.PI_BUDGET_OPTED_OUT;
	delete process.env.PI_BUDGET_KEYS;
	// The person's own choice of classifier, or `off`, is not the tests'.
	delete process.env.PI_BUDGET_CLASSIFIER;
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

describe("a quest no folder or parent names a budget for", () => {
	/** What each judgement was handed, in order. */
	let asked: { work: unknown; state: unknown }[] = [];
	/** The whole work each judgement was handed, in order. */
	let handed: unknown[] = [];
	/** How many times a judgement looked for the session's classifier. */
	let lookups = 0;

	/**
	 * Quest state with a keeper whose provider judges every quest's work
	 * through the session's classifier, which answers `choice` at
	 * `confidence`; and a ctx whose registry serves Jev.
	 */
	function judged(
		given: string,
		sureness: number,
		options: {
			folder?: string;
			registry?: boolean;
			byTitle?: Record<string, readonly [string, number]>;
			/** Run as each judgement starts, to change things under it. */
			during?: (title: string) => void;
			signal?: AbortSignal;
		} = {},
	) {
		asked = [];
		handed = [];
		lookups = 0;
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const events = bus();
		keepQuestBudget(fakePi({ ...intoTheBranch, events }), state);
		registerBudgetProvider(events, {
			id: "judge",
			precedence: 0,
			resolve: async () => ({ kind: "unknown" }),
			budgetFor: async (folder) =>
				folder === options.folder ? "aquifer" : undefined,
			budgetForWork: async (work, classify) => {
				handed.push(work);
				options.during?.(work.title);
				const result = await classify({
					state: { title: work.title },
					questions: {},
				});
				const answer = result.answers.budget;
				if (answer?.type !== "choice") return undefined;
				return {
					name: answer.choice,
					why: `Jev judged it ${answer.choice}`,
					sure: answer.confidence >= 0.8,
				};
			},
		});
		const registry = {
			getAvailableOfType: async () => {
				lookups++;
				return [{ provider: "typesafe", id: "jev-latest" }];
			},
			classify: async (
				_model: unknown,
				context: { state: { title?: unknown } },
			) => {
				asked.push({ work: context.state, state: context.state });
				const [choice, confidence] = options.byTitle?.[
					String(context.state.title)
				] ?? [given, sureness];
				return {
					api: "typesafe-system-one",
					provider: "typesafe",
					model: "jev-latest",
					answers: {
						budget: {
							type: "choice",
							choice,
							probabilities: { [choice]: confidence },
							confidence,
						},
					},
					stopReason: "stop",
					timestamp: 0,
				};
			},
		};
		const ctx = {
			...fakeCtx(),
			...(options.registry === false ? {} : { modelRegistry: registry }),
		} as unknown as Parameters<typeof handle>[2];
		const run = (params: Parameters<typeof handle>[3]) =>
			handle(state, fakePi(intoTheBranch), ctx, params, options.signal);
		return { state, run };
	}

	/** Write `word` as quest `id`'s budget straight into its README. */
	function sayBudget(questsRoot: string, id: string, word: string) {
		const readme = join(questsRoot, id, "README.md");
		writeFileSync(
			readme,
			readFileSync(readme, "utf8").replace(/^---\n/, `---\nbudget: ${word}\n`),
		);
	}

	/** A top quest and a subquest under it, made with no classifier. */
	async function parentAndChild() {
		const plain = judged("none", 0, { registry: false });
		succeeded(await plain.run({ action: "create", title: "The Top" }));
		const top = plain.state.questId as string;
		const child = succeeded(
			await plain.run({
				action: "create",
				title: "The Child",
				kind: "subquest",
				parent: top,
			}),
		).details?.id as string;
		return { top, child };
	}

	it("is named for the budget a sure judgement of its work names, said in its first line and Journey", async () => {
		const { state, run } = judged("delta", 0.93);

		const made = succeeded(
			await run({
				action: "create",
				title: "Speed Up walgit Pack Writes",
				note: "Delta's git server.",
			}),
		);

		const id = state.questId as string;
		expect(budgetIn(state.questsRoot, id)).toBe("delta");
		expect(made.message.split("\n")[0]).toContain(
			'drawing on budget delta, which "judge" judged from its work: Jev judged it delta',
		);
		expect(journeyOf(join(state.questsRoot, id))).toContain(
			'Budget: delta, which "judge" judged from its work',
		);
		expect(asked).toEqual([
			{
				work: { title: "Speed Up walgit Pack Writes" },
				state: { title: "Speed Up walgit Pack Writes" },
			},
		]);
		expect(handed).toEqual([
			{
				title: "Speed Up walgit Pack Writes",
				summary: "Delta's git server.",
				folder: tmpRoot,
			},
		]);
	});

	it("names nothing on an unsure judgement, and says its best guess and that it was unsure", async () => {
		const { state, run } = judged("aquifer", 0.6);

		const made = succeeded(
			await run({ action: "create", title: "Something Vague" }),
		);

		const id = state.questId as string;
		expect(budgetIn(state.questsRoot, id)).toBeUndefined();
		expect(made.message.split("\n")[0]).toContain(
			'drawing on no budget, since "judge" was unsure (best guess aquifer',
		);
		expect(journeyOf(join(state.questsRoot, id))).toContain(
			'Budget: unsure, so none named. "judge"\'s best guess from its work is aquifer',
		);
	});

	it("names nothing on a sure judgement that it is the person's own, so its children still ask their folders", async () => {
		const { state, run } = judged("none", 0.97);

		const made = succeeded(
			await run({ action: "create", title: "Tune the Laptop's Fans" }),
		);

		const id = state.questId as string;
		expect(budgetIn(state.questsRoot, id)).toBeUndefined();
		expect(made.message.split("\n")[0]).toContain(
			'drawing on no budget, since "judge" judged it the person\'s own work',
		);
		expect(journeyOf(join(state.questsRoot, id))).toContain(
			'Budget: none named, since "judge" judged its work the person\'s own',
		);
	});

	it("takes its folder's budget without asking for a judgement", async () => {
		const { state, run } = judged("delta", 0.99, { folder: tmpRoot });

		succeeded(await run({ action: "create", title: "In Aquifer's Folder" }));

		expect(budgetIn(state.questsRoot, state.questId as string)).toBe("aquifer");
		expect(asked).toEqual([]);
	});

	it("asks for no judgement under a parent that names a budget, none included", async () => {
		const { state, run } = judged("delta", 0.99);
		succeeded(await run({ action: "create", title: "Personal" }));
		const top = state.questId as string;
		succeeded(await run({ action: "budget", id: top, ref: "none" }));
		asked = [];

		const made = succeeded(
			await run({
				action: "create",
				title: "Under It",
				kind: "subquest",
				parent: top,
			}),
		);

		expect(budgetIn(state.questsRoot, made.details?.id as string)).toBe(
			undefined,
		);
		expect(asked).toEqual([]);
	});

	it("draws on a parent named while it was judged, rather than on the judgement", async () => {
		const plain = judged("none", 0, { registry: false });
		succeeded(await plain.run({ action: "create", title: "The Top" }));
		const top = plain.state.questId as string;
		const { state, run } = judged("aquifer", 0.99, {
			during: () => sayBudget(plain.state.questsRoot, top, "delta"),
		});

		const made = succeeded(
			await run({
				action: "create",
				title: "Under It",
				kind: "subquest",
				parent: top,
			}),
		);

		const id = made.details?.id as string;
		expect(handed, "it was judged").toHaveLength(1);
		expect(budgetIn(state.questsRoot, id)).toBeUndefined();
		expect(made.message.split("\n")[0]).not.toContain("aquifer");
		expect(journeyOf(join(state.questsRoot, id))).not.toContain("Budget:");
	});

	it("takes neither its folder's budget nor a judgement under a parent whose word can't be read", async () => {
		const plain = judged("none", 0, { registry: false });
		succeeded(await plain.run({ action: "create", title: "The Top" }));
		const top = plain.state.questId as string;
		sayBudget(plain.state.questsRoot, top, '"two words"');
		const { state, run } = judged("delta", 0.99, { folder: tmpRoot });

		const made = succeeded(
			await run({
				action: "create",
				title: "Under It",
				kind: "subquest",
				parent: top,
			}),
		);

		expect(budgetIn(state.questsRoot, made.details?.id as string)).toBe(
			undefined,
		);
		expect(asked).toEqual([]);
	});

	describe("swept", () => {
		/** Quests made with no classifier, then a sweeper that has one. */
		async function unnamed() {
			const plain = judged("none", 0, { registry: false });
			succeeded(await plain.run({ action: "create", title: "Walgit Packs" }));
			const walgit = plain.state.questId as string;
			const made = (title: string, more = {}) =>
				plain
					.run({ action: "create", title, ...more })
					.then((result) => succeeded(result).details?.id as string);
			const fans = await made("Laptop Fans");
			const vague = await made("Something Vague");
			const sealed = await made("Old Delta Work");
			succeeded(await plain.run({ action: "conclude", id: sealed }));
			const mine = await made("Mine");
			succeeded(await plain.run({ action: "budget", id: mine, ref: "none" }));
			const under = await made("Delta Under Mine", {
				kind: "subquest",
				parent: mine,
			});
			const sweeper = judged("none", 0, {
				byTitle: {
					"Walgit Packs": ["delta", 0.95],
					"Laptop Fans": ["none", 0.9],
					"Something Vague": ["aquifer", 0.5],
					"Old Delta Work": ["delta", 0.99],
					"Delta Under Mine": ["delta", 0.99],
				},
			});
			return { ...sweeper, walgit, fans, vague, sealed, under };
		}

		it("names each live quest nothing names a budget for that a sure judgement names, and says the rest", async () => {
			const { state, run, walgit, fans, vague, sealed, under } =
				await unnamed();

			const swept = succeeded(await run({ action: "budget-sweep" }));

			expect(budgetIn(state.questsRoot, walgit)).toBe("delta");
			for (const id of [fans, vague, sealed, under]) {
				expect(budgetIn(state.questsRoot, id), id).toBeUndefined();
			}
			const titles = asked.map((one) => one.state);
			expect(titles).not.toContainEqual({ title: "Old Delta Work" });
			expect(titles).not.toContainEqual({ title: "Delta Under Mine" });
			expect(swept.message.split("\n")[0]).toBe(
				"Swept 3 live quests drawing on no budget: 1 named, 1 judged personal, 1 unsure, 0 unjudged.",
			);
			expect(swept.message).toContain(`- ${walgit}: delta, judged by "judge"`);
			expect(swept.message).toContain(`- ${vague}: best guess aquifer`);
			expect(swept.message).toContain(`Judged personal: ${fans}.`);
			expect(journeyOf(join(state.questsRoot, vague))).toContain(
				"Budget: unsure, so none named.",
			);
		});

		it("says its judging bills the budget the sweeping session draws on", async () => {
			const { run } = await unnamed();
			process.env.PI_BUDGET = "aquifer";

			const swept = succeeded(await run({ action: "budget-sweep" }));

			expect(swept.message.split("\n")[1]).toBe(
				"Its judging bills what this session draws on: budget aquifer.",
			);
			expect(swept.details?.judgingBills).toBe("aquifer");
		});

		it("says its judging bills the person's own key when the session draws on none", async () => {
			const { run } = await unnamed();

			const swept = succeeded(
				await run({ action: "budget-sweep", dryRun: true }),
			);

			expect(swept.message).toContain(
				"Its judging bills what this session draws on: the person's own key.",
			);
			expect(swept.details?.judgingBills).toBeNull();
		});

		it("writes nothing on a dry run, saying what it would name", async () => {
			const { state, run, walgit, vague } = await unnamed();

			const swept = succeeded(
				await run({ action: "budget-sweep", dryRun: true }),
			);

			expect(budgetIn(state.questsRoot, walgit)).toBeUndefined();
			expect(swept.message).toContain("Dry run, nothing written.");
			expect(swept.message).toContain("Would name:");
			expect(journeyOf(join(state.questsRoot, vague))).not.toContain("unsure");
		});

		it("leaves a subquest to the budget it names its parent, judging only the parent", async () => {
			const plain = judged("none", 0, { registry: false });
			succeeded(await plain.run({ action: "create", title: "Delta Top" }));
			const top = plain.state.questId as string;
			const child = succeeded(
				await plain.run({
					action: "create",
					title: "Delta Child",
					kind: "subquest",
					parent: top,
				}),
			).details?.id as string;
			const { state, run } = judged("delta", 0.95);

			const dry = succeeded(
				await run({ action: "budget-sweep", dryRun: true }),
			);
			expect(dry.message).toContain(
				`Would be left to draw on a parent's: ${child} (by ${top}).`,
			);
			asked = [];
			const swept = succeeded(await run({ action: "budget-sweep" }));

			expect(budgetIn(state.questsRoot, top)).toBe("delta");
			expect(budgetIn(state.questsRoot, child)).toBeUndefined();
			expect(asked.map((one) => one.state)).toEqual([{ title: "Delta Top" }]);
			expect(swept.message).toContain("1 left to a parent");
		});

		it("judges a quest already journaled personal or unsure only once", async () => {
			const { run, fans, vague } = await unnamed();
			succeeded(await run({ action: "budget-sweep" }));
			asked = [];

			const again = succeeded(await run({ action: "budget-sweep" }));

			const titles = asked.map((one) => one.state);
			expect(titles).not.toContainEqual({ title: "Laptop Fans" });
			expect(titles).not.toContainEqual({ title: "Something Vague" });
			expect(again.message).toContain(
				"Already journaled personal or unsure, and no folder names a budget, so not judged again:",
			);
			expect(again.message).toContain(fans);
			expect(again.message).toContain(vague);
		});

		it("still names a quest journaled personal or unsure its folder's budget, without judging it", async () => {
			const plain = judged("none", 0, { registry: false });
			succeeded(await plain.run({ action: "create", title: "Laptop Fans" }));
			const fans = plain.state.questId as string;
			succeeded(await judged("none", 0.9).run({ action: "budget-sweep" }));
			expect(journeyOf(join(plain.state.questsRoot, fans))).toContain(
				"Budget: none named",
			);
			const { state, run } = judged("delta", 0.99, { folder: tmpRoot });

			succeeded(await run({ action: "budget-sweep" }));

			expect(budgetIn(state.questsRoot, fans)).toBe("aquifer");
			expect(asked, "nothing judged again").toEqual([]);
		});

		it("leaves alone a quest whose own budget word can't be read", async () => {
			const plain = judged("none", 0, { registry: false });
			succeeded(await plain.run({ action: "create", title: "Typo" }));
			const id = plain.state.questId as string;
			const readme = join(plain.state.questsRoot, id, "README.md");
			writeFileSync(
				readme,
				readFileSync(readme, "utf8").replace(
					/^---\n/,
					'---\nbudget: "two words"\n',
				),
			);
			const { state, run } = judged("delta", 0.99);

			const swept = succeeded(await run({ action: "budget-sweep" }));

			expect(asked).toEqual([]);
			expect(
				parseQuestFrontMatter(
					readFileSync(join(state.questsRoot, id, "README.md"), "utf8"),
				)?.frontMatter._extra?.budget,
			).toBe("two words");
			expect(swept.message).toContain(`can't be read, so left alone: ${id}.`);
		});

		it("leaves alone a subquest whose parent's budget word can't be read", async () => {
			const { top, child } = await parentAndChild();
			sayBudget(join(tmpRoot, "quests"), top, '"two words"');
			const { state, run } = judged("delta", 0.99);

			const swept = succeeded(await run({ action: "budget-sweep" }));

			expect(asked).toEqual([]);
			expect(budgetIn(state.questsRoot, child)).toBeUndefined();
			const [, alone] = swept.message.split("so left alone: ");
			expect(alone).toContain(top);
			expect(alone).toContain(child);
		});

		it("leaves a quest named while it was judged as it was named", async () => {
			const plain = judged("none", 0, { registry: false });
			succeeded(
				await plain.run({ action: "create", title: "Named Meanwhile" }),
			);
			const id = plain.state.questId as string;
			const { state, run } = judged("delta", 0.99, {
				during: () => sayBudget(plain.state.questsRoot, id, "aquifer"),
			});

			const swept = succeeded(await run({ action: "budget-sweep" }));

			expect(budgetIn(state.questsRoot, id)).toBe("aquifer");
			expect(swept.message).toContain(`- ${id}: it was named in between`);
			expect(journeyOf(join(state.questsRoot, id))).not.toContain("Budget:");
		});

		it("says the quests a stopped sweep never judged as not reached", async () => {
			const plain = judged("none", 0, { registry: false });
			for (const title of ["One", "Two", "Three", "Four", "Five", "Six"]) {
				succeeded(await plain.run({ action: "create", title }));
			}
			const stop = new AbortController();
			const { run } = judged("delta", 0.99, {
				during: () => stop.abort(),
				signal: stop.signal,
			});

			const swept = succeeded(await run({ action: "budget-sweep" }));

			expect(swept.message.split("\n")[0]).toBe(
				"Swept 6 live quests drawing on no budget: 0 named, 0 judged personal, 0 unsure, 0 unjudged, 6 not reached.",
			);
			expect(handed, "judged until the stop").toHaveLength(1);
			expect(
				lookups,
				"a classifier looked up only for the judgement a provider classified",
			).toBe(1);
		});

		it("leaves a quest's updated date as it was when it names its budget", async () => {
			const plain = judged("none", 0, { registry: false });
			succeeded(await plain.run({ action: "create", title: "Old Work" }));
			const id = plain.state.questId as string;
			const readme = join(plain.state.questsRoot, id, "README.md");
			writeFileSync(
				readme,
				readFileSync(readme, "utf8").replace(
					/^updated: .*$/m,
					"updated: 2026-01-02",
				),
			);
			const { state, run } = judged("delta", 0.99);

			succeeded(await run({ action: "budget-sweep" }));

			expect(budgetIn(state.questsRoot, id)).toBe("delta");
			expect(readFileSync(readme, "utf8")).toMatch(/^updated: 2026-01-02$/m);
		});

		it("judges a quest whose summary only quotes what a judgement journals", async () => {
			const plain = judged("none", 0, { registry: false });
			succeeded(
				await plain.run({
					action: "create",
					title: "Quoting",
					note: "Budget: unsure, so none named. is what a sweep journals.",
				}),
			);
			const id = plain.state.questId as string;
			const { state, run } = judged("delta", 0.99);

			succeeded(await run({ action: "budget-sweep" }));

			expect(budgetIn(state.questsRoot, id)).toBe("delta");
			expect(handed).toEqual([
				{
					title: "Quoting",
					summary: "Budget: unsure, so none named. is what a sweep journals.",
					folder: tmpRoot,
				},
			]);
		});

		it("takes a quest's budget from the folder its session ran in before judging it", async () => {
			const plain = judged("none", 0, { registry: false });
			succeeded(await plain.run({ action: "create", title: "Here" }));
			const id = plain.state.questId as string;
			const { state, run } = judged("delta", 0.99, { folder: tmpRoot });

			succeeded(await run({ action: "budget-sweep" }));

			expect(budgetIn(state.questsRoot, id)).toBe("aquifer");
		});
	});

	it("is made unjudged when the session has no classifier, saying nothing of a budget", async () => {
		const { state, run } = judged("delta", 0.99, { registry: false });

		const made = succeeded(
			await run({ action: "create", title: "Speed Up walgit" }),
		);

		expect(budgetIn(state.questsRoot, state.questId as string)).toBe(undefined);
		expect(made.message).not.toContain("budget");
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

		it("draws on it once a provider late for its deadline answers, with no keep and no wait", async () => {
			// A host too busy to read a file in time, as every hosted session
			// reloading at once makes it: each answer comes past the deadline.
			const made = await quests();
			await made.run({ action: "budget", id: made.top, ref: "delta" });
			const events = bus();
			const keeper = keepQuestBudget(
				fakePi({ ...intoTheBranch, events }),
				made.state,
				{ ...quiet, now: () => 0, answerDeadlineMs: 20 },
			);
			provide(events, "plane", async () => {
				// Long past the deadline, however loaded the machine.
				await new Promise((done) => setTimeout(done, 400));
				return { kind: "drawn", env: { [KEY]: "team" }, label: "Delta" };
			});
			await made.run({ action: "load", id: made.top });
			const seen = ui();
			await keeper.keep(seen.ctx);
			expect(process.env[KEY], "the deadline passed first").toBe("personal");

			await vi.waitFor(
				() =>
					expect(process.env[KEY], "the late answer is drawn on").toBe("team"),
				{ timeout: 5_000, interval: 10 },
			);
			const last = recorded().at(-1);
			expect(last, "the log ends on the quest's").toEqual(
				expect.objectContaining({ name: "delta", provider: "plane" }),
			);
			expect(
				isRecord(last) && "unresolved" in last,
				"the log's last entry says nothing was missed",
			).toBe(false);
			expect(
				seen.notices.at(-1),
				"the person, told calls used the fallback, is told that ended",
			).toBe(
				"Budget delta can be drawn on now, so model calls draw on it again.",
			);
		});

		it("lifts a budget whose token is refused late, saying the provider's reason", async () => {
			const made = await quests();
			await made.run({ action: "budget", id: made.top, ref: "delta" });
			const events = bus();
			const keeper = keepQuestBudget(
				fakePi({ ...intoTheBranch, events }),
				made.state,
				{ ...quiet, now: () => 0, answerDeadlineMs: 20 },
			);
			let slow = false;
			provide(events, "plane", async () => {
				if (!slow)
					return { kind: "drawn", env: { [KEY]: "team" }, label: "Delta" };
				// Long past the deadline, however loaded the machine.
				await new Promise((done) => setTimeout(done, 400));
				return { kind: "unavailable", reason: "The token was taken away." };
			});
			await made.run({ action: "load", id: made.top });
			const seen = ui();
			await keeper.keep(seen.ctx);
			expect(process.env[KEY], "drawn on in time").toBe("team");

			slow = true;
			await keeper.keep(seen.ctx, { again: true });
			expect(process.env[KEY], "the last drawing stands in").toBe("team");

			await vi.waitFor(
				() =>
					expect(process.env[KEY], "the refused token is lifted").toBe(
						"personal",
					),
				{ timeout: 5_000, interval: 10 },
			);
			expect(
				seen.notices.at(-1),
				"the notice gives the provider's reason, not a missed deadline",
			).toContain("The token was taken away.");
		});

		it("lays no late answer once its session is forgotten", async () => {
			const made = await quests();
			await made.run({ action: "budget", id: made.top, ref: "delta" });
			const events = bus();
			const keeper = keepQuestBudget(
				fakePi({ ...intoTheBranch, events }),
				made.state,
				{ ...quiet, now: () => 0, answerDeadlineMs: 20 },
			);
			let answered = 0;
			provide(events, "plane", async () => {
				// Long past the deadline, however loaded the machine.
				await new Promise((done) => setTimeout(done, 400));
				answered++;
				return { kind: "drawn", env: { [KEY]: "team" }, label: "Delta" };
			});
			await made.run({ action: "load", id: made.top });
			await keeper.keep(ui().ctx);

			keeper.forget();
			await vi.waitFor(() => expect(answered, "the late answer came").toBe(1), {
				timeout: 5_000,
				interval: 10,
			});
			// A lay reads the quest from disk after the answer comes, and no
			// event marks one not happening, so this waits well past one.
			await new Promise((settle) => setTimeout(settle, 500));

			expect(process.env[KEY], "nothing laid for a session gone").toBe(
				"personal",
			);
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

	describe("when the person's own key is over its cap", () => {
		const REFUSED = "403 Personal token usage is over your weekly cap";

		/**
		 * A keeper on a quest that names `quest` or no budget, with `named`
		 * for a capped key: a name, or what the setting reads as.
		 */
		async function capped(
			named?: string | { name?: string; unreadable?: string },
			quest?: string,
		) {
			const made = await quests();
			if (quest) await made.run({ action: "budget", id: made.top, ref: quest });
			const events = bus();
			// The wall clock apart from the one that only runs while the machine
			// is awake, as a suspend leaves them.
			const clock = { at: 0, wall: 0 };
			const lines: string[] = [];
			const keeper = keepQuestBudget(
				fakePi({ ...intoTheBranch, events }),
				made.state,
				{
					journal: (line) => lines.push(line),
					now: () => clock.at,
					wallNow: () => clock.at + clock.wall,
					...(named === undefined
						? {}
						: {
								whenCapped: async () =>
									typeof named === "string" ? { name: named } : named,
							}),
				},
			);
			provide(events, "plane", async (name) =>
				name === "worldtree" || name === quest
					? { kind: "drawn", env: { [KEY]: name }, label: name }
					: { kind: "unknown" },
			);
			await made.run({ action: "load", id: made.top });
			const seen = ui();
			await keeper.keep(seen.ctx);
			return {
				keeper,
				clock,
				lines,
				seen,
				name: (ref: string) =>
					made.run({ action: "budget", id: made.top, ref }),
				ask: () => askBudgetWhenCapped(events, REFUSED),
			};
		}

		it("moves the session onto the budget named for it, saying why in the log", async () => {
			const { ask, seen, lines } = await capped("worldtree");

			await expect(ask()).resolves.toBe("worldtree");

			expect(process.env[KEY]).toBe("worldtree");
			expect(recorded().at(-1)).toEqual({
				v: 1,
				name: "worldtree",
				label: "worldtree",
				provider: "plane",
				because: `the person's own key is over its cap: ${JSON.stringify(REFUSED)}`,
			});
			expect(seen.notices).toEqual([
				expect.stringContaining("draw on budget worldtree"),
			]);
			expect(lines).toEqual([
				expect.stringContaining("moves to budget worldtree"),
			]);
		});

		it("moves a session on a quest whose budget is none for the hour, then lays none again", async () => {
			const { ask, keeper, clock, seen } = await capped("worldtree", "none");
			expect(process.env.PI_BUDGET_OPTED_OUT).toBe("1");

			await expect(ask()).resolves.toBe("worldtree");
			await keeper.keep(seen.ctx);
			expect(process.env[KEY], "through its next turn").toBe("worldtree");

			clock.at += CAPPED_HOLD_MS;
			await keeper.keep(seen.ctx);
			expect(process.env[KEY]).toBe("personal");
			expect(process.env.PI_BUDGET_OPTED_OUT).toBe("1");
		});

		it("moves it once, since a session on a budget isn't on the person's key", async () => {
			const { ask, seen } = await capped("worldtree");
			await ask();

			await expect(ask()).resolves.toBe(null);
			expect(seen.notices).toHaveLength(1);
			expect(
				recorded().filter((said) => JSON.stringify(said).includes("because")),
			).toHaveLength(1);
		});

		it("moves it nowhere when no budget is named for it", async () => {
			for (const setting of [undefined, {}]) {
				const { ask } = await capped(setting);

				await expect(ask()).resolves.toBe(null);
				expect(process.env[KEY]).toBe("personal");
			}
		});

		it("moves it nowhere, saying why in the journal, when the setting can't be read", async () => {
			const { ask, lines } = await capped({ unreadable: "bad JSON" });

			await expect(ask()).resolves.toBe(null);
			expect(process.env[KEY]).toBe("personal");
			expect(lines).toEqual([
				expect.stringContaining('can\'t be read: "bad JSON"'),
			]);
		});

		it("keeps it there through a quest whose budget can't be drawn on", async () => {
			const { ask, keeper, seen, name } = await capped("worldtree");
			await ask();

			await name("nowhere");
			await keeper.keep(seen.ctx, { again: true });

			expect(process.env[KEY], "the miss lifted the capped key's budget").toBe(
				"worldtree",
			);
		});

		it("tells the session once, however often the cap moves it", async () => {
			const { ask, keeper, clock, seen } = await capped("worldtree");
			await ask();
			clock.at += CAPPED_HOLD_MS;
			await keeper.keep(seen.ctx);

			await expect(ask()).resolves.toBe("worldtree");
			expect(seen.notices).toHaveLength(1);
		});

		it("moves it nowhere when its quest's budget is drawn on", async () => {
			const { ask } = await capped("worldtree", "delta");

			await expect(ask()).resolves.toBe(null);
			expect(process.env[KEY]).toBe("delta");
		});

		it("moves it nowhere, saying why in the journal, when the named budget can't be drawn on", async () => {
			const { ask, lines } = await capped("nowhere");

			await expect(ask()).resolves.toBe(null);
			expect(process.env[KEY]).toBe("personal");
			expect(lines).toEqual([
				expect.stringContaining("can't move to budget nowhere"),
			]);
		});

		it("keeps it there for the hour, through a quest that names none being asked again", async () => {
			const { ask, keeper, clock, seen } = await capped("worldtree");
			await ask();

			clock.at += CAPPED_HOLD_MS - 1;
			await keeper.keep(seen.ctx, { again: true });

			expect(process.env[KEY]).toBe("worldtree");
		});

		it("counts the hour by the wall clock, so a suspend through it ends the move", async () => {
			const { ask, keeper, clock, seen } = await capped("worldtree");
			await ask();

			clock.wall += CAPPED_HOLD_MS;
			await keeper.keep(seen.ctx);

			expect(process.env[KEY]).toBe("personal");
		});

		it("says the move is over once the hour is out, though its quest's budget is still missed", async () => {
			const { ask, keeper, clock, seen, name } = await capped("worldtree");
			await ask();
			await name("nowhere");
			await keeper.keep(seen.ctx, { again: true });

			clock.at += CAPPED_HOLD_MS;
			await keeper.keep(seen.ctx);

			expect(process.env[KEY]).toBe("personal");
			expect(
				JSON.stringify(recorded().at(-1)),
				"the log still says calls draw on the cap's budget",
			).not.toContain("worldtree");
		});

		it("puts it back on the person's key once the hour is out", async () => {
			const { ask, keeper, clock, seen } = await capped("worldtree");
			await ask();

			clock.at += CAPPED_HOLD_MS;
			await keeper.keep(seen.ctx);

			expect(process.env[KEY]).toBe("personal");
			expect(recorded().at(-1)).toEqual({ v: 1, name: null });
			await expect(ask(), "a cap still refusing moves it again").resolves.toBe(
				"worldtree",
			);
		});
	});
});

describe("the budget of a session on no quest", () => {
	/**
	 * A keeper on no quest whose provider draws delta and aquifer, names
	 * aquifer for `folder`, and judges a prompt at `confidence`, kept as
	 * `options` say; and a session's ctx in tmpRoot whose registry serves
	 * Jev.
	 */
	function loose(
		folder: string | undefined,
		choice: string,
		confidence = 0.9,
		options: Parameters<typeof keepQuestBudget>[2] = {},
		/** Held until it settles, as a judgement on a busy host. */
		judging: Promise<unknown> = Promise.resolve(),
		/** Held until it settles, as a folder's provider on a busy host. */
		answering: Promise<unknown> = Promise.resolve(),
	) {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const events = bus();
		const keeper = keepQuestBudget(
			fakePi({ ...intoTheBranch, events }),
			state,
			{ ...quiet, ...options },
		);
		const judged: unknown[] = [];
		registerBudgetProvider(events, {
			id: "judge",
			precedence: 0,
			resolve: async (name) =>
				name === "delta" || name === "aquifer"
					? { kind: "drawn", env: { [KEY]: name }, label: name }
					: { kind: "unknown" },
			budgetFor: async (asked) => {
				await answering;
				return asked === folder ? "aquifer" : undefined;
			},
			budgetForWork: async (work, classify) => {
				judged.push(work);
				await classify({ state: {}, questions: {} });
				await judging;
				return { name: choice, why: "its prompt", sure: confidence >= 0.8 };
			},
		});
		const notices: string[] = [];
		// Bound as the host binds a conversation: RPC, with no screen.
		const ctx = {
			cwd: tmpRoot,
			mode: "rpc",
			hasUI: false,
			ui: { notify: (message: string) => notices.push(message) },
			sessionManager: { getBranch: () => written },
			modelRegistry: {
				getAvailableOfType: async () => [
					{ provider: "typesafe", id: "jev-latest" },
				],
				classify: async () => ({ answers: {} }),
			},
		} as unknown as Parameters<typeof keeper.keep>[0];
		return { state, keeper, ctx, judged, notices, events };
	}

	it("draws on the budget its folder's work draws on, without a judgement", async () => {
		const { keeper, ctx, judged, notices } = loose(tmpRoot, "delta");

		await keeper.keep(ctx);
		await keeper.keep(ctx, { prompt: "fix walgit" });

		expect(process.env[KEY]).toBe("aquifer");
		expect(judged).toEqual([]);
		expect(notices).toEqual([
			`This session is on no quest, so it draws on budget aquifer, which "judge" says work in ${JSON.stringify(tmpRoot)} draws on.`,
		]);
	});

	it("draws on what a sure judgement of its folder and first prompt names, asked once", async () => {
		const { keeper, ctx, judged, notices } = loose(undefined, "delta");

		await keeper.keep(ctx);
		expect(process.env[KEY], "nothing before its first prompt").toBe(
			"personal",
		);
		await keeper.keep(ctx, { prompt: "Speed up walgit's pack writes" });
		await keeper.keep(ctx, { prompt: "and another thing" });

		expect(process.env[KEY]).toBe("delta");
		expect(judged).toEqual([
			{
				title: tmpRoot,
				folder: tmpRoot,
				prompt: "Speed up walgit's pack writes",
			},
		]);
		expect(notices).toEqual([
			'This session is on no quest, so it draws on budget delta, which "judge" judged from its folder and first prompt: its prompt.',
		]);
	});

	it("lets its first prompt go on unjudged past the wait, and draws on the judgement as it lands", async () => {
		let land = () => {};
		const judging = new Promise<void>((settle) => {
			land = settle;
		});
		const { keeper, ctx, judged, notices } = loose(
			undefined,
			"delta",
			0.9,
			{ looseWaitMs: 20 },
			judging,
		);

		await keeper.keep(ctx, { prompt: "Speed up walgit's pack writes" });
		expect(process.env[KEY], "the prompt went on, unjudged").toBe("personal");
		await keeper.keep(ctx, { prompt: "and another thing" });
		expect(judged, "judged once, the wait asked nothing again").toHaveLength(1);

		land();
		await until(
			"the judgement to be drawn on",
			() => process.env[KEY] === "delta",
		);
		expect(notices, "said as it was drawn on").toEqual([
			'This session is on no quest, so it draws on budget delta, which "judge" judged from its folder and first prompt: its prompt.',
		]);
		await keeper.keep(ctx, { prompt: "and a third" });
		expect(process.env[KEY], "kept on after").toBe("delta");
		expect(judged, "still judged once").toHaveLength(1);
	});

	it("lets its first prompt go on past the wait on a slow folder, and draws on the folder's budget as it lands", async () => {
		let land = () => {};
		const answering = new Promise<void>((settle) => {
			land = settle;
		});
		const { keeper, ctx, judged } = loose(
			tmpRoot,
			"delta",
			0.9,
			{ looseWaitMs: 20 },
			Promise.resolve(),
			answering,
		);

		await keeper.keep(ctx, { prompt: "Speed up walgit's pack writes" });
		expect(process.env[KEY], "the prompt went on").toBe("personal");

		land();
		await until(
			"the folder's budget to be drawn on",
			() => process.env[KEY] === "aquifer",
		);
		expect(judged, "a folder's answer needs no judgement").toEqual([]);
	});

	it("judges its first prompt once a slow folder it went on past answers none", async () => {
		let land = () => {};
		const answering = new Promise<void>((settle) => {
			land = settle;
		});
		const { keeper, ctx, judged } = loose(
			undefined,
			"delta",
			0.9,
			{ looseWaitMs: 20 },
			Promise.resolve(),
			answering,
		);

		await keeper.keep(ctx, { prompt: "Speed up walgit's pack writes" });
		expect(process.env[KEY], "the prompt went on").toBe("personal");
		expect(judged, "nothing judged before the folder answers").toEqual([]);

		land();
		await until(
			"the judgement to be drawn on",
			() => process.env[KEY] === "delta",
		);
		expect(judged, "judged once, of the first prompt").toEqual([
			{
				title: tmpRoot,
				folder: tmpRoot,
				prompt: "Speed up walgit's pack writes",
			},
		]);
	});

	it("judges its first prompt when a slow folder the session's start went on past answers none", async () => {
		// The host keeps at a session's start with no prompt, then again
		// with it, so the start's keep is the one that first watches the
		// folder; the prompt still reaches the judgement as it lands.
		let land = () => {};
		const answering = new Promise<void>((settle) => {
			land = settle;
		});
		const { keeper, ctx, judged } = loose(
			undefined,
			"delta",
			0.9,
			{ looseWaitMs: 20 },
			Promise.resolve(),
			answering,
		);

		await keeper.keep(ctx);
		await keeper.keep(ctx, { prompt: "Speed up walgit's pack writes" });
		expect(process.env[KEY], "the prompt went on").toBe("personal");

		land();
		await until(
			"the judgement to be drawn on",
			() => process.env[KEY] === "delta",
		);
		expect(judged, "judged once, of the first prompt").toEqual([
			{
				title: tmpRoot,
				folder: tmpRoot,
				prompt: "Speed up walgit's pack writes",
			},
		]);
	});

	describe("how long a prompt waits", () => {
		beforeEach(() => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		/** Whether `promise` has settled, read without waiting on it. */
		function settledness(promise: Promise<unknown>): () => boolean {
			let settled = false;
			promise.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			return () => settled;
		}

		it("waits on its folder and its judgement together, no more than the default wait", async () => {
			// The folder answers none three quarters of the way in, and the
			// judgement it leaves never does: the prompt goes on at the one
			// wait's end, not a wait for each.
			const answering = new Promise<void>((settle) => {
				setTimeout(settle, (LOOSE_PROMPT_WAIT_MS * 3) / 4);
			});
			const { keeper, ctx, judged } = loose(
				undefined,
				"delta",
				0.9,
				{},
				new Promise(() => {}),
				answering,
			);

			const done = settledness(
				keeper.keep(ctx, { prompt: "Speed up walgit's pack writes" }),
			);
			await vi.advanceTimersByTimeAsync(LOOSE_PROMPT_WAIT_MS - 1);
			expect(
				judged,
				"the judgement was asked once the folder said none",
			).toHaveLength(1);
			expect(done(), "still waiting inside the one wait").toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(done(), "gone on at the wait's end").toBe(true);
			expect(LOOSE_PROMPT_WAIT_MS, "a wait under 5 s").toBeLessThan(5_000);
		});

		it("doesn't wait again on a judgement a prompt went on past", async () => {
			const { keeper, ctx, judged } = loose(
				undefined,
				"delta",
				0.9,
				{},
				new Promise(() => {}),
			);

			const first = settledness(
				keeper.keep(ctx, { prompt: "Speed up walgit's pack writes" }),
			);
			await vi.advanceTimersByTimeAsync(LOOSE_PROMPT_WAIT_MS);
			expect(first(), "the first prompt went on").toBe(true);
			const second = settledness(
				keeper.keep(ctx, { prompt: "and another thing" }),
			);
			await vi.advanceTimersByTimeAsync(0);
			expect(second(), "the second went on with no wait").toBe(true);
			expect(judged, "judged once").toHaveLength(1);
		});

		it("holds no turn on a judgement only a late folder's answer started", async () => {
			// Nobody waits on the judgement the late answer starts, so a keep
			// between turns takes it only if it has landed.
			const late = LOOSE_PROMPT_WAIT_MS + 100;
			const answering = new Promise<void>((settle) => {
				setTimeout(settle, late);
			});
			const { keeper, ctx, judged } = loose(
				undefined,
				"delta",
				0.9,
				{},
				new Promise(() => {}),
				answering,
			);

			const first = settledness(
				keeper.keep(ctx, { prompt: "Speed up walgit's pack writes" }),
			);
			await vi.advanceTimersByTimeAsync(late);
			expect(first(), "the prompt went on").toBe(true);
			expect(judged, "the late none started the judgement").toHaveLength(1);
			const between = settledness(keeper.keep(ctx));
			await vi.advanceTimersByTimeAsync(0);
			expect(between(), "the keep between turns didn't wait on it").toBe(true);
		});
	});

	it("keeps the folder's budget while the folder is asked again of a provider registering late", async () => {
		const { keeper, ctx, events } = loose(tmpRoot, "delta", 0.9, {
			looseWaitMs: 20,
		});
		await keeper.keep(ctx, { prompt: "Speed up walgit" });
		expect(process.env[KEY], "on the folder's budget").toBe("aquifer");

		let land = () => {};
		const held = new Promise<void>((settle) => {
			land = settle;
		});
		registerBudgetProvider(events, {
			id: "late",
			precedence: 1,
			resolve: async () => ({ kind: "unknown" }),
			budgetFor: async () => {
				await held;
				return undefined;
			},
		});
		await keeper.keep(ctx);

		expect(process.env[KEY], "not dropped while the folder is asked").toBe(
			"aquifer",
		);
		land();
	});

	it("lays nothing from a judgement still on its way once the session is forgotten", async () => {
		let land = () => {};
		const judging = new Promise<void>((settle) => {
			land = settle;
		});
		const { keeper, ctx, notices } = loose(
			undefined,
			"delta",
			0.9,
			{ looseWaitMs: 20 },
			judging,
		);
		await keeper.keep(ctx, { prompt: "Speed up walgit's pack writes" });

		keeper.forget();
		land();
		await new Promise((settle) => setTimeout(settle, 50));

		expect(process.env[KEY], "the next session isn't put on it").not.toBe(
			"delta",
		);
		expect(notices, "and nothing is said of it").toEqual([]);
	});

	it("lays nothing from a judgement still on its way once a quest has loaded", async () => {
		let land = () => {};
		const judging = new Promise<void>((settle) => {
			land = settle;
		});
		const { keeper, ctx, notices, state } = loose(
			undefined,
			"delta",
			0.9,
			{ looseWaitMs: 20 },
			judging,
		);
		await keeper.keep(ctx, { prompt: "Speed up walgit's pack writes" });

		state.questId = "QEST-20260101-AAAAAA";
		land();
		await new Promise((settle) => setTimeout(settle, 50));

		expect(process.env[KEY], "the quest's own budget stands").not.toBe("delta");
		expect(notices, "and nothing is said of it").toEqual([]);
	});

	it("carries on after a judgement it went on past fails", async () => {
		let fail = (_why: Error) => {};
		const judging = new Promise<void>((_settle, reject) => {
			fail = reject;
		});
		const { keeper, ctx } = loose(
			undefined,
			"delta",
			0.9,
			{ looseWaitMs: 20 },
			judging,
		);
		await keeper.keep(ctx, { prompt: "Speed up walgit's pack writes" });

		fail(new Error("the classifier went away"));
		await new Promise((settle) => setTimeout(settle, 50));

		// A rejection reaching here, or left unwatched, fails the test.
		await keeper.keep(ctx, { prompt: "and another thing" });
		expect(process.env[KEY], "on what it drew on unjudged").toBe("personal");
	});

	it("lets a judgement it went on past outlive the run it was asked in", async () => {
		// Escape on the reply stops the run, not a paid judgement nobody
		// waits on any longer.
		let land = () => {};
		const judging = new Promise<void>((settle) => {
			land = settle;
		});
		const { keeper, ctx, judged } = loose(
			undefined,
			"delta",
			0.9,
			{ looseWaitMs: 20 },
			judging,
		);
		const run = new AbortController();
		const running = { ...ctx, signal: run.signal } as typeof ctx;
		await keeper.keep(running, { prompt: "Speed up walgit's pack writes" });

		run.abort();
		land();
		await until(
			"the judgement to be drawn on",
			() => process.env[KEY] === "delta",
		);
		expect(judged, "asked once, not again").toHaveLength(1);
	});

	it("stays on the default when the judgement is unsure or personal", async () => {
		for (const [choice, confidence] of [
			["delta", 0.5],
			["none", 0.99],
		] as const) {
			const { keeper, ctx, judged, notices } = loose(
				undefined,
				choice,
				confidence,
			);

			await keeper.keep(ctx, { prompt: "something" });

			expect(judged, choice).toHaveLength(1);
			expect(process.env[KEY], choice).toBe("personal");
			expect(notices, choice).toEqual([]);
		}
	});

	it("keeps what its first prompt was judged to draw on when a provider registers late, without judging again", async () => {
		const { keeper, ctx, judged, notices, events } = loose(undefined, "delta");
		await keeper.keep(ctx, { prompt: "Speed up walgit" });

		registerBudgetProvider(events, {
			id: "late",
			precedence: 1,
			resolve: async () => ({ kind: "unknown" }),
		});
		await keeper.keep(ctx);

		expect(process.env[KEY]).toBe("delta");
		expect(judged).toHaveLength(1);
		expect(notices).toHaveLength(1);
	});

	it("keeps a judgement still on its way when a provider registers, rather than one asked over it", async () => {
		// Unsure itself, so only the slow provider's first answer is sure.
		const { keeper, ctx, events } = loose(undefined, "delta", 0.5);
		let calls = 0;
		let release = (): void => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		registerBudgetProvider(events, {
			id: "slow",
			precedence: 1,
			resolve: async () => ({ kind: "unknown" }),
			budgetForWork: async () => {
				calls++;
				if (calls > 1) return { name: "delta", why: "again", sure: false };
				await held;
				return { name: "delta", why: "its prompt", sure: true };
			},
		});

		const first = keeper.keep(ctx, { prompt: "Speed up walgit" });
		await vi.waitFor(() => expect(calls, "the first judgement asked").toBe(1));
		registerBudgetProvider(events, {
			id: "late",
			precedence: 2,
			resolve: async () => ({ kind: "unknown" }),
		});
		release();
		await first;
		await keeper.keep(ctx, { prompt: "and another thing" });

		expect(calls, "judged once").toBe(1);
		expect(process.env[KEY]).toBe("delta");
	});

	it("judges its first prompt again when a provider registers late after it named nothing", async () => {
		const { keeper, ctx, judged, events } = loose(undefined, "delta", 0.5);
		await keeper.keep(ctx, { prompt: "Speed up walgit" });
		expect(process.env[KEY]).toBe("personal");

		registerBudgetProvider(events, {
			id: "late",
			precedence: 1,
			resolve: async () => ({ kind: "unknown" }),
			budgetForWork: async (work) => {
				judged.push(work);
				return { name: "aquifer", why: "late", sure: true };
			},
		});
		await keeper.keep(ctx, { prompt: "and another thing" });

		expect(process.env[KEY]).toBe("aquifer");
		expect(
			judged.map((work) => (work as { prompt: string }).prompt),
			"the first prompt each time",
		).toEqual(["Speed up walgit", "Speed up walgit", "Speed up walgit"]);
	});

	it("is judged again, not taken as started on it, under a budget an earlier keeper laid", async () => {
		const first = loose(undefined, "delta");
		await first.keeper.keep(first.ctx, { prompt: "Speed up walgit" });
		expect(process.env.PI_BUDGET).toBe("delta");

		// A reload or /new: another keeper, over the same overlay.
		first.keeper.forget();
		const next = loose(undefined, "delta");
		await next.keeper.keep(next.ctx, { prompt: "Speed up walgit again" });

		expect(next.judged).toHaveLength(1);
		expect(process.env[KEY]).toBe("delta");
	});

	it("judges its conversation's first prompt once reloaded, not the follow-up", async () => {
		const { keeper, ctx, judged } = loose(undefined, "delta");
		// What the conversation already holds when a keeper reloads in it.
		written.push({
			type: "message",
			message: { role: "user", content: "Speed up walgit" },
		} as unknown as (typeof written)[number]);

		await keeper.keep(ctx, { prompt: "yes, go on" });

		expect(judged.map((work) => (work as { prompt: string }).prompt)).toEqual([
			"Speed up walgit",
		]);
		expect(process.env[KEY]).toBe("delta");
	});

	it("judges a person's first words, not what the harness said before them", async () => {
		const { keeper, ctx, judged } = loose(undefined, "delta");
		for (const content of [
			automatedText("a job finished", "Deploy aquifer's walgit"),
			"Speed up walgit",
		])
			written.push({
				type: "message",
				message: { role: "user", content },
			} as unknown as (typeof written)[number]);

		await keeper.keep(ctx, { prompt: "yes, go on" });

		expect(judged.map((work) => (work as { prompt: string }).prompt)).toEqual([
			"Speed up walgit",
		]);
	});

	it("isn't judged on what the harness sends as its first prompt", async () => {
		const { keeper, ctx, judged } = loose(undefined, "delta");

		await keeper.keep(ctx, {
			prompt: automatedText("a job finished", "Deploy delta"),
		});

		expect(judged).toEqual([]);
		expect(process.env[KEY]).toBe("personal");
	});

	it("keeps the budget recorded before a reload, without judging again", async () => {
		// Unsure now, so a judgement asked again would take delta off.
		const { keeper, ctx, judged } = loose(undefined, "delta", 0.5);
		written.push(
			{
				type: "message",
				message: { role: "user", content: "Speed up walgit" },
			} as unknown as (typeof written)[number],
			{
				type: "custom",
				customType: BUDGET_ENTRY,
				data: { v: 1, name: "delta", judged: true },
			} as unknown as (typeof written)[number],
		);

		await keeper.keep(ctx);

		expect(judged).toEqual([]);
		expect(process.env[KEY]).toBe("delta");
	});

	it("asks its folder afresh once reloaded, rather than keep a budget its folder named before", async () => {
		// The folder no longer names aquifer, as a team took it off its list.
		const { keeper, ctx } = loose(undefined, "delta", 0.5);
		written.push(
			{
				type: "message",
				message: { role: "user", content: "Speed up walgit" },
			} as unknown as (typeof written)[number],
			{
				type: "custom",
				customType: BUDGET_ENTRY,
				data: { v: 1, name: "aquifer", label: "aquifer", provider: "judge" },
			} as unknown as (typeof written)[number],
		);

		await keeper.keep(ctx);

		expect(process.env[KEY]).toBe("personal");
		expect(process.env.PI_BUDGET).toBeUndefined();
	});

	it("keeps the budget it was judged onto through a quest and a reload, without judging again", async () => {
		const first = loose(undefined, "delta");
		written.push({
			type: "message",
			message: { role: "user", content: "Speed up walgit" },
		} as unknown as (typeof written)[number]);
		await first.keeper.keep(first.ctx, { prompt: "Speed up walgit" });
		expect(recorded(), "said to be a judgement's").toContainEqual(
			expect.objectContaining({ name: "delta", judged: true }),
		);
		const run = (params: Parameters<typeof handle>[3]) =>
			handle(first.state, fakePi(intoTheBranch), fakeCtx("/elsewhere"), params);
		succeeded(await run({ action: "create", title: "Aquifer Work" }));
		const id = first.state.questId as string;
		succeeded(await run({ action: "budget", id, ref: "aquifer" }));
		written.push({
			type: "custom",
			customType: "quest-workflow",
			data: { questId: id },
		} as unknown as (typeof written)[number]);
		await first.keeper.keep(first.ctx);
		expect(process.env[KEY]).toBe("aquifer");

		// Reloaded, with the quest put down: unsure now, so a judgement
		// asked again would take delta off.
		first.keeper.forget();
		const next = loose(undefined, "delta", 0.5);
		await next.keeper.keep(next.ctx);

		expect(next.judged).toEqual([]);
		expect(process.env[KEY]).toBe("delta");
	});

	it("goes back to the budget it was judged onto when it leaves a quest it was reloaded on", async () => {
		const first = loose(undefined, "delta");
		written.push({
			type: "message",
			message: { role: "user", content: "Speed up walgit" },
		} as unknown as (typeof written)[number]);
		await first.keeper.keep(first.ctx, { prompt: "Speed up walgit" });
		const run = (params: Parameters<typeof handle>[3]) =>
			handle(first.state, fakePi(intoTheBranch), fakeCtx("/elsewhere"), params);
		succeeded(await run({ action: "create", title: "Aquifer Work" }));
		const id = first.state.questId as string;
		succeeded(await run({ action: "budget", id, ref: "aquifer" }));
		await first.keeper.keep(first.ctx);
		expect(process.env[KEY]).toBe("aquifer");

		// Reloaded with the quest still loaded, then put down: unsure now,
		// so a judgement asked again would take delta off.
		first.keeper.forget();
		const next = loose(undefined, "delta", 0.5);
		next.state.questId = id;
		await next.keeper.keep(next.ctx);
		expect(process.env[KEY]).toBe("aquifer");
		next.state.questId = null;
		await next.keeper.keep(next.ctx);

		expect(next.judged).toEqual([]);
		expect(process.env[KEY]).toBe("delta");
	});

	it("asks again for the budget it missed before a reload, not what calls fell to", async () => {
		const { keeper, ctx, judged } = loose(undefined, "delta", 0.5);
		written.push(
			{
				type: "message",
				message: { role: "user", content: "Speed up walgit" },
			} as unknown as (typeof written)[number],
			{
				type: "custom",
				customType: BUDGET_ENTRY,
				data: {
					v: 1,
					name: null,
					unresolved: { budget: "delta", missing: "no key" },
					judged: true,
				},
			} as unknown as (typeof written)[number],
		);

		await keeper.keep(ctx);

		expect(judged, "no judgement paid for again").toEqual([]);
		expect(process.env[KEY]).toBe("delta");
	});

	it("waits for a prompt's run to judge a reloaded conversation, so Escape can stop it", async () => {
		const { keeper, ctx, judged } = loose(undefined, "delta");
		written.push({
			type: "message",
			message: { role: "user", content: "Speed up walgit" },
		} as unknown as (typeof written)[number]);

		await keeper.keep(ctx);
		expect(judged, "nothing at the session's start").toEqual([]);

		const run = { ...ctx, signal: new AbortController().signal } as typeof ctx;
		await keeper.keep(run, { prompt: "yes, go on" });
		expect(judged.map((work) => (work as { prompt: string }).prompt)).toEqual([
			"Speed up walgit",
		]);
		expect(process.env[KEY]).toBe("delta");
	});

	it("isn't judged on its prompt when it runs headless, as a subagent of a quest on no budget does", async () => {
		for (const mode of ["json", "print"]) {
			const { keeper, ctx, judged } = loose(undefined, "delta");
			const headless = { ...ctx, mode } as typeof ctx;

			await keeper.keep(headless, { prompt: "Review this Delta change" });

			expect(judged, mode).toEqual([]);
			expect(process.env[KEY], mode).toBe("personal");
		}
	});

	it("keeps to none, unjudged and over its folder's, when a quest whose budget is none started it", async () => {
		process.env.PI_BUDGET_OPTED_OUT = "1";
		const { keeper, ctx, judged } = loose(tmpRoot, "delta");

		await keeper.keep(ctx, { prompt: "Review this Delta change" });

		expect(judged).toEqual([]);
		expect(process.env[KEY], "not its folder's aquifer").toBe("personal");
		expect(process.env.PI_BUDGET_OPTED_OUT, "kept for what it starts").toBe(
			"1",
		);
	});

	it("isn't taken as started on none after a /new from a quest whose budget is none", async () => {
		// Unsure, so making the quest names it nothing before it is set none.
		const first = loose(undefined, "delta", 0.5);
		const run = (params: Parameters<typeof handle>[3]) =>
			handle(first.state, fakePi(intoTheBranch), fakeCtx("/elsewhere"), params);
		succeeded(await run({ action: "create", title: "Mine" }));
		const id = first.state.questId as string;
		succeeded(await run({ action: "budget", id, ref: "none" }));
		await first.keeper.keep(first.ctx);
		expect(process.env.PI_BUDGET_OPTED_OUT).toBe("1");

		// A /new: another keeper, over the same overlay, on no quest.
		first.keeper.forget();
		const next = loose(tmpRoot, "delta");
		await next.keeper.keep(next.ctx, { prompt: "Review this" });

		expect(process.env[KEY], "its folder's, not the quest's none").toBe(
			"aquifer",
		);
		expect(process.env.PI_BUDGET_OPTED_OUT).toBeUndefined();
	});

	it("asks again for the budget a judgement named that it missed, as a quest's session does", async () => {
		const clock = { at: 0 };
		const { keeper, ctx, judged, events } = loose(undefined, "worldtree", 0.9, {
			now: () => clock.at,
		});
		let answer: BudgetAnswer = {
			kind: "unavailable",
			reason: "It didn't answer within 5 s.",
		};
		provide(events, "plane", async (name) =>
			name === "worldtree" ? answer : { kind: "unknown" },
		);
		await keeper.keep(ctx, { prompt: "Speed up worldtree" });
		expect(process.env[KEY], "missed").toBe("personal");

		answer = { kind: "drawn", env: { [KEY]: "team" }, label: "Worldtree" };
		clock.at += BUDGET_ASKED_AGAIN_MS;
		await keeper.keep(ctx);

		expect(process.env[KEY]).toBe("team");
		expect(judged, "judged once").toHaveLength(1);
	});

	it("says a quest's none to what it starts, and isn't judged on that quest's words once it leaves it", async () => {
		const { state, keeper, ctx, judged } = loose(undefined, "delta");
		const run = (params: Parameters<typeof handle>[3]) =>
			handle(state, fakePi(intoTheBranch), fakeCtx("/elsewhere"), params);
		succeeded(await run({ action: "create", title: "Mine" }));
		const id = state.questId as string;
		succeeded(await run({ action: "budget", id, ref: "none" }));

		await keeper.keep(ctx, { prompt: "Tune the laptop's fans" });
		expect(process.env.PI_BUDGET_OPTED_OUT).toBe("1");

		succeeded(await run({ action: "unload" }));
		await keeper.keep(ctx, { prompt: "and now something else" });

		expect(process.env.PI_BUDGET_OPTED_OUT, "lifted with it").toBeUndefined();
		expect(
			judged.filter((work) => isRecord(work) && work.prompt !== undefined),
			"no prompt judged, only the quest as it was made",
		).toEqual([]);
		expect(process.env[KEY]).toBe("personal");
	});

	it("isn't judged once reloaded into a conversation that was on a quest", async () => {
		const { keeper, ctx, judged } = loose(undefined, "delta");
		written.push(
			{
				type: "message",
				message: { role: "user", content: "Speed up walgit" },
			} as unknown as (typeof written)[number],
			{
				type: "custom",
				customType: "quest-workflow",
				data: { questId: "QEST-20261119-AAAAAA" },
			} as unknown as (typeof written)[number],
		);

		await keeper.keep(ctx, { prompt: "yes, go on" });

		expect(judged).toEqual([]);
		expect(process.env[KEY]).toBe("personal");
	});

	it("still draws on its folder's budget when it runs headless", async () => {
		const { keeper, ctx, judged } = loose(tmpRoot, "delta");
		const headless = { ...ctx, mode: "print" } as typeof ctx;

		await keeper.keep(headless, { prompt: "Review this" });

		expect(judged).toEqual([]);
		expect(process.env[KEY]).toBe("aquifer");
	});

	it("keeps the budget it was started on over its folder's", async () => {
		process.env.PI_BUDGET = "delta";
		const { keeper, ctx, judged } = loose(tmpRoot, "delta");

		await keeper.keep(ctx, { prompt: "Review this" });

		expect(judged).toEqual([]);
		expect(process.env[KEY], "not its folder's aquifer").toBe("personal");
		expect(process.env.PI_BUDGET).toBe("delta");
	});

	it("judges its first prompt again after Escape stopped the judgement", async () => {
		const { keeper, ctx, judged } = loose(undefined, "delta");
		const pressed = new AbortController();
		const stopped = {
			...ctx,
			signal: pressed.signal,
			modelRegistry: {
				...ctx.modelRegistry,
				classify: async () => {
					pressed.abort();
					return { answers: {} };
				},
			},
		} as unknown as typeof ctx;

		await keeper.keep(stopped, { prompt: "Speed up walgit" });
		expect(process.env[KEY], "nothing from a stopped judgement").toBe(
			"personal",
		);
		await keeper.keep(ctx, { prompt: "try that again" });

		expect(process.env[KEY]).toBe("delta");
		expect(judged.map((work) => (work as { prompt: string }).prompt)).toEqual([
			"Speed up walgit",
			"Speed up walgit",
		]);
	});

	it("isn't judged when it was started on a budget, as a subagent of a quest is", async () => {
		process.env.PI_BUDGET = "aquifer";
		const { keeper, ctx, judged } = loose(undefined, "delta");

		await keeper.keep(ctx, { prompt: "Review this Delta change" });

		expect(judged).toEqual([]);
		expect(process.env[KEY]).toBe("personal");
	});

	it("lays nothing from a judgement that lands after the session was forgotten", async () => {
		const { keeper, ctx, judged, notices } = loose(undefined, "delta");
		let release: (answer: unknown) => void = () => {};
		const held = {
			...ctx,
			modelRegistry: {
				...ctx.modelRegistry,
				classify: () =>
					new Promise((resolve) => {
						release = resolve;
					}),
			},
		} as unknown as typeof ctx;

		const keeping = keeper.keep(held, { prompt: "Speed up walgit" });
		await vi.waitFor(() => expect(judged).toHaveLength(1));
		keeper.forget();
		release({ answers: {} });
		await keeping;

		expect(process.env[KEY]).toBe("personal");
		expect(notices).toEqual([]);
	});

	it("gives way to a quest the session loads", async () => {
		const { state, keeper, ctx } = loose(undefined, "delta");
		await keeper.keep(ctx, { prompt: "walgit" });
		expect(process.env[KEY]).toBe("delta");
		const run = (params: Parameters<typeof handle>[3]) =>
			handle(state, fakePi(intoTheBranch), fakeCtx("/elsewhere"), params);
		succeeded(await run({ action: "create", title: "Aquifer Work" }));
		succeeded(
			await run({
				action: "budget",
				id: state.questId as string,
				ref: "aquifer",
			}),
		);

		await keeper.keep(ctx);

		expect(process.env[KEY]).toBe("aquifer");
	});

	it("lays nothing from a judgement that lands after a quest loaded", async () => {
		const { state, keeper, ctx, judged, notices } = loose(undefined, "delta");
		let release: (answer: unknown) => void = () => {};
		const held = {
			...ctx,
			modelRegistry: {
				...ctx.modelRegistry,
				classify: () =>
					new Promise((resolve) => {
						release = resolve;
					}),
			},
		} as unknown as typeof ctx;
		const keeping = keeper.keep(held, { prompt: "Speed up walgit" });
		await vi.waitFor(() => expect(judged).toHaveLength(1));

		const run = (params: Parameters<typeof handle>[3]) =>
			handle(state, fakePi(intoTheBranch), fakeCtx("/elsewhere"), params);
		succeeded(await run({ action: "create", title: "Aquifer Work" }));
		const id = state.questId as string;
		succeeded(await run({ action: "budget", id, ref: "aquifer" }));
		// The same context, as pi may hand every event.
		await keeper.keep(held);
		release({ answers: {} });
		await keeping;

		expect(process.env[KEY]).toBe("aquifer");
		expect(
			notices.filter((notice) => notice.includes("on no quest")),
			"not said to be on no quest",
		).toEqual([]);
	});

	it("asks its folder again once it leaves a quest it was on as a provider registered", async () => {
		const { state, keeper, ctx, events } = loose(undefined, "delta", 0.5);
		await keeper.keep(ctx);
		const run = (params: Parameters<typeof handle>[3]) =>
			handle(state, fakePi(intoTheBranch), fakeCtx("/elsewhere"), params);
		succeeded(await run({ action: "create", title: "Other Work" }));
		await keeper.keep(ctx);

		registerBudgetProvider(events, {
			id: "late",
			precedence: 1,
			resolve: async () => ({ kind: "unknown" }),
			budgetFor: async (asked) => (asked === tmpRoot ? "delta" : undefined),
		});
		succeeded(await run({ action: "unload" }));
		await keeper.keep(ctx);

		expect(process.env[KEY]).toBe("delta");
	});

	it("sets an inherited none aside on a quest that names nothing, and keeps to it again once off it", async () => {
		process.env.PI_BUDGET_OPTED_OUT = "1";
		// Unsure, so the quest made here is named nothing.
		const { state, keeper, ctx } = loose(undefined, "delta", 0.5);
		const run = (params: Parameters<typeof handle>[3]) =>
			handle(state, fakePi(intoTheBranch), fakeCtx("/elsewhere"), params);
		succeeded(await run({ action: "create", title: "Other Work" }));

		await keeper.keep(ctx);
		expect(
			process.env.PI_BUDGET_OPTED_OUT,
			"not handed to what it starts",
		).toBeUndefined();

		succeeded(await run({ action: "unload" }));
		await keeper.keep(ctx);
		expect(process.env.PI_BUDGET_OPTED_OUT).toBe("1");
	});

	it("keeps an inherited none on a quest whose record can't be read", async () => {
		process.env.PI_BUDGET_OPTED_OUT = "1";
		const { state, keeper, ctx } = loose(undefined, "delta", 0.5);
		// No README under the quests root names this one.
		state.questId = "QEST-20261120-MISSIN";

		await keeper.keep(ctx);

		expect(process.env[KEY]).toBe("personal");
		expect(
			process.env.PI_BUDGET_OPTED_OUT,
			"no word read to set it aside",
		).toBe("1");
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
