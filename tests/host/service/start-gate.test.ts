/** The gate letting a few child starts through at once, those someone waits on first. */
import { describe, expect, it } from "vitest";
import { type StartAsk, startGate } from "../../../host/service/start-gate.ts";

const never = new AbortController().signal;

function ask(ahead: boolean, extra: Partial<StartAsk> = {}): StartAsk {
	return {
		ahead,
		by: Number.POSITIVE_INFINITY,
		signal: never,
		late: () => new Error("late"),
		...extra,
	};
}

/** The order `turns` settle in, by name, once the microtasks have run. */
function settling(turns: Record<string, Promise<() => void>>) {
	const order: string[] = [];
	const backs: Record<string, () => void> = {};
	for (const [name, turn] of Object.entries(turns))
		turn.then(
			(back) => {
				order.push(name);
				backs[name] = back;
			},
			() => order.push(`${name}!`),
		);
	return { order, backs };
}

const flushed = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("a start gate", () => {
	it("lets as many through as it holds, and the next as one gives its turn back", async () => {
		const gate = startGate(2);
		const { order, backs } = settling({
			a: gate.turn(ask(false)),
			b: gate.turn(ask(false)),
			c: gate.turn(ask(false)),
		});
		await flushed();
		expect(order).toEqual(["a", "b"]);
		backs.a?.();
		await flushed();
		expect(order).toEqual(["a", "b", "c"]);
	});
	it("counts a turn given back twice once", async () => {
		const gate = startGate(1);
		const { order, backs } = settling({
			a: gate.turn(ask(false)),
			b: gate.turn(ask(false)),
			c: gate.turn(ask(false)),
		});
		await flushed();
		backs.a?.();
		backs.a?.();
		await flushed();
		expect(order, "the second give-back lets no one else by").toEqual([
			"a",
			"b",
		]);
	});
	it("lets those someone waits on go first, each in the order it came", async () => {
		const gate = startGate(1);
		const { order, backs } = settling({
			held: gate.turn(ask(false)),
			r1: gate.turn(ask(false)),
			w1: gate.turn(ask(true)),
			r2: gate.turn(ask(false)),
			w2: gate.turn(ask(true)),
		});
		await flushed();
		for (const next of ["held", "w1", "w2", "r1"]) {
			backs[next]?.();
			await flushed();
		}
		expect(order).toEqual(["held", "w1", "w2", "r1", "r2"]);
	});
	it("gives a leaver's place to the next, whether it left by its time or its signal", async () => {
		const gate = startGate(1);
		const cut = new AbortController();
		const { order, backs } = settling({
			held: gate.turn(ask(false)),
			late: gate.turn(ask(false, { by: Date.now() })),
			cut: gate.turn(ask(false, { signal: cut.signal })),
			next: gate.turn(ask(false)),
		});
		cut.abort(new Error("given up"));
		// The late one's timer runs at once, its time already passed.
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(order).toEqual(["held", "cut!", "late!"]);
		backs.held?.();
		await flushed();
		expect(order.at(-1), "the one behind both takes the turn").toBe("next");
	});
	it("refuses a start whose signal ended before it asked", async () => {
		const gate = startGate(1);
		const cut = new AbortController();
		cut.abort(new Error("stopping"));
		await expect(gate.turn(ask(true, { signal: cut.signal }))).rejects.toThrow(
			"stopping",
		);
	});
	// F33: a wake for a conversation a host's start still owes waits on that
	// start, so the start goes ahead once someone waits on it.
	it("moves a waiting start ahead once it is hurried", async () => {
		const gate = startGate(1);
		const hurry = new AbortController();
		const { order, backs } = settling({
			held: gate.turn(ask(false)),
			r1: gate.turn(ask(false)),
			owed: gate.turn(ask(false, { hurry: hurry.signal })),
			w1: gate.turn(ask(true)),
		});
		await flushed();
		hurry.abort();
		for (const next of ["held", "w1", "owed"]) {
			backs[next]?.();
			await flushed();
		}
		expect(
			order,
			"behind the wake already ahead, before the resume that came first",
		).toEqual(["held", "w1", "owed", "r1"]);
	});
});
