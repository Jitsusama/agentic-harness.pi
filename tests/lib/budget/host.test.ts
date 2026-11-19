import { describe, expect, it } from "vitest";
import { hostBudgets } from "../../../lib/budget/host.ts";
import {
	BUDGET_READY,
	BUDGET_REGISTER_PROVIDER,
	BUDGET_REQUEST,
	type BudgetAnswer,
	type BudgetProvider,
	registerBudgetProvider,
} from "../../../lib/budget/provider.ts";

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

function provider(
	id: string,
	precedence: number,
	answers: Record<string, BudgetAnswer>,
): BudgetProvider {
	return {
		id,
		precedence,
		resolve: async (name) => answers[name] ?? { kind: "unknown" },
	};
}

const drawn = (key: string): BudgetAnswer => ({
	kind: "drawn",
	env: { KEY: key },
	label: key,
});

describe("the budget host", () => {
	it("asks providers lowest precedence first, and the first that knows answers", async () => {
		const events = bus();
		const host = hostBudgets(events);
		registerBudgetProvider(
			events,
			provider("company", 10, { delta: drawn("company") }),
		);
		registerBudgetProvider(
			events,
			provider("files", 0, { delta: drawn("mine") }),
		);

		expect(host.listProviders()).toEqual(["files", "company"]);
		expect(await host.draw("delta")).toEqual({
			kind: "drawn",
			provider: "files",
			env: { KEY: "mine" },
			label: "mine",
		});
	});

	it("passes a name a provider does not know to the next", async () => {
		const events = bus();
		const host = hostBudgets(events);
		registerBudgetProvider(events, provider("files", 0, {}));
		registerBudgetProvider(
			events,
			provider("company", 10, { delta: drawn("company") }),
		);

		const drawing = await host.draw("delta");

		expect(drawing.kind === "drawn" && drawing.provider).toBe("company");
	});

	it("stops at a provider that knows the name but can't draw on it", async () => {
		const events = bus();
		const host = hostBudgets(events);
		registerBudgetProvider(
			events,
			provider("company", 0, {
				delta: { kind: "unavailable", reason: "Save the token first." },
			}),
		);
		registerBudgetProvider(
			events,
			provider("files", 10, { delta: drawn("x") }),
		);

		expect(await host.draw("delta")).toEqual({
			kind: "unavailable",
			provider: "company",
			reason: "Save the token first.",
		});
	});

	it("reads a provider that rejects as unavailable, with its reason", async () => {
		const events = bus();
		const host = hostBudgets(events);
		host.registerProvider({
			id: "broken",
			precedence: 0,
			resolve: () => Promise.reject(new Error("disk on fire")),
		});

		expect(await host.draw("delta")).toEqual({
			kind: "unavailable",
			provider: "broken",
			reason: "disk on fire",
		});
	});

	it("reads a provider that doesn't answer in time as unavailable", async () => {
		const events = bus();
		const host = hostBudgets(events, 20);
		host.registerProvider({
			id: "stuck\nforged line",
			precedence: 0,
			resolve: () => new Promise(() => {}),
		});

		// The reason leaves the id to the answer's provider, which the
		// notice quotes, so an id with a newline adds no line of its own.
		expect(await host.draw("delta")).toEqual({
			kind: "unavailable",
			provider: "stuck\nforged line",
			reason: "It didn't answer within 0.02 s.",
		});
	});

	it("says which it asked when none knows the name", async () => {
		const events = bus();
		const host = hostBudgets(events);
		registerBudgetProvider(events, provider("files", 0, {}));

		expect(await host.draw("delta")).toEqual({
			kind: "unknown",
			asked: ["files"],
		});
	});

	it("takes a provider that registered before it was up, once it announces itself", async () => {
		const events = bus();
		registerBudgetProvider(events, provider("early", 0, { delta: drawn("e") }));

		const host = hostBudgets(events);

		expect(host.listProviders()).toEqual(["early"]);
	});

	it("announces itself again when asked, and ignores a payload that is no provider", () => {
		const events = bus();
		const host = hostBudgets(events);
		let announced = 0;
		events.on(BUDGET_READY, () => {
			announced += 1;
		});

		events.emit(BUDGET_REQUEST);
		events.emit(BUDGET_REGISTER_PROVIDER, { id: "half" });

		expect(announced).toBe(1);
		expect(host.listProviders()).toEqual([]);
	});

	it("tells a listener each time a provider registers", () => {
		const events = bus();
		const host = hostBudgets(events);
		let told = 0;
		host.onRegistered(() => {
			told += 1;
		});

		registerBudgetProvider(events, provider("late", 0, {}));

		expect(told).toBe(1);
	});
});

