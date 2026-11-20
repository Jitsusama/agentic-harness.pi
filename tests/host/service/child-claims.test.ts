/**
 * Whose conversation a child holds: ids the roster spells in another
 * case, and one a forsaken child claims from the child that runs it.
 */

import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { slotForsaken, slotOf } from "../../../host/service/child-units.ts";
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

	it("resumes a conversation in its own slot after another child claimed it and won't stop", async () => {
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

		await supervisor.resume(entry(a));
		expect(units.started, "a started again in its own slot").toEqual([
			slotA.unit,
			slotOf(folder, key, b).unit,
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
		expect(units.started, "no second child on a's file").toEqual([
			slotB.unit,
		]);
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
	});
});
