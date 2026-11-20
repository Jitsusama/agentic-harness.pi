/**
 * The budget host: registering providers, drawing on a budget, asking
 * which budget a folder draws on and judging which one work draws on.
 *
 * Long because every question the host answers walks the same
 * providers in the same precedence under the same deadline and stop,
 * and the cases share the bus and the providers built to answer them;
 * split by question, each file would rebuild the same fixture.
 */

import { describe, expect, it, vi } from "vitest";
import { hostBudgets } from "../../../lib/budget/host.ts";
import {
	BUDGET_READY,
	BUDGET_REGISTER_PROVIDER,
	BUDGET_REQUEST,
	type BudgetAnswer,
	type BudgetProvider,
	type Classify,
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

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

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

	it("waits on a provider past its deadline, and says the name it drew on then", async () => {
		const events = bus();
		const host = hostBudgets(events, 20);
		let asked = 0;
		host.registerProvider({
			id: "slow",
			precedence: 0,
			resolve: async (name) => {
				asked += 1;
				// Long past both draws' deadlines, however loaded the machine.
				await pause(400);
				return name === "delta" ? drawn("team") : { kind: "unknown" };
			},
		});
		const told: string[] = [];
		host.onDrawnLate((name) => told.push(name));

		const first = await host.draw("delta");
		const again = await host.draw("delta");

		expect(first, "the deadline passed first").toEqual({
			kind: "unavailable",
			provider: "slow",
			reason: "It didn't answer within 0.02 s.",
		});
		expect(again.kind, "the second draw is late too").toBe("unavailable");
		expect(asked, "a draw while one is late waits on it").toBe(1);
		await vi.waitFor(() => expect(told, "told").toEqual(["delta"]), {
			timeout: 3_000,
			interval: 5,
		});

		const later = await host.draw("delta");

		expect(later, "the late drawing is what a later late draw gets").toEqual({
			kind: "drawn",
			provider: "slow",
			env: { KEY: "team" },
			label: "team",
		});
		expect(told, "told once for both draws").toEqual(["delta"]);
	});

	it("waits on a late provider alone, not again on those ahead of it that answered in time", async () => {
		const events = bus();
		const host = hostBudgets(events, 20);
		let ahead = 0;
		host.registerProvider({
			id: "files",
			precedence: 0,
			resolve: async () => {
				ahead += 1;
				return { kind: "unknown" };
			},
		});
		host.registerProvider({
			id: "plane",
			precedence: 1,
			resolve: async () => {
				// Long past the deadline, however loaded the machine.
				await pause(400);
				return drawn("team");
			},
		});
		const told: string[] = [];
		host.onDrawnLate((name) => told.push(name));

		const first = await host.draw("delta");

		expect(first.kind, "the one after it late").toBe("unavailable");
		await vi.waitFor(() => expect(told, "told").toEqual(["delta"]), {
			timeout: 3_000,
			interval: 5,
		});
		expect(ahead, "the one ahead asked once").toBe(1);
	});

	it("tells a late answer that differs from the drawing that stood in", async () => {
		const events = bus();
		const host = hostBudgets(events, 20);
		let answer: BudgetAnswer = drawn("team");
		let slow = false;
		let asked = 0;
		host.registerProvider({
			id: "plane",
			precedence: 0,
			resolve: async () => {
				asked += 1;
				// Long past the deadline, however loaded the machine.
				if (slow) await pause(400);
				return answer;
			},
		});
		const told: string[] = [];
		host.onDrawnLate((name) => told.push(name));
		await host.draw("delta");
		slow = true;
		answer = { kind: "unavailable", reason: "The token was taken away." };

		const late = await host.draw("delta");

		expect(late.kind, "the last drawing stood in").toBe("drawn");
		await vi.waitFor(
			() => expect(told, "the refusal told").toEqual(["delta"]),
			{ timeout: 3_000, interval: 5 },
		);
		expect(
			await host.draw("delta"),
			"the draw the telling brings has the refusal, with its reason",
		).toEqual({
			kind: "unavailable",
			provider: "plane",
			reason: "The token was taken away.",
		});
		expect(asked, "which it had without asking again").toBe(2);
		expect(
			await host.draw("delta"),
			"the refused drawing stands in no more",
		).toEqual({
			kind: "unavailable",
			provider: "plane",
			reason: "It didn't answer within 0.02 s.",
		});
	});

	it("asks afresh once a late answer passes its bound, telling nobody and keeping what stands in", async () => {
		const events = bus();
		const host = hostBudgets(events, 20, undefined, undefined, 100);
		let asked = 0;
		host.registerProvider({
			id: "plane",
			precedence: 0,
			resolve: () => {
				asked += 1;
				return asked >= 2
					? new Promise(() => {})
					: Promise.resolve(drawn("team"));
			},
		});
		const told: string[] = [];
		host.onDrawnLate((name) => told.push(name));
		await host.draw("delta");

		const late = await host.draw("delta");
		// Each draw before the bound joins the stuck ask, and the first
		// after it asks afresh, stuck in turn.
		let after = late;
		await vi.waitFor(
			async () => {
				after = await host.draw("delta");
				expect(asked, "asked afresh past the bound").toBe(3);
			},
			{ timeout: 3_000, interval: 5 },
		);

		expect(late.kind, "the last drawing stood in").toBe("drawn");
		expect(after.kind, "and stands in still past the bound").toBe("drawn");
		expect(told, "a bound passed changes nothing to tell").toEqual([]);
	});

	it("asks a provider registered over a late one afresh", async () => {
		const events = bus();
		const host = hostBudgets(events, 20);
		host.registerProvider({
			id: "plane",
			precedence: 0,
			resolve: () => new Promise(() => {}),
		});
		await host.draw("delta");

		host.registerProvider(provider("plane", 0, { delta: drawn("team") }));

		expect((await host.draw("delta")).kind, "the new one answered").toBe(
			"drawn",
		);
	});

	it("lays nothing of a replaced provider's late answer, and waits on the new one afresh", async () => {
		const events = bus();
		const host = hostBudgets(events, 20);
		let oldAnswered = false;
		host.registerProvider({
			id: "plane",
			precedence: 0,
			resolve: async () => {
				// Long past the deadline, however loaded the machine.
				await pause(300);
				oldAnswered = true;
				return drawn("old");
			},
		});
		const told: string[] = [];
		host.onDrawnLate((name) => told.push(name));
		await host.draw("delta");
		let release = () => {};
		host.registerProvider({
			id: "plane",
			precedence: 0,
			resolve: () =>
				new Promise((answer) => {
					release = () => answer(drawn("new"));
				}),
		});
		await host.draw("delta");
		await vi.waitFor(
			() => expect(oldAnswered, "the replaced one answered").toBe(true),
			{ timeout: 3_000, interval: 5 },
		);
		// What it settles runs in the turns after it came.
		for (let turn = 0; turn < 5; turn += 1)
			await new Promise((settle) => setImmediate(settle));
		expect(told, "the replaced one's answer told nobody").toEqual([]);

		release();

		await vi.waitFor(
			() => expect(told, "the new one's late answer told").toEqual(["delta"]),
			{ timeout: 3_000, interval: 5 },
		);
		const now = await host.draw("delta");
		expect(
			now.kind === "drawn" ? now.label : now.kind,
			"the new one's drawing is drawn on, not the replaced one's",
		).toBe("new");
	});

	it("drops a provider's last drawing when it says in time it has none, though one after it is late", async () => {
		const events = bus();
		const host = hostBudgets(events, 20);
		let knows = true;
		host.registerProvider({
			id: "files",
			precedence: 0,
			resolve: async () => (knows ? drawn("team") : { kind: "unknown" }),
		});
		host.registerProvider({
			id: "plane",
			precedence: 1,
			resolve: () => new Promise(() => {}),
		});
		await host.draw("delta");
		knows = false;

		expect(
			await host.draw("delta"),
			"a budget taken out of its files stands in no more",
		).toEqual({
			kind: "unavailable",
			provider: "plane",
			reason: "It didn't answer within 0.02 s.",
		});
	});

	it("gives a draw joining an ask already late the drawing that stands in at once", async () => {
		const events = bus();
		const deadline = 1_000;
		const host = hostBudgets(events, deadline);
		let slow = false;
		host.registerProvider({
			id: "plane",
			precedence: 0,
			resolve: () =>
				slow ? new Promise(() => {}) : Promise.resolve(drawn("team")),
		});
		await host.draw("delta");
		slow = true;
		await host.draw("delta");

		const started = Date.now();
		const joined = await host.draw("delta");

		expect(joined.kind, "the last drawing stood in").toBe("drawn");
		expect(
			Date.now() - started,
			"no second deadline waited on the same ask",
		).toBeLessThan(deadline / 2);
	});

	it("reads an answer that isn't one as unavailable, leaving no rejection behind", async () => {
		const events = bus();
		const host = hostBudgets(events, 20);
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			let slow = false;
			// Over the bus, as a provider in another extension would, whose
			// answer no type checked.
			events.emit(BUDGET_REGISTER_PROVIDER, {
				id: "plane",
				precedence: 0,
				resolve: async () => {
					if (!slow) return drawn("team");
					// Long past the deadline, however loaded the machine.
					await pause(100);
					return null;
				},
			});
			const told: string[] = [];
			host.onDrawnLate((name) => told.push(name));
			await host.draw("delta");
			slow = true;
			await host.draw("delta");

			await vi.waitFor(
				() => expect(told, "the change told").toEqual(["delta"]),
				{ timeout: 3_000, interval: 5 },
			);
			expect(await host.draw("delta"), "said as no answer").toEqual({
				kind: "unavailable",
				provider: "plane",
				reason: "It answered with something that isn't a budget's answer.",
			});
			expect(rejections, "nothing left unhandled").toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});

	it("passes over a late listener that throws, and tells the rest", async () => {
		const events = bus();
		const host = hostBudgets(events, 20);
		let slow = false;
		host.registerProvider({
			id: "plane",
			precedence: 0,
			resolve: async () => {
				// Long past the deadline, however loaded the machine.
				if (slow) await pause(100);
				return slow ? drawn("team") : { kind: "unknown" };
			},
		});
		const told: string[] = [];
		host.onDrawnLate(() => {
			throw new Error("listener broke");
		});
		host.onDrawnLate((name) => told.push(name));
		await host.draw("delta");
		slow = true;
		await host.draw("delta");

		await vi.waitFor(
			() => expect(told, "the second listener told").toEqual(["delta"]),
			{ timeout: 3_000, interval: 5 },
		);
	});

	it("answers a late draw with the name's last drawing, telling nobody again", async () => {
		const events = bus();
		const host = hostBudgets(events, 20);
		let slow = false;
		let answered = 0;
		host.registerProvider({
			id: "files",
			precedence: 0,
			resolve: async () => {
				// Long past the deadline, however loaded the machine.
				if (slow) await pause(400);
				answered += 1;
				return drawn("team");
			},
		});
		const told: string[] = [];
		host.onDrawnLate((name) => told.push(name));
		await host.draw("delta");

		slow = true;
		const late = await host.draw("delta");
		await vi.waitFor(() => expect(answered, "the late answer came").toBe(2), {
			timeout: 3_000,
			interval: 5,
		});
		// What it settles runs in the turns after it came.
		for (let turn = 0; turn < 5; turn += 1)
			await new Promise((settle) => setImmediate(settle));

		expect(late, "the last drawing stands in").toEqual({
			kind: "drawn",
			provider: "files",
			env: { KEY: "team" },
			label: "team",
		});
		expect(told, "what stood in already has the late drawing").toEqual([]);
	});

	it("lets an answer in time replace the last drawing, so a late one after it stands in for nothing", async () => {
		const events = bus();
		const host = hostBudgets(events, 20);
		let answer: BudgetAnswer = drawn("team");
		let slow = false;
		host.registerProvider({
			id: "plane",
			precedence: 0,
			resolve: async () => {
				// Long past the deadline, however loaded the machine.
				if (slow) await pause(400);
				return answer;
			},
		});
		await host.draw("delta");
		answer = { kind: "unavailable", reason: "The token was taken away." };
		const refused = await host.draw("delta");

		slow = true;
		const late = await host.draw("delta");

		expect(refused.kind, "an answer in time is the answer").toBe("unavailable");
		expect(late, "no drawing stands in once one was refused").toEqual({
			kind: "unavailable",
			provider: "plane",
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
				why: "it didn't answer within 0.02 s",
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
			// Past the late failure, at 40 ms, for a leak to surface: a rejection
			// nobody handles is said once the microtasks after it drain.
			await new Promise((settle) => setTimeout(settle, 100));
			expect(leaked).toEqual([]);
		} finally {
			process.off("unhandledRejection", catchLeak);
		}
	});

	it("says nothing of a provider ranked below the one that answered, which couldn't change it", async () => {
		const events = bus();
		const troubles: unknown[] = [];
		const host = hostBudgets(events, 20, (trouble) => troubles.push(trouble));
		registerBudgetProvider(
			events,
			placing("names", 0, async () => "delta"),
		);
		registerBudgetProvider(
			events,
			placing("throws", 1, async () => {
				throw new Error("no map");
			}),
		);
		registerBudgetProvider(
			events,
			placing("late", 2, () => new Promise(() => {})),
		);

		expect(await host.budgetFor("/src/delta")).toEqual({
			name: "delta",
			provider: "names",
		});
		// Past the late one's deadline, so a word it would have had is in.
		await new Promise((settle) => setTimeout(settle, 60));
		expect(troubles).toEqual([]);
	});

	it("leaves no rejection behind when telling a trouble throws", async () => {
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
				placing("late", 0, () => new Promise(() => {})),
			);
			registerBudgetProvider(
				events,
				placing("names", 1, async () => "delta"),
			);

			expect(await host.budgetFor("/anywhere")).toEqual({
				name: "delta",
				provider: "names",
			});
			await vi.waitFor(() => expect(told).toEqual(["late"]));
			// A rejection nobody handles is said before the next macrotask.
			await new Promise((settle) => setImmediate(settle));
			expect(leaked).toEqual([]);
		} finally {
			process.off("unhandledRejection", catchLeak);
		}
	});

	it("says a failure whose words can't be had, rather than throw from its catch", async () => {
		const events = bus();
		const told: string[] = [];
		const host = hostBudgets(events, 1_000, (trouble) =>
			told.push(trouble.why),
		);
		const wordless = {
			toString(): string {
				throw new Error("no words");
			},
		};
		registerBudgetProvider(events, {
			...provider("wordless", 0, {}),
			resolve: async () => {
				throw wordless;
			},
			budgetFor: async () => {
				throw wordless;
			},
		});

		expect(await host.budgetFor("/anywhere")).toBeUndefined();
		expect(told).toEqual(["it failed: something that can't be said"]);

		// An Error too, whose message is a getter that throws.
		const unreadable = new Error("hidden");
		Object.defineProperty(unreadable, "message", {
			get(): string {
				throw new Error("no words");
			},
		});
		const second = bus();
		const saidOfError: string[] = [];
		const errorHost = hostBudgets(second, 1_000, (trouble) =>
			saidOfError.push(trouble.why),
		);
		registerBudgetProvider(second, {
			...provider("unreadable", 0, {}),
			budgetFor: async () => {
				throw unreadable;
			},
		});
		expect(await errorHost.budgetFor("/anywhere")).toBeUndefined();
		expect(saidOfError).toEqual(["it failed: something that can't be said"]);
		expect(await host.draw("delta")).toEqual({
			kind: "unavailable",
			reason: "something that can't be said",
			provider: "wordless",
		});
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

function judging(
	id: string,
	precedence: number,
	answer: BudgetProvider["budgetForWork"],
): BudgetProvider {
	return { ...provider(id, precedence, {}), budgetForWork: answer };
}

/** A classifier nothing should reach, for providers that never call it. */
const noClassifier: Classify = () => {
	throw new Error("not asked");
};

describe("the budget some work draws on, judged from what it is", () => {
	const work = { title: "Speed up walgit's pack writes" };

	it("is the first sure provider's, lowest precedence first, over an unsure one before it", async () => {
		const events = bus();
		const host = hostBudgets(events);
		registerBudgetProvider(
			events,
			judging("company", 10, async () => ({
				name: "delta",
				why: "walgit is Delta's",
				sure: true,
			})),
		);
		registerBudgetProvider(
			events,
			judging("unsure", 0, async () => ({
				name: "aquifer",
				why: "a guess",
				sure: false,
			})),
		);

		expect(await host.budgetForWork(work, noClassifier)).toEqual({
			name: "delta",
			why: "walgit is Delta's",
			sure: true,
			provider: "company",
		});
	});

	it("is the lowest precedence's of two sure providers, whichever answers first", async () => {
		const events = bus();
		const host = hostBudgets(events);
		registerBudgetProvider(
			events,
			judging("later", 10, async () => ({
				name: "delta",
				why: "",
				sure: true,
			})),
		);
		registerBudgetProvider(
			events,
			judging("first", 0, async () => {
				// A real pause is the point: the lower precedence must answer
				// after the other and still win.
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { name: "aquifer", why: "", sure: true };
			}),
		);

		expect(await host.budgetForWork(work, noClassifier)).toMatchObject({
			name: "aquifer",
			provider: "first",
		});
	});

	it("stops the classifier calls of the providers after a sure one", async () => {
		const events = bus();
		const host = hostBudgets(events, 5_000, undefined, 60_000);
		const signals: AbortSignal[] = [];
		registerBudgetProvider(
			events,
			judging("first", 0, async () => ({ name: "delta", why: "", sure: true })),
		);
		registerBudgetProvider(
			events,
			judging("after", 10, async (_work, asks) => {
				await asks({ state: {}, questions: {} });
				return { name: "aquifer", why: "", sure: true };
			}),
		);
		const classify: Classify = (_context, signal) => {
			if (signal) signals.push(signal);
			return new Promise(() => {});
		};

		expect(await host.budgetForWork(work, classify)).toMatchObject({
			provider: "first",
		});
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted, "the late provider's call is aborted").toBe(
			true,
		);
	});

	it("is nothing, not an unsure guess, when a provider that might have been sure was cut off", async () => {
		const events = bus();
		const host = hostBudgets(events, 5_000, undefined, 20);
		registerBudgetProvider(
			events,
			judging("hung", 0, () => new Promise(() => {})),
		);
		registerBudgetProvider(
			events,
			judging("unsure", 10, async () => ({
				name: "aquifer",
				why: "a guess",
				sure: false,
			})),
		);

		expect(await host.budgetForWork(work, noClassifier)).toBeUndefined();

		const stop = new AbortController();
		stop.abort();
		expect(
			await host.budgetForWork(work, noClassifier, stop.signal),
			"a stopped judgement",
		).toBeUndefined();
	});

	it("is the first unsure provider's when none is sure", async () => {
		const events = bus();
		const host = hostBudgets(events);
		for (const [id, precedence, name] of [
			["later", 10, "delta"],
			["first", 0, "aquifer"],
		] as const) {
			registerBudgetProvider(
				events,
				judging(id, precedence, async () => ({ name, why: "", sure: false })),
			);
		}

		expect(await host.budgetForWork(work, noClassifier)).toMatchObject({
			name: "aquifer",
			provider: "first",
		});
	});

	it("aborts the classifier it handed a provider at the deadline, or with the caller's signal", async () => {
		const events = bus();
		const host = hostBudgets(events, 5_000, undefined, 20);
		const signals: AbortSignal[] = [];
		const classify: Classify = (_context, signal) => {
			if (signal) signals.push(signal);
			return new Promise(() => {});
		};
		registerBudgetProvider(
			events,
			judging("slow", 0, async (_work, asks) => {
				await asks({ state: {}, questions: {} });
				return { name: "delta", why: "", sure: true };
			}),
		);

		expect(await host.budgetForWork(work, classify)).toBeUndefined();
		expect(signals[0]?.aborted, "the classifier call is aborted").toBe(true);

		const stop = new AbortController();
		const slow = hostBudgets(bus(), 5_000, undefined, 60_000);
		const stopped: AbortSignal[] = [];
		slow.registerProvider(
			judging("slow", 0, async (_work, asks) => {
				await asks({ state: {}, questions: {} });
				return { name: "delta", why: "", sure: true };
			}),
		);
		const asked = slow.budgetForWork(
			work,
			(_context, signal) => {
				if (signal) stopped.push(signal);
				return new Promise(() => {});
			},
			stop.signal,
		);
		stop.abort();
		expect(await asked).toBeUndefined();
		expect(stopped[0]?.aborted, "the provider's signal is aborted").toBe(true);
	});

	it("hands each provider the work and the session's classifier", async () => {
		const events = bus();
		const host = hostBudgets(events);
		const seen: unknown[] = [];
		const classify: Classify = async () => ({
			api: "typesafe-system-one",
			provider: "typesafe",
			model: "jev-latest",
			answers: {},
			stopReason: "stop",
			timestamp: 0,
		});
		registerBudgetProvider(
			events,
			judging("company", 0, async (given, asks) => {
				seen.push(given, await asks({ state: {}, questions: {} }));
				return { name: "none", why: "Joel's laptop", sure: true };
			}),
		);

		expect(await host.budgetForWork(work, classify)).toEqual({
			name: "none",
			why: "Joel's laptop",
			sure: true,
			provider: "company",
		});
		expect(seen[0]).toEqual(work);
		expect(seen[1]).toMatchObject({ model: "jev-latest" });
	});

	it("passes over a provider that fails, is late, can't judge or names no budget's name", async () => {
		const events = bus();
		const host = hostBudgets(events, 5_000, undefined, 20);
		registerBudgetProvider(
			events,
			judging("throws", 0, async () => {
				throw new Error("no classifier");
			}),
		);
		registerBudgetProvider(
			events,
			judging("late", 1, () => new Promise(() => {})),
		);
		registerBudgetProvider(
			events,
			judging("bad", 2, async () => ({
				name: "../escape",
				why: "",
				sure: true,
			})),
		);
		registerBudgetProvider(
			events,
			judging("silent", 3, async () => undefined),
		);
		registerBudgetProvider(events, provider("names-only", 4, {}));

		expect(await host.budgetForWork(work, noClassifier)).toBeUndefined();
	});

	it("makes a provider's why one line of at most 300 characters, and reads only true as sure", async () => {
		const events = bus();
		const host = hostBudgets(events);
		const notTrue: unknown = "yes";
		registerBudgetProvider(events, {
			...provider("wordy", 0, {}),
			budgetForWork: async () =>
				({
					name: "delta",
					why: `first line\n\nsecond ${"x".repeat(400)}`,
					sure: notTrue,
				}) as never,
		});

		const judged = await host.budgetForWork(work, noClassifier);
		expect(judged?.why).toMatch(/^first line second x/);
		expect(judged?.why).toHaveLength(300);
		expect(judged?.sure, "only true is sure").toBe(false);
	});

	it("waits one judging deadline however many providers are late", async () => {
		const events = bus();
		const host = hostBudgets(events, 5_000, undefined, 200);
		for (const id of ["one", "two", "three"]) {
			registerBudgetProvider(
				events,
				judging(id, 0, () => new Promise(() => {})),
			);
		}
		registerBudgetProvider(
			events,
			judging("last", 9, async () => ({
				name: "worldtree",
				why: "leafd",
				sure: true,
			})),
		);

		const started = Date.now();
		expect(await host.budgetForWork(work, noClassifier)).toMatchObject({
			name: "worldtree",
			provider: "last",
		});
		expect(Date.now() - started).toBeLessThan(500);
	});
});