/** A provider that names budgets for folders, by `answer`. */
function placing(
	id: string,
	precedence: number,
	answer: (folder: string) => Promise<string | undefined>,
): BudgetProvider {
	return { ...provider(id, precedence, {}), budgetFor: answer };
}

describe("the budget a folder's work draws on", () => {
	it("is the first provider's, lowest precedence first, that names one", async () => {
		const events = bus();
		const host = hostBudgets(events);
		registerBudgetProvider(
			events,
			placing("company", 10, async () => "worldtree"),
		);
		registerBudgetProvider(
			events,
			placing("files", 0, async (folder) =>
				folder.startsWith("/src/delta") ? "delta" : undefined,
			),
		);
		registerBudgetProvider(events, provider("names-only", 5, {}));

		expect(await host.budgetFor("/src/delta/server")).toEqual({
			name: "delta",
			provider: "files",
		});
		expect(await host.budgetFor("/src/worldtree")).toEqual({
			name: "worldtree",
			provider: "company",
		});
	});

	it("passes over a provider that fails, is late or names no budget's name", async () => {
		const events = bus();
		const host = hostBudgets(events, 20);
		registerBudgetProvider(
			events,
			placing("throws", 0, async () => {
				throw new Error("no map");
			}),
		);
		registerBudgetProvider(
			events,
			placing("late", 1, () => new Promise(() => {})),
		);
		registerBudgetProvider(
			events,
			placing("bad", 2, async () => "../escape"),
		);

		expect(await host.budgetFor("/anywhere")).toBeUndefined();

		registerBudgetProvider(
			events,
			placing("good", 3, async () => "aquifer"),
		);
		expect(await host.budgetFor("/anywhere")).toEqual({
			name: "aquifer",
			provider: "good",
		});
	});

	it("says which provider failed or was late, with the folder and why, and not one that names none", async () => {
		const events = bus();
		const troubles: unknown[] = [];
		const host = hostBudgets(events, 20, (trouble) => troubles.push(trouble));
		registerBudgetProvider(
			events,
			placing("throws", 0, async () => {
				throw new Error("no map");
			}),
		);
		registerBudgetProvider(
			events,
			placing("late", 1, () => new Promise(() => {})),
		);
		registerBudgetProvider(
			events,
			placing("quiet", 2, async () => undefined),
		);

		expect(await host.budgetFor("/src/delta")).toBeUndefined();
		expect(troubles).toEqual([
			{ provider: "throws", folder: "/src/delta", why: "it failed: no map" },
			{
				provider: "late",
				folder: "/src/delta",
				why: "it didn't answer within 20 ms",
			},
		]);
	});

	it("asks every provider at once, so the wait is one deadline however many are late", async () => {
		const events = bus();
		const host = hostBudgets(events, 200);
		for (const id of ["one", "two", "three"]) {
			registerBudgetProvider(
				events,
				placing(id, 0, () => new Promise(() => {})),
			);
		}
		registerBudgetProvider(
			events,
			placing("last", 9, async () => "delta"),
		);

		const began = Date.now();
		const found = await host.budgetFor("/anywhere");
		const waited = Date.now() - began;

		expect(found).toEqual({ name: "delta", provider: "last" });
		expect(waited, `waited ${waited} ms for three late providers`).toBeLessThan(
			500,
		);
	});

	it("passes over a provider that names none, since a folder never opts a quest out", async () => {
		const events = bus();
		const host = hostBudgets(events);
		registerBudgetProvider(
			events,
			placing("opts-out", 0, async () => "none"),
		);

		expect(await host.budgetFor("/anywhere")).toBeUndefined();

		registerBudgetProvider(
			events,
			placing("names", 1, async () => "aquifer"),
		);
		expect(await host.budgetFor("/anywhere")).toEqual({
			name: "aquifer",
			provider: "names",
		});
	});

	it("keeps a provider whose budgetFor isn't a function for its names, and takes no folder's budget from it", async () => {
		const events = bus();
		const host = hostBudgets(events);

		events.emit(BUDGET_REGISTER_PROVIDER, {
			...provider("odd", 0, {
				delta: { kind: "drawn", env: { K: "v" }, label: "Delta" },
			}),
			budgetFor: "delta",
		});

		expect(host.listProviders()).toEqual(["odd"]);
		expect((await host.draw("delta")).kind).toBe("drawn");
		expect(await host.budgetFor("/anywhere")).toBeUndefined();
	});

	it("is the earlier provider's when a later one answers first", async () => {
		const events = bus();
		const host = hostBudgets(events, 5_000);
		registerBudgetProvider(
			events,
			placing(
				"slow",
				0,
				() => new Promise((answer) => setTimeout(() => answer("delta"), 50)),
			),
		);
		registerBudgetProvider(
			events,
			placing("quick", 1, async () => "aquifer"),
		);

		expect(await host.budgetFor("/anywhere")).toEqual({
			name: "delta",
			provider: "slow",
		});
	});

	it("leaves no rejection behind from a provider that throws at once, or fails after the answer", async () => {
		const leaked: unknown[] = [];
		const catchLeak = (reason: unknown) => leaked.push(reason);
		process.on("unhandledRejection", catchLeak);
		try {
			const events = bus();
			// Longer than the late failure takes, so the failure isn't
			// soaked up by a deadline that has already won its race.
			const host = hostBudgets(events, 1_000);
			registerBudgetProvider(events, {
				...provider("throws-at-once", 0, {}),
				budgetFor: () => {
					throw new Error("not even a promise");
				},
			});
			registerBudgetProvider(
				events,
				placing("names", 1, async () => "delta"),
			);
			registerBudgetProvider(
				events,
				placing(
					"fails-later",
					2,
					() =>
						new Promise((_, fail) =>
							setTimeout(() => fail(new Error("after the answer")), 40),
						),
				),
			);

			expect(await host.budgetFor("/anywhere")).toEqual({
				name: "delta",
				provider: "names",
			});
			// Past the late failure, for a leak to surface.
			await new Promise((settle) => setTimeout(settle, 100));
			expect(leaked).toEqual([]);
		} finally {
			process.off("unhandledRejection", catchLeak);
		}
	});

	it("leaves no rejection behind when telling a trouble throws, once the answer is in", async () => {
		const leaked: unknown[] = [];
		const catchLeak = (reason: unknown) => leaked.push(reason);
		process.on("unhandledRejection", catchLeak);
		try {
			const events = bus();
			const told: string[] = [];
			const host = hostBudgets(events, 20, (trouble) => {
				told.push(trouble.provider);
				throw new Error("the journal is shut");
			});
			registerBudgetProvider(
				events,
				placing("names", 0, async () => "delta"),
			);
			registerBudgetProvider(
				events,
				placing("late", 1, () => new Promise(() => {})),
			);

			expect(await host.budgetFor("/anywhere")).toEqual({
				name: "delta",
				provider: "names",
			});
			await new Promise((settle) => setTimeout(settle, 100));
			expect(told).toEqual(["late"]);
			expect(leaked).toEqual([]);
		} finally {
			process.off("unhandledRejection", catchLeak);
		}
	});

	it("answers as soon as the first to name one and every provider before it have said", async () => {
		const events = bus();
		const host = hostBudgets(events, 5_000);
		registerBudgetProvider(
			events,
			placing("first", 0, async () => "delta"),
		);
		registerBudgetProvider(
			events,
			placing("hung", 1, () => new Promise(() => {})),
		);

		const started = Date.now();
		expect(await host.budgetFor("/anywhere")).toEqual({
			name: "delta",
			provider: "first",
		});
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
