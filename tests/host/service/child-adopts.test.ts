/** A host starting again taking up the children an earlier host left running; child-opens.test.ts has its new conversations. */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { slotOf, writeSlot } from "../../../host/service/child-units.ts";
import type { SessionIdentity } from "../../../host/service/protocol.ts";
import {
	a,
	b,
	childOf,
	conversation,
	deferred,
	derived,
	ended,
	entry,
	folder,
	growing,
	key,
	LISTENS_AFTER_MS,
	line,
	opening,
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

describe("a host starting again", () => {
	it("watches the children an earlier host left running and clears the slots of those gone", async () => {
		await supervisor.resume(entry(a));
		supervisor.close();
		const gone = slotOf(folder, key, b);
		await writeFile(gone.file, line({ session: entry(b) }));
		superviseAgain({ nextHost: true });

		expect(await supervisor.adopt(), "children taken up").toBe(1);

		expect(routes.routeOf(a)?.identity).toEqual(childOf(a).identity);
		expect(existsSync(gone.file), "the gone child's slot is cleared").toBe(
			false,
		);
		expect(units.started, "no child started again").toHaveLength(1);
	});

	it("takes up a child a wake waited on starved as the host restarted, starting no second one", async () => {
		superviseAgain({
			clocks: { listensWithinMs: 300, starvedWithinMs: 10_000 },
		});
		const listening = deferred();
		units.next = { listensWhen: listening.promise };
		units.spent = growing(200, 20);
		const waking = supervisor.resume(entry(a), true);
		await vi.waitFor(() =>
			expect(said.join("\n")).toContain("starved rather than stuck"),
		);

		supervisor.close();
		await expect(waking).rejects.toThrow("stopped watching");
		expect(units.stopped, "left running for the next host").toEqual([]);
		superviseAgain({ nextHost: true });
		listening.settle();

		expect(await supervisor.adopt(), "taken up").toBe(1);
		expect(routes.routeOf(a), "watched again").toBeDefined();
		const resumed = await supervisor.resume(entry(a));
		expect(resumed.sessionId).toBe(a);
		expect(units.started, "no child started again").toHaveLength(1);
		expect(units.stopped).toEqual([]);
	});

	it("stops a child a wake waited on starved as the host restarted, when it still won't listen, before starting another", async () => {
		superviseAgain({
			clocks: { listensWithinMs: 300, starvedWithinMs: 10_000 },
		});
		units.next = { neverListens: true };
		units.spent = growing(200, 20);
		const waking = supervisor.resume(entry(a), true);
		await vi.waitFor(() =>
			expect(said.join("\n")).toContain("starved rather than stuck"),
		);
		supervisor.close();
		await expect(waking).rejects.toThrow("stopped watching");
		superviseAgain({
			nextHost: true,
			clocks: { listensWithinMs: 300, starvedWithinMs: 10_000 },
		});
		const { unit } = slotOf(folder, key, a);
		const start = units.start;
		const runningAtStart: boolean[] = [];
		units.start = (named) => {
			runningAtStart.push(units.children.has(named));
			return start(named);
		};

		expect(await supervisor.adopt(), "given up at its listen time").toBe(0);
		await supervisor.resume(entry(a), false, true);

		expect(units.stopped, "the starved child stopped").toEqual([unit]);
		expect(
			runningAtStart,
			"its successor started only once it had gone",
		).toEqual([false]);
		expect(routes.routeOf(a), "watched").toBeDefined();
	});

	it("holds again a child's conversation an earlier host never held", async () => {
		await supervisor.resume(entry(a));
		// As when a host ends between its child's open and its hold.
		superviseAgain({ held: [], nextHost: true });

		await supervisor.adopt();

		expect(roster.held).toEqual([entry(a)]);
	});

	it("waits for an adopt rather than start a second child for one it takes up", async () => {
		await supervisor.resume(entry(a));
		superviseAgain({ nextHost: true });

		const adopting = supervisor.adopt();
		const resumed = await supervisor.resume(entry(a));

		expect(await adopting, "children taken up").toBe(1);
		expect(resumed.sessionId).toBe(a);
		expect(units.started, "no child started again").toHaveLength(1);
	});

	it("tries again a child that takes its watch but answers none, as a busy one may", async () => {
		const slot = slotOf(folder, key, a);
		await writeSlot(slot, entry(a));
		units.next = { unansweredWatches: 2 };
		await units.start(slot.unit);
		await vi.waitFor(() =>
			expect(units.children.get(slot.unit), "it listens").toBeDefined(),
		);

		expect(await supervisor.adopt(), "children taken up").toBe(1);

		expect(routes.routeOf(a)).toBeDefined();
		expect(units.stopped).toEqual([]);
		expect(said, "each try said").toEqual([
			`${slot.unit}: gave its watch no answer, try 1 of 3`,
			`${slot.unit}: gave its watch no answer, try 2 of 3`,
		]);
	});

	it("gives up a starved child it takes up at its listen time, so its start goes on", async () => {
		superviseAgain({
			clocks: { listensWithinMs: 300, starvedWithinMs: 10_000 },
		});
		const slot = slotOf(folder, key, a);
		await writeSlot(slot, entry(a));
		units.next = { neverListens: true };
		// Growing, as a starved child's CPU does, so only a bound gives it up.
		units.spent = growing(200, 20);
		await units.start(slot.unit);
		const asked = Date.now();

		expect(await supervisor.adopt(), "none taken up").toBe(0);

		expect(Date.now() - asked, "at its listen time").toBeLessThan(3_000);
	});

	it("gives a child it takes up its own time to answer, past its listen time", async () => {
		superviseAgain({
			clocks: { listensWithinMs: 300, answersWithinMs: 5_000 },
		});
		const slot = slotOf(folder, key, a);
		await writeSlot(slot, entry(a));
		units.next = { answersWatchAfterMs: 1_000 };
		await units.start(slot.unit);

		expect(await supervisor.adopt(), "children taken up").toBe(1);

		expect(routes.routeOf(a)).toBeDefined();
		expect(units.stopped).toEqual([]);
	});

	it("starts no child for a conversation still leaving a slot named by another id", async () => {
		const slot = slotOf(folder, key, "c0000000-0000-4000-8000-000000000003");
		await writeSlot(slot, entry(b));
		units.next = { unansweredWatches: 3 };
		await units.start(slot.unit);
		await vi.waitFor(() =>
			expect(units.children.get(slot.unit), "it listens").toBeDefined(),
		);
		units.lingers = true;

		expect(await supervisor.adopt(), "children taken up").toBe(0);

		await expect(supervisor.resume(entry(b))).rejects.toThrow(
			`${b} still runs in ${slot.unit}`,
		);
		expect(units.started, "no second process on b's file").toEqual([slot.unit]);
	}, 10_000);

	it("takes up each child once when asked to adopt twice at once", async () => {
		await supervisor.resume(entry(a));
		superviseAgain({ nextHost: true });

		const taken = await Promise.all([supervisor.adopt(), supervisor.adopt()]);

		expect(taken, "one adopt's count, given to both").toEqual([1, 1]);
		await childOf(a).end("parked");
		await vi.waitFor(() => expect(ended).toEqual([[a, "parked"]]));
		// Long enough for a second watch's ending to arrive, were there one.
		await pause(LISTENS_AFTER_MS);
		expect(ended, "one watch on it").toEqual([[a, "parked"]]);
	});

	it("holds the conversation an open's child became under the id it opened", async () => {
		const reply = await supervisor.begin(opening("open-13"));
		const opened = reply.ok ? (reply.result as SessionIdentity) : undefined;
		const child = childOf(opened?.sessionId ?? "");
		supervisor.close();
		child.conversation = conversation(b);
		child.entry = entry(b);
		superviseAgain({ nextHost: true });

		expect(await supervisor.adopt(), "children taken up").toBe(1);

		expect(
			roster.held,
			"the open's hold replaced, keeping what the host held of it",
		).toEqual([entry(a), derived(b)]);
	});

	it("takes up one of two children running one conversation, and stops the other", async () => {
		await supervisor.resume(entry(a));
		supervisor.close();
		const other = slotOf(folder, key, b);
		await writeSlot(other, entry(a));
		await units.start(other.unit);
		await vi.waitFor(() =>
			expect(units.children.get(other.unit), "it listens").toBeDefined(),
		);
		superviseAgain({ nextHost: true });

		expect(await supervisor.adopt(), "children taken up").toBe(1);

		await vi.waitFor(() => expect(units.stopped).toHaveLength(1));
		expect(routes.routeOf(a)).toBeDefined();
		expect(said).toEqual([expect.stringContaining("which another child runs")]);
	});

	it("watches a child whose unit systemd wouldn't say had gone", async () => {
		await supervisor.resume(entry(a));
		superviseAgain({ nextHost: true });
		units.goneFails = 1;

		expect(await supervisor.adopt(), "children taken up").toBe(1);

		const resumed = await supervisor.resume(entry(a));
		expect(resumed.sessionId, "the child it watches").toBe(a);
		expect(units.started, "no second child beside it").toHaveLength(1);
	});

	it("stops a child it can't watch, and says so", async () => {
		const slot = slotOf(folder, key, b);
		await writeSlot(slot, entry(b));
		units.next = { silent: true };
		await units.start(slot.unit);
		await vi.waitFor(() =>
			expect(units.children.get(slot.unit), "it listens").toBeDefined(),
		);

		expect(await supervisor.adopt(), "children taken up").toBe(0);

		await vi.waitFor(() => {
			expect(units.stopped).toEqual([slot.unit]);
			expect(existsSync(slot.file), "its slot is cleared").toBe(false);
		});
		expect(said.at(-1)).toContain("could not be watched");
		expect(reported).toHaveLength(1);
	});

	it("holds a child that became another while nothing watched it in its slot's place", async () => {
		await supervisor.resume(entry(a));
		supervisor.close();
		const child = childOf(a);
		child.conversation = conversation(b);
		child.entry = entry(b);
		superviseAgain({ nextHost: true });

		expect(await supervisor.adopt(), "children taken up").toBe(1);

		expect(roster.held, "one hold, under its new id").toEqual([entry(b)]);
		expect(routes.routeOf(b)?.socket).toBe(slotOf(folder, key, a).socket);
	});

	it("stops a child that became, while nothing watched it, one the roster holds", async () => {
		roster.held = [entry(a), entry(b)];
		await supervisor.resume(entry(a));
		supervisor.close();
		const child = childOf(a);
		// Its slot names a, so the roster's b is no hold this child took.
		child.conversation = conversation(b);
		child.entry = entry(b);
		superviseAgain({ nextHost: true });

		expect(await supervisor.adopt(), "none taken up").toBe(0);

		expect(routes.routeOf(b), "b unrouted").toBeUndefined();
		await vi.waitFor(() =>
			expect(units.stopped).toEqual([slotOf(folder, key, a).unit]),
		);
		expect(String(reported[0])).toContain("which the roster holds already");
		expect(roster.held, "the roster as it was").toEqual([entry(a), entry(b)]);
	});

	it("leaves a child that is leaving to the next host when it stops watching", async () => {
		await supervisor.resume(entry(a));
		const slot = slotOf(folder, key, a);
		childOf(a).say({ type: "ending", why: "parked" });
		await vi.waitFor(() => expect(ended).toEqual([[a, "parked"]]));

		supervisor.close();
		// Past its 500 ms to exit, when a still-watching host would stop it.
		await pause(800);

		expect(units.stopped, "not stopped after the host's stop").toEqual([]);
		expect(existsSync(slot.file), "its slot is left for an adopt").toBe(true);
	});

	it("leaves each child running when it stops watching", async () => {
		await supervisor.resume(entry(a));

		supervisor.close();

		expect(units.stopped).toEqual([]);
		expect(
			await units.gone(slotOf(folder, key, a).unit),
			"the child still runs",
		).toBe(false);
		await childOf(a).end("parked");
		// Nothing to wait on: an ending that arrives would come within this.
		await pause(LISTENS_AFTER_MS);
		expect(ended, "no ending is taken from a child no longer watched").toEqual(
			[],
		);
	});
});
