/**
 * Whose conversation a child holds: ids the roster spells in another
 * case, and one a forsaken child claims from the child that runs it.
 */

import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	slotForsaken,
	slotOf,
	slotWas,
	writeSlot,
} from "../../../host/service/child-units.ts";
import {
	a,
	b,
	CARRIED,
	childOf,
	conversation,
	deferred,
	ended,
	entry,
	folder,
	key,
	pause,
	reported,
	roster,
	routes,
	said,
	superviseAgain,
	superviseEachTest,
	supervisor,
	units,
} from "./support/supervised-children.ts";

superviseEachTest();

const c = "c0000000-0000-4000-8000-000000000003";
const d = "d0000000-0000-4000-8000-000000000004";
const e = "e0000000-0000-4000-8000-000000000005";

describe("whose conversation a child holds", () => {
	it("replaces the roster's hold spelled in capitals when its conversation becomes another", async () => {
		roster.held = [entry(a.toUpperCase())];
		await supervisor.resume(entry(a));

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});

		await vi.waitFor(() => expect(roster.held).toEqual([entry(b)]));
		expect(routes.routeOf(b), "routed to what it became").toBeDefined();
		expect(units.stopped, "its child kept").toEqual([]);
		expect(reported).toEqual([]);
	});

	it("lets the roster's hold spelled in capitals go when its child closes", async () => {
		roster.held = [entry(a.toUpperCase())];
		await supervisor.resume(entry(a));

		await childOf(a).end("closed");

		await vi.waitFor(() => expect(roster.held, "no hold left").toEqual([]));
	});

	it("follows a became naming its conversation in another case", async () => {
		await supervisor.resume(entry(a));
		const route = routes.routeOf(a);

		childOf(a).say({
			type: "became",
			previousId: a.toUpperCase(),
			conversation: conversation(b),
			entry: entry(b),
		});

		await vi.waitFor(() => expect(routes.routeOf(b)).toEqual(route));
		expect(routes.routeOf(a)).toBeUndefined();
		await vi.waitFor(() => expect(roster.held).toEqual([entry(b)]));
		expect(reported).toEqual([]);
	});

	it("resumes a conversation another child claimed and won't stop only once that child has gone", async () => {
		roster.held = [entry(a), entry(b)];
		await supervisor.resume(entry(a));
		await supervisor.resume(entry(b));
		const slotA = slotOf(folder, key, a);
		units.lingers = true;
		childOf(b).say({
			type: "became",
			previousId: b,
			conversation: conversation(a),
			entry: entry(a),
		});
		await vi.waitFor(() =>
			expect(String(reported[0])).toContain("which another child runs"),
		);

		await childOf(a).end("parked");
		await vi.waitFor(() =>
			expect(existsSync(slotA.file), "a's slot is cleared").toBe(false),
		);

		// Two processes would run it while the forsaken one lingers.
		const slotB = slotOf(folder, key, b);
		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			`${a} still runs in ${slotB.unit}`,
		);
		await units.children.get(slotB.unit)?.exit();
		units.children.delete(slotB.unit);

		await supervisor.resume(entry(a));
		expect(units.started, "a started again in its own slot").toEqual([
			slotA.unit,
			slotB.unit,
			slotA.unit,
		]);
	});

	it("leaves a child an earlier host forsook to be stopped, not taken up", async () => {
		roster.held = [entry(a), entry(b)];
		await supervisor.resume(entry(a));
		await supervisor.resume(entry(b));
		const slotB = slotOf(folder, key, b);
		const own = childOf(a).identity;
		const markedAtStop: unknown[] = [];
		const stop = units.stop;
		units.stop = async (unit) => {
			if (unit === slotB.unit) markedAtStop.push(await slotForsaken(slotB));
			return stop(unit);
		};
		// As a host killed before its stop of the child took.
		units.lingers = true;
		childOf(b).say({
			type: "became",
			previousId: b,
			conversation: conversation(a),
			entry: entry(a),
		});
		await vi.waitFor(() => expect(units.stopped).toContain(slotB.unit));
		expect(markedAtStop, "marked before its stop").toEqual([{ runs: a }]);
		superviseAgain({ nextHost: true });
		units.stopped.length = 0;

		expect(await supervisor.adopt(), "children taken up").toBe(1);

		expect(routes.routeOf(a)?.identity, "a's own child").toEqual(own);
		expect(said, "the next host saw the mark").toContain(
			`${slotB.unit}: stopped, since an earlier host forsook it`,
		);
		await vi.waitFor(() =>
			expect(units.stopped, "the forsaken child").toContain(slotB.unit),
		);
	});

	it("holds back a resume of what a forsaken child ran, after its host ends", async () => {
		roster.held = [entry(a), entry(b)];
		await supervisor.resume(entry(b));
		const slotB = slotOf(folder, key, b);
		units.lingers = true;
		// Onto a conversation no other child runs, so it may run a's file.
		childOf(b).say({
			type: "became",
			previousId: b,
			conversation: conversation(a),
			entry: entry(a),
		});
		await vi.waitFor(() => expect(units.stopped).toContain(slotB.unit));
		superviseAgain({ nextHost: true });

		expect(await supervisor.adopt(), "none taken up").toBe(0);

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			`still runs in ${slotB.unit}`,
		);
		expect(units.started, "no second child on a's file").toEqual([slotB.unit]);
	});

	it("keeps the forsaken mark over a slot write queued before it", async () => {
		await supervisor.resume(entry(a));
		const slotA = slotOf(folder, key, a);
		units.lingers = true;
		const disk = deferred();
		roster.written = disk.promise;
		const child = childOf(a);
		// Each became's slot write waits behind the roster change before it.
		child.say({
			type: "became",
			previousId: a,
			conversation: conversation(c),
			entry: entry(c),
		});
		child.say({
			type: "became",
			previousId: c,
			conversation: conversation(d),
			entry: entry(d),
		});
		child.say({
			type: "became",
			previousId: d,
			conversation: conversation(e),
			entry: entry(b),
		});
		await vi.waitFor(() =>
			expect(String(reported[0])).toContain(`but holds ${b}`),
		);

		disk.settle();

		await vi.waitFor(async () =>
			expect(await slotForsaken(slotA), "still marked").toEqual({ runs: e }),
		);
		expect(units.stopped, "stopped once marked").toEqual([slotA.unit]);
	});

	it("clears its slot only once the writes its watch queued have landed", async () => {
		await supervisor.resume(entry(a));
		const slotA = slotOf(folder, key, a);
		const disk = deferred();
		roster.written = disk.promise;
		const child = childOf(a);
		child.say({
			type: "became",
			previousId: a,
			conversation: conversation(c),
			entry: entry(c),
		});
		// Its slot write waits behind the first became's roster change.
		child.say({
			type: "became",
			previousId: c,
			conversation: conversation(d),
			entry: entry(d),
		});
		await child.end("parked");

		// Long past the unit's going, which frees the slot when nothing waits.
		await pause(1_000);
		expect(units.forgotten, "not cleared under a queued write").toEqual([]);
		disk.settle();

		await vi.waitFor(() => expect(units.forgotten).toEqual([slotA.unit]));
		expect(existsSync(slotA.file), "no write landed after the clear").toBe(
			false,
		);
		expect(roster.held, "the roster followed it").toEqual([entry(d)]);
	});

	it("clears its slot only once a mark a failed queued write raised has landed", async () => {
		await supervisor.resume(entry(a));
		const slotA = slotOf(folder, key, a);
		const disk = deferred();
		roster.written = disk.promise;
		const child = childOf(a);
		child.say({
			type: "became",
			previousId: a,
			conversation: conversation(c),
			entry: entry(c),
		});
		child.say({
			type: "became",
			previousId: c,
			conversation: conversation(d),
			entry: entry(d),
		});
		await child.end("parked");

		// The queued writes fail, so the child is forsaken as its slot clears.
		roster.refuses = true;
		disk.settle();

		await vi.waitFor(() => expect(units.forgotten).toEqual([slotA.unit]));
		// Time for a mark queued behind the clear to land.
		await pause(200);
		expect(existsSync(slotA.file), "no mark landed after the clear").toBe(
			false,
		);
	});

	it("replaces what a child became from when its last host ended before the roster did", async () => {
		await supervisor.resume(entry(a));
		const slotA = slotOf(folder, key, a);
		// A roster change that never lands, as a host killed first leaves it.
		roster.written = deferred().promise;
		const child = childOf(a);
		child.say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});
		await vi.waitFor(async () =>
			expect(await slotWas(slotA), "its slot names what it was").toBe(a),
		);
		// The child runs b now, which the next host's watch answers.
		child.conversation = conversation(b);
		child.entry = entry(b);
		superviseAgain({ held: [entry(a)], nextHost: true });

		expect(await supervisor.adopt(), "children taken up").toBe(1);

		expect(roster.held, "a replaced, not held beside b").toEqual([entry(b)]);
		expect(routes.routeOf(b), "routed to what it became").toBeDefined();
		expect(reported).toEqual([]);
	});

	it("stops at once a child forsaken while it leaves as it said it would", async () => {
		superviseAgain({ clocks: { exitsWithinMs: 10_000 } });
		await supervisor.resume(entry(a));
		const slotA = slotOf(folder, key, a);
		const disk = deferred();
		roster.written = disk.promise;
		const child = childOf(a);
		child.say({
			type: "became",
			previousId: a,
			conversation: conversation(c),
			entry: entry(c),
		});
		// Given its grace to exit, which it never takes.
		child.say({ type: "ending", why: "parked" });
		await vi.waitFor(() => expect(ended).toEqual([[c, "parked"]]));

		// So its became can't be held, and the child is forsaken.
		roster.refuses = true;
		disk.settle();

		await vi.waitFor(() =>
			expect(units.stopped, "stopped, not left its grace").toEqual([
				slotA.unit,
			]),
		);
		expect(units.markedAtStop, "its mark written before its stop").toEqual([
			true,
		]);
	});

	it("waits out a stop hurried during a grace before the slot's next child starts", async () => {
		superviseAgain({ clocks: { exitsWithinMs: 10_000 } });
		await supervisor.resume(entry(a));
		const slotA = slotOf(folder, key, a);
		const disk = deferred();
		roster.written = disk.promise;
		const child = childOf(a);
		child.say({
			type: "became",
			previousId: a,
			conversation: conversation(c),
			entry: entry(c),
		});
		child.say({ type: "ending", why: "parked" });
		await vi.waitFor(() => expect(ended).toEqual([[c, "parked"]]));
		// The hurried stop ends the child, but systemd answers it late, and
		// with a failure, so it is tried again.
		const answered = deferred();
		units.stopReturns = answered.promise;
		units.stopFails = 1;
		roster.refuses = true;
		disk.settle();
		await vi.waitFor(() => expect(units.stopped).toEqual([slotA.unit]));

		roster.refuses = false;
		const again = supervisor.resume(entry(a));
		// Time for a start that didn't wait on the stop to have begun.
		await pause(300);
		expect(units.started, "no child in the slot yet").toEqual([slotA.unit]);
		answered.settle();

		await again;
		// Time for a stop's late retry to reach the slot's next child.
		await pause(600);
		expect(
			units.children.get(slotA.unit),
			"the slot's next child runs on",
		).toBeDefined();
		expect(units.started).toEqual([slotA.unit, slotA.unit]);
	});

	it("starts both conversations a forsaken child ran once it has gone", async () => {
		roster.held = [entry(a), entry(b)];
		await supervisor.resume(entry(a));
		await supervisor.resume(entry(b));
		const slotA = slotOf(folder, key, a);
		const slotB = slotOf(folder, key, b);
		units.lingers = true;
		childOf(b).say({
			type: "became",
			previousId: b,
			conversation: conversation(a),
			entry: entry(a),
		});
		await vi.waitFor(() =>
			expect(String(reported[0])).toContain("which another child runs"),
		);
		await childOf(a).end("parked");
		await vi.waitFor(() =>
			expect(existsSync(slotA.file), "the parked child's slot is cleared").toBe(
				false,
			),
		);
		await vi.waitFor(
			() => expect(String(reported.at(-1))).toContain("still runs"),
			{ timeout: 4_000 },
		);
		units.lingers = false;
		await units.children.get(slotB.unit)?.exit();
		units.children.delete(slotB.unit);

		const [ranB, ranA] = await Promise.all([
			supervisor.resume(entry(b)),
			supervisor.resume(entry(a)),
		]);

		expect([ranA.sessionId, ranB.sessionId]).toEqual([a, b]);
		expect(childOf(b).slot.unit, "b in its own slot").toBe(slotB.unit);
		expect(existsSync(slotB.file), "b's slot kept for its child").toBe(true);
	});

	it("names what a child became from in its slot when it moved unwatched", async () => {
		await supervisor.resume(entry(a));
		const slotA = slotOf(folder, key, a);
		const child = childOf(a);
		supervisor.close();
		child.conversation = conversation(b);
		child.entry = entry(b);
		superviseAgain({ held: [entry(a)], nextHost: true });
		// The roster change never lands, as a host killed first leaves it.
		roster.written = deferred().promise;
		void supervisor.adopt();
		await vi.waitFor(async () =>
			expect(await slotWas(slotA), "its slot names what it was").toBe(a),
		);
		superviseAgain({ held: [entry(a)], nextHost: true });

		expect(await supervisor.adopt(), "children taken up").toBe(1);

		expect(roster.held, "a replaced, not held beside b").toEqual([entry(b)]);
	});

	it("replaces what a slot's conversation became from when its child moved on again", async () => {
		await supervisor.resume(entry(a));
		const slotA = slotOf(folder, key, a);
		const child = childOf(a);
		supervisor.close();
		// Its last host named b, became from a, and ended before the roster
		// changed; the child has since become c.
		await writeSlot(slotA, entry(b), false, a);
		child.conversation = conversation(c);
		child.entry = entry(c);
		superviseAgain({ held: [entry(a)], nextHost: true });

		expect(await supervisor.adopt(), "children taken up").toBe(1);

		expect(roster.held, "a replaced, not held beside c").toEqual([entry(c)]);
	});

	it("keeps what the host held of a conversation when it becomes another", async () => {
		const quest = "QEST-20261120-AAAAAA";
		const kept = { ...entry(a), attended: true, quest, launch: CARRIED };
		roster.held = [kept];
		await supervisor.resume(kept);

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: { ...entry(b), launch: { NODE_OPTIONS: "--require=x" } },
		});

		await vi.waitFor(() =>
			expect(roster.held).toEqual([
				{ ...entry(b), attended: true, quest, launch: CARRIED },
			]),
		);
	});
});
