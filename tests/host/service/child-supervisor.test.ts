/** The host starting and watching the children that run its resumed conversations, and letting each go. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { childSupervisor } from "../../../host/service/child-supervisor.ts";
import { slotOf } from "../../../host/service/child-units.ts";
import {
	a,
	b,
	childOf,
	conversation,
	deferred,
	ended,
	entry,
	folder,
	key,
	LISTENS_AFTER_MS,
	pause,
	reported,
	roster,
	routes,
	superviseAgain,
	superviseEachTest,
	supervisor,
	units,
} from "./support/supervised-children.ts";

superviseEachTest();

describe("a resumed conversation", () => {
	it("tells a child woken from a park that it was, so it doesn't rest parked again", async () => {
		await supervisor.resume(entry(a), true);

		const slot = slotOf(folder, key, a);
		expect(JSON.parse(await readFile(slot.file, "utf8"))).toEqual({
			session: entry(a),
			woken: true,
		});
	});

	it("starts its child in a slot naming its roster entry, and routes to it once it listens", async () => {
		const resumed = await supervisor.resume(entry(a));

		const slot = slotOf(folder, key, a);
		expect(units.started).toEqual([slot.unit]);
		expect(JSON.parse(await readFile(slot.file, "utf8"))).toEqual({
			session: entry(a),
		});
		expect(resumed.sessionId).toBe(a);
		expect(routes.routeOf(a)).toEqual({
			socket: slot.socket,
			identity: childOf(a).identity,
		});
		expect(routes.listed().map(({ sessionId }) => sessionId)).toEqual([a]);
		expect(roster.held, "held once").toEqual([entry(a)]);
		expect(reported).toEqual([]);
	});

	it("starts one child when it is asked for twice at once", async () => {
		const [first, second] = await Promise.all([
			supervisor.resume(entry(a)),
			supervisor.resume(entry(a)),
		]);
		const third = await supervisor.resume(entry(a));

		expect(units.started, "one unit started").toHaveLength(1);
		expect([first, second, third].map(({ sessionId }) => sessionId)).toEqual([
			a,
			a,
			a,
		]);
	});

	it("is given up within a second or two when its child ends before it listens", async () => {
		units.next = { diesBeforeListening: true };
		const asked = Date.now();

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			"ended before it listened",
		);
		expect(Date.now() - asked).toBeLessThan(3_000);
		await vi.waitFor(() =>
			expect(
				existsSync(slotOf(folder, key, a).file),
				"its slot is cleared",
			).toBe(false),
		);
		expect(routes.routeOf(a)).toBeUndefined();
	});

	it("waits on a child slow to listen when systemd once won't say whether it went", async () => {
		units.next = { listensWhen: pause(1_500) };
		units.goneFails = 1;

		const running = await supervisor.resume(entry(a));

		expect(running.sessionId).toBe(a);
		expect(units.stopped, "its child left running").toEqual([]);
	});

	it("is given up, and its child stopped, when the child never answers its watch", async () => {
		units.next = { silent: true };

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			"no answer within",
		);

		expect(units.stopped).toEqual(units.started);
		await vi.waitFor(() =>
			expect(
				existsSync(slotOf(folder, key, a).file),
				"its slot is cleared",
			).toBe(false),
		);
		expect(routes.routeOf(a)).toBeUndefined();
	});

	it("is stopped at once when it is refused as it says it ends", async () => {
		// A grace longer than the wait below, so a stop within it is no grace.
		superviseAgain({ clocks: { exitsWithinMs: 3_000 } });
		units.next = {
			answers: (result) => ({ ...result, conversation: conversation(b) }),
			endsAsItAnswers: true,
		};

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			`runs ${b}, not ${a} as asked`,
		);

		// Stopped once its slot is marked, for a host ending before the stop.
		await vi.waitFor(
			() =>
				expect(units.stopped, "stopped, not given its while").toEqual(
					units.started,
				),
			{ timeout: 1_000 },
		);
	});

	it("refuses a folder whose children's sockets would be too long a path", () => {
		expect(() =>
			childSupervisor({
				key,
				folder: join(folder, "x".repeat(80)),
				units,
				routes,
				roster,
				report: (error) => reported.push(error),
			}),
		).toThrow("too long a path");
		expect(units.started, "refused before any start").toEqual([]);
	});

	it("fails, starting nothing, for an id no slot can be named by", async () => {
		await expect(supervisor.resume(entry("not-an-id"))).rejects.toThrow(
			"Not a slot's name",
		);

		expect(units.started).toEqual([]);
	});

	it("starts nothing when the host stops watching before its unit starts", async () => {
		const resuming = supervisor.resume(entry(a));

		supervisor.close();

		await expect(resuming).rejects.toThrow("stopped watching");
		expect(units.started).toEqual([]);
	});

	it("fails, leaving its child running, when the host stops watching as it starts", async () => {
		const listening = deferred();
		units.next = { listensWhen: listening.promise };
		const resuming = supervisor.resume(entry(a));
		await vi.waitFor(() => expect(units.started).toHaveLength(1));

		supervisor.close();
		listening.settle();

		await expect(resuming).rejects.toThrow("stopped watching");
		const { unit } = slotOf(folder, key, a);
		// It listens later, and is left be: the next host adopts it.
		await vi.waitFor(() => expect(units.children.get(unit)).toBeDefined());
		expect(units.stopped).toEqual([]);
		expect(await units.gone(unit), "its child still runs").toBe(false);
	});

	it("ends at once when the host stops watching while its child is slow to answer", async () => {
		superviseAgain({ clocks: { answersWithinMs: 5_000 } });
		let connections = 0;
		units.next = {
			unansweredWatches: 1,
			connected: () => {
				connections += 1;
			},
		};
		const resuming = supervisor.resume(entry(a));
		await vi.waitFor(() => expect(connections, "its watch asked").toBe(1));
		const closed = Date.now();

		supervisor.close();

		await expect(resuming).rejects.toThrow("stopped watching");
		expect(Date.now() - closed, "not after its answer's time").toBeLessThan(
			1_000,
		);
		expect(routes.listed()).toEqual([]);
	});

	it("frees its slot when systemd refuses to start its unit", async () => {
		units.refusesStart = true;

		await expect(supervisor.resume(entry(a))).rejects.toThrow("Unit not found");
		// Freed by the failed start's own leave, not by the next start's ask.
		const slot = slotOf(folder, key, a);
		// The leave clears the slot and then forgets the unit, so wait for both.
		await vi.waitFor(() => {
			expect(existsSync(slot.file), "its slot is cleared").toBe(false);
			expect(units.forgotten, "its unit forgotten").toEqual([slot.unit]);
		});

		const resumed = await supervisor.resume(entry(a));
		expect(resumed.sessionId, "started once systemd would").toBe(a);
		expect(units.started).toHaveLength(2);
	});

	it("takes up a child naming its conversation in another case than asked", async () => {
		const upper = a.toUpperCase();
		roster.held = [entry(upper)];
		units.next = {
			answers: (result) => ({
				...result,
				conversation: conversation(a),
				entry: entry(a),
			}),
		};

		const resumed = await supervisor.resume(entry(upper));

		expect(resumed.sessionId).toBe(a);
		expect(units.stopped).toEqual([]);
		expect(roster.held, "held once").toEqual([entry(upper)]);
	});

	it("fails, keeping no watch, when the host stops watching as its hold is written", async () => {
		superviseAgain({ held: [] });
		const writing = deferred();
		roster.written = writing.promise;
		const resuming = supervisor.resume(entry(a));
		await vi.waitFor(() =>
			expect(routes.routeOf(a), "its child answered").toBeDefined(),
		);

		supervisor.close();
		writing.settle();

		await expect(resuming).rejects.toThrow("stopped watching");
		expect(routes.routeOf(a), "no route to a child nothing watches").toBe(
			undefined,
		);
		await childOf(a).end("parked");
		// An ending that was still heard would arrive within this.
		await pause(LISTENS_AFTER_MS);
		expect(ended, "no ending is taken from a child no longer watched").toEqual(
			[],
		);
		expect(units.stopped).toEqual([]);
	});

	it("is given up, naming its unit, when its child never listens", async () => {
		superviseAgain({ clocks: { listensWithinMs: 300 } });
		units.next = { neverListens: true };

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			`${slotOf(folder, key, a).unit} did not listen within 300 ms`,
		);
	});

	it("is refused, and its child stopped, when the child runs another conversation", async () => {
		units.next = {
			answers: (result) => ({ ...result, conversation: conversation(b) }),
		};

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			`runs ${b}, not ${a} as asked`,
		);

		await vi.waitFor(() => expect(units.stopped).toEqual(units.started));
		expect(routes.listed()).toEqual([]);
	});

	it("says a conversation has not left while a child refused for answering as another still runs in its slot", async () => {
		units.lingers = true;
		units.next = {
			answers: (result) => ({ ...result, conversation: conversation(b) }),
		};
		await expect(supervisor.resume(entry(a))).rejects.toThrow("not");
		const [unit] = units.started;

		await expect(supervisor.left(a)).rejects.toThrow(
			`${a} still runs in ${unit}`,
		);
	});

	it("is refused when its child names one conversation and holds another", async () => {
		units.next = { answers: (result) => ({ ...result, entry: entry(b) }) };

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			`runs ${a} but holds ${b}`,
		);

		expect(routes.listed()).toEqual([]);
	});

	it("refuses a second start in a slot whose child runs on as another", async () => {
		await supervisor.resume(entry(a));
		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});
		await vi.waitFor(() => expect(routes.routeOf(b)).toBeDefined());
		const route = routes.routeOf(b);

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			`A child runs in ${slotOf(folder, key, a).unit} already`,
		);

		expect(units.started, "no second child").toHaveLength(1);
		expect(units.stopped, "the running one is left be").toEqual([]);
		expect(routes.routeOf(b)).toEqual(route);
	});

	it("answers an ending said with its answer, and lets its route go", async () => {
		units.next = { endsAsItAnswers: true };

		const resumed = await supervisor.resume(entry(a));

		expect(resumed.sessionId).toBe(a);
		await vi.waitFor(() => expect(ended).toEqual([[a, "parked"]]));
		expect(routes.routeOf(a)).toBeUndefined();
		expect(roster.held, "kept to resume later").toEqual([entry(a)]);
	});

	it("starts again in its slot only once the last child there has gone", async () => {
		// Room for the last child's exit, which the test times itself.
		superviseAgain({ clocks: { exitsWithinMs: 3_000 } });
		await supervisor.resume(entry(a));
		const last = childOf(a);
		const slot = slotOf(folder, key, a);
		last.say({ type: "ending", why: "parked" });
		await vi.waitFor(() => expect(ended).toEqual([[a, "parked"]]));

		const again = supervisor.resume(entry(a), true);
		// The last child exits a little after it says it ends, as a real
		// one does once it has parked, while the wake's start waits on it.
		setTimeout(() => void last.exit(), LISTENS_AFTER_MS);
		await again;

		expect(units.started).toEqual([slot.unit, slot.unit]);
		expect(units.stopped, "the last one exited by itself").toEqual([]);
		expect(JSON.parse(await readFile(slot.file, "utf8"))).toEqual({
			session: entry(a),
			woken: true,
		});
		const now = childOf(a);
		expect(now, "a new child").not.toBe(last);
		expect(routes.routeOf(a)?.identity).toEqual(now.identity);
	});
});
