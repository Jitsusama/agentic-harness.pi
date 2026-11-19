/**
 * A quest's budget: the verb that names one, the judging that names one
 * at create and in a sweep, and the keeper that draws on it.
 *
 * Long because every case shares one sandbox: the quest tool and the
 * budget keeper are two halves of one session, writing to and reading
 * back one branch and one process environment, and the setup that
 * resets both between cases is what keeps each case from reading the
 * last one's budget.
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
import { BUDGET_ENTRY, BUDGET_SETTLED } from "../../../../lib/budget/record.ts";
import { automatedText } from "../../../../lib/internal/automated.ts";
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
		KEY,
	])
		kept[key] = process.env[key];
	delete process.env.PI_BUDGET;
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
		keepQuestBudget(fakePi({ ...intoTheBranch, events }), state);
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
				"Already journaled personal or unsure, so not judged again:",
			);
			expect(again.message).toContain(fans);
			expect(again.message).toContain(vague);
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
			expect(lookups, "no quest started after the stop").toBe(4);
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

describe("the budget of a session on no quest", () => {
	/**
	 * A keeper on no quest whose provider draws delta and aquifer, names
	 * aquifer for `folder`, and judges a prompt at `confidence`; and a
	 * session's ctx in tmpRoot whose registry serves Jev.
	 */
	function loose(folder: string | undefined, choice: string, confidence = 0.9) {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const events = bus();
		const keeper = keepQuestBudget(fakePi({ ...intoTheBranch, events }), state);
		const judged: unknown[] = [];
		registerBudgetProvider(events, {
			id: "judge",
			precedence: 0,
			resolve: async (name) =>
				name === "delta" || name === "aquifer"
					? { kind: "drawn", env: { [KEY]: name }, label: name }
					: { kind: "unknown" },
			budgetFor: async (asked) => (asked === folder ? "aquifer" : undefined),
			budgetForWork: async (work, classify) => {
				judged.push(work);
				await classify({ state: {}, questions: {} });
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
				data: { v: 1, name: "delta" },
			} as unknown as (typeof written)[number],
		);

		await keeper.keep(ctx);

		expect(judged).toEqual([]);
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
		const { keeper, ctx, judged } = loose(undefined, "delta");
		const headless = { ...ctx, mode: "json" } as typeof ctx;

		await keeper.keep(headless, { prompt: "Review this Delta change" });

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
