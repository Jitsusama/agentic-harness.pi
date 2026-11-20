/**
 * Whose conversation a child holds: ids the roster spells in another
 * case, and one a forsaken child claims from the child that runs it.
 */

import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { slotOf } from "../../../host/service/child-units.ts";
import {
	a,
	b,
	childOf,
	conversation,
	entry,
	folder,
	key,
	reported,
	roster,
	routes,
	superviseAgain,
	superviseEachTest,
	supervisor,
	units,
} from "./support/supervised-children.ts";

superviseEachTest();

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
		// As a host killed before its stop of the child took.
		units.lingers = true;
		childOf(b).say({
			type: "became",
			previousId: b,
			conversation: conversation(a),
			entry: entry(a),
		});
		await vi.waitFor(() => expect(units.stopped).toContain(slotB.unit));
		superviseAgain({ nextHost: true });
		units.stopped.length = 0;

		expect(await supervisor.adopt(), "children taken up").toBe(1);

		expect(routes.routeOf(a)?.identity, "a's own child").toEqual(own);
		await vi.waitFor(() =>
			expect(units.stopped, "the forsaken child").toContain(slotB.unit),
		);
	});
});
