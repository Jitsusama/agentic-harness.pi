/** What a child the host supervises says of its conversation, and how the host takes it. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { slotOf } from "../../../host/service/child-units.ts";
import {
	a,
	b,
	childOf,
	conversation,
	ended,
	entry,
	folder,
	key,
	LISTENS_AFTER_MS,
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

describe("what a child says", () => {
	it("keeps the state it reports in the list", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({
			type: "state",
			conversation: { ...conversation(a), state: "busy" },
		});

		await vi.waitFor(() =>
			expect(routes.listed()[0]?.state, "the state the child said").toBe(
				"busy",
			),
		);
	});

	it("moves the route when its conversation becomes another", async () => {
		await supervisor.resume(entry(a));
		const route = routes.routeOf(a);

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});

		await vi.waitFor(() => expect(routes.routeOf(b)).toEqual(route));
		expect(routes.routeOf(a)).toBeUndefined();
		await vi.waitFor(() =>
			expect(roster.held, "held in the old one's place").toEqual([entry(b)]),
		);
	});

	it("says a conversation has left once its child became another, which runs on in its slot", async () => {
		await supervisor.resume(entry(a));
		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});
		await vi.waitFor(() => expect(routes.routeOf(b)).toBeDefined());

		await supervisor.left(a);

		await expect(supervisor.left(b), "b runs there").rejects.toThrow(
			"still runs",
		);
	});

	it("holds what its conversation became when the roster no longer held it", async () => {
		await supervisor.resume(entry(a));
		roster.held = [];

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});

		await vi.waitFor(() => expect(roster.held).toEqual([entry(b)]));
		expect(reported).toEqual([]);
	});

	it("lets the hold of what its conversation became go when it closes", async () => {
		await supervisor.resume(entry(a));
		const child = childOf(a);
		child.say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});
		await vi.waitFor(() => expect(roster.held).toEqual([entry(b)]));

		await child.end("closed");

		await vi.waitFor(() => expect(ended).toEqual([[b, "closed"]]));
		await vi.waitFor(() => expect(roster.held, "no hold left").toEqual([]));
		expect(routes.routeOf(b)).toBeUndefined();
	});

	it("stops a child that becomes a conversation another child runs", async () => {
		roster.held = [entry(a), entry(b)];
		await supervisor.resume(entry(a));
		await supervisor.resume(entry(b));
		const route = routes.routeOf(b);

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});

		await vi.waitFor(() =>
			expect(units.stopped).toEqual([slotOf(folder, key, a).unit]),
		);
		expect(String(reported[0])).toContain("which another child runs");
		expect(routes.routeOf(b), "the other child's route kept").toEqual(route);
		expect(routes.routeOf(a), "no route to what it ran").toBeUndefined();
		expect(roster.held, "each hold kept").toEqual([entry(a), entry(b)]);
	});

	it("lets the route and the slot go when the child says it ends", async () => {
		await supervisor.resume(entry(a));
		const slot = slotOf(folder, key, a);

		await childOf(a).end("parked");

		await vi.waitFor(() => expect(ended).toEqual([[a, "parked"]]));
		expect(routes.routeOf(a)).toBeUndefined();
		await vi.waitFor(() => {
			expect(existsSync(slot.file), "the slot's file is gone").toBe(false);
			expect(existsSync(slot.folder), "the child's own folder is gone").toBe(
				false,
			);
		});
		expect(said).toEqual([
			expect.stringContaining("its process ended, parked"),
		]);
		expect(roster.held, "kept to resume later").toEqual([entry(a)]);
		await vi.waitFor(() =>
			expect(units.forgotten, "systemd forgets its unit").toEqual([slot.unit]),
		);
	});

	it("lets the roster's hold go only when the child says it closed", async () => {
		await supervisor.resume(entry(a));

		await childOf(a).end("closed");

		await vi.waitFor(() => expect(roster.held, "no hold left").toEqual([]));
	});

	it("stops trusting a child that says what it can't read", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({ type: "became", previousId: "not an id" });

		await vi.waitFor(() => expect(ended).toEqual([[a, "failed"]]));
		expect(routes.routeOf(a)).toBeUndefined();
		const slot = slotOf(folder, key, a);
		await vi.waitFor(() => {
			expect(units.stopped, "the child, still running, is stopped").toEqual([
				slot.unit,
			]);
			expect(existsSync(slot.file), "its slot is cleared").toBe(false);
		});
	});

	it("gives a child that said it ends a while to exit, then stops it", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({ type: "ending", why: "parked" });

		const slot = slotOf(folder, key, a);
		// Well inside its 500 ms to exit.
		await pause(200);
		expect(units.stopped, "not stopped while it may still exit").toEqual([]);
		await vi.waitFor(
			() => {
				expect(units.stopped).toEqual([slot.unit]);
				expect(existsSync(slot.file), "its slot is cleared").toBe(false);
			},
			{ timeout: 3_000 },
		);
	});

	it("takes no became whose entry names another conversation", async () => {
		await supervisor.resume(entry(a));
		const route = routes.routeOf(a);

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry("c0000000-0000-4000-8000-000000000003"),
		});

		await vi.waitFor(() =>
			expect(String(reported[0])).toContain(`became ${b}, but holds`),
		);
		expect(route, "routed before").toBeDefined();
		expect(routes.routeOf(a), "nor to what it said it ran").toBeUndefined();
		expect(routes.routeOf(b), "no route to what it became").toBeUndefined();
		expect(roster.held).toEqual([entry(a)]);
		await vi.waitFor(() => expect(units.stopped).toHaveLength(1));
	});

	it("stops a child that becomes a conversation the roster holds parked", async () => {
		roster.held = [entry(a), entry(b)];
		await supervisor.resume(entry(a));
		const slotA = slotOf(folder, key, a);
		units.lingers = true;

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});

		await vi.waitFor(() => expect(units.stopped).toEqual([slotA.unit]));
		expect(String(reported[0])).toContain("the roster holds already");
		expect(routes.routeOf(b), "no route to the parked one").toBeUndefined();
		expect(routes.routeOf(a), "nor to what it ran").toBeUndefined();
		// Its process runs b's file until it goes, so b waits for it.
		await expect(supervisor.resume(entry(b))).rejects.toThrow(
			`${b} still runs in ${slotA.unit}`,
		);
		expect(units.started, "no second process on b's file").toEqual([
			slotA.unit,
		]);
	});

	it("stops a child whose became the roster won't hold", async () => {
		await supervisor.resume(entry(a));
		roster.refuses = true;

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});

		await vi.waitFor(() =>
			expect(units.stopped).toEqual([slotOf(folder, key, a).unit]),
		);
		expect(routes.listed(), "routed to nothing").toEqual([]);
		expect(String(reported[0])).toContain("can't be written");
		expect(said).toEqual([expect.stringContaining("couldn't be held")]);
	});

	it("takes no became onto another child's conversation spelled in capitals", async () => {
		roster.held = [entry(a), entry(b)];
		await supervisor.resume(entry(a));
		await supervisor.resume(entry(b));
		const upper = b.toUpperCase();

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(upper),
			entry: entry(upper),
		});

		await vi.waitFor(() =>
			expect(String(reported[0])).toContain("which another child runs"),
		);
		expect(routes.routeOf(b), "b's own child still routed").toBeDefined();
		expect(roster.held).toEqual([entry(a), entry(b)]);
		await vi.waitFor(() =>
			expect(units.stopped).toEqual([slotOf(folder, key, a).unit]),
		);
	});

	it("writes what its conversation became into its slot, for the next host", async () => {
		await supervisor.resume(entry(a));
		const slot = slotOf(folder, key, a);

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});

		await vi.waitFor(async () =>
			expect(JSON.parse(await readFile(slot.file, "utf8"))).toEqual({
				session: entry(b),
				was: a,
			}),
		);
	});

	it("starts what a conversation became only once the slot it ran in is empty", async () => {
		superviseAgain({ clocks: { exitsWithinMs: 3_000 } });
		await supervisor.resume(entry(a));
		const last = childOf(a);
		last.say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});
		await vi.waitFor(() => expect(roster.held).toEqual([entry(b)]));
		last.say({ type: "ending", why: "parked" });
		await vi.waitFor(() => expect(ended).toEqual([[b, "parked"]]));

		const again = supervisor.resume(entry(b), true);
		// It exits a while after it says it ends, as a real one does.
		setTimeout(() => void last.exit(), LISTENS_AFTER_MS * 2);
		await again;

		const slotA = slotOf(folder, key, a);
		expect(units.started, "b's own slot, after a's emptied").toEqual([
			slotA.unit,
			slotOf(folder, key, b).unit,
		]);
		expect(units.children.has(slotA.unit), "the last one went first").toBe(
			false,
		);
	});

	it("reads a state it doesn't know as busy, as a newer child's may be", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({
			type: "state",
			conversation: { ...conversation(a), state: "compacting" },
		});

		await vi.waitFor(() => expect(routes.listed()[0]?.state).toBe("busy"));
		expect(ended).toEqual([]);
	});

	it("follows a became carrying a state it doesn't know", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: { ...conversation(b), state: "compacting" },
			entry: entry(b),
		});

		await vi.waitFor(() => expect(routes.routeOf(b)).toBeDefined());
		expect(ended).toEqual([]);
	});

	it("keeps only the entry fields it knows in the roster", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: { ...entry(b), colour: "teal" },
		});

		await vi.waitFor(() => expect(roster.held).toEqual([entry(b)]));
		expect(roster.held[0]).not.toHaveProperty("colour");
	});

	it("takes no word on another conversation than its own", async () => {
		await supervisor.resume(entry(a));
		const route = routes.routeOf(a);

		childOf(a).say({
			type: "became",
			previousId: b,
			conversation: conversation(a),
			entry: entry(a),
		});

		await vi.waitFor(() => expect(reported).toHaveLength(1));
		expect(routes.routeOf(a)).toEqual(route);
		expect(roster.held).toEqual([entry(a)]);
	});

	it("reads a line carrying more than it knows, as a newer child's would", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({
			type: "state",
			conversation: { ...conversation(a), state: "busy", colour: "teal" },
		});

		await vi.waitFor(() => expect(routes.listed()[0]?.state).toBe("busy"));
		expect(ended).toEqual([]);
		expect(routes.listed()[0], "only what it reads").not.toHaveProperty(
			"colour",
		);
	});

	it("is watched when a newer child's answer carries more, nested too", async () => {
		units.next = {
			answers: (result) => ({
				...result,
				colour: "teal",
				host: {
					key,
					owner: { pid: 7, startedAt: 7, cgroup: "pi.slice" },
					region: "north",
				},
			}),
		};

		await supervisor.resume(entry(a));

		expect(routes.routeOf(a)?.identity).toEqual({
			key,
			owner: { pid: 7, startedAt: 7 },
		});
	});

	it("passes over a line of a kind it doesn't know, and says so", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({ type: "weather", sky: "clear" });
		childOf(a).say({
			type: "state",
			conversation: { ...conversation(a), state: "busy" },
		});

		await vi.waitFor(() => expect(routes.listed()[0]?.state).toBe("busy"));
		expect(ended).toEqual([]);
		expect(String(reported[0])).toContain("passed over a line");
	});

	it("takes an ending it can't read as a park, leaving the child to exit", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({ type: "ending", why: "migrated" });

		await vi.waitFor(() => expect(ended).toEqual([[a, "parked"]]));
		expect(roster.held, "kept to resume later").toEqual([entry(a)]);
		// A stop asked at once, after the ending was taken, would come within this.
		await pause(LISTENS_AFTER_MS);
		expect(units.stopped, "given its while to exit").toEqual([]);
	});

	it("lets the roster's hold go when the child says it was released", async () => {
		await supervisor.resume(entry(a));

		await childOf(a).end("released");

		await vi.waitFor(() => expect(roster.held, "no hold left").toEqual([]));
	});

	it("counts a child that exits without a word as failed", async () => {
		await supervisor.resume(entry(a));

		await childOf(a).exit();

		await vi.waitFor(() => expect(ended).toEqual([[a, "failed"]]));
		expect(roster.held, "kept to resume later").toEqual([entry(a)]);
	});
});
