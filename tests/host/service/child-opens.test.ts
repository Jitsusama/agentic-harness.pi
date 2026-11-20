/** The host opening new conversations in children of their own, and taking up again the children an earlier host left running. */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { slotOf, writeSlot } from "../../../host/service/child-units.ts";
import type { SessionIdentity } from "../../../host/service/protocol.ts";
import {
	a,
	b,
	childOf,
	conversation,
	derived,
	ended,
	entry,
	folder,
	key,
	LISTENS_AFTER_MS,
	line,
	opening,
	pauseFor,
	reported,
	roster,
	routes,
	said,
	slotNamed,
	superviseAgain,
	superviseEachTest,
	supervisor,
	units,
} from "./support/supervised-children.ts";

superviseEachTest();

describe("a new conversation", () => {
	it("is opened by its child, which the host then routes to under the id it answers", async () => {
		const reply = await supervisor.begin({
			...opening("open-1"),
			expectedHost: { key, owner: { pid: 1, startedAt: 1 } },
		});

		expect(reply).toMatchObject({ id: "open-1", ok: true });
		const opened = reply.ok ? (reply.result as SessionIdentity) : undefined;
		const child = childOf(opened?.sessionId ?? "");
		expect(child.asked[0], "asked without the host's identity").toEqual(
			opening("open-1"),
		);
		expect(routes.routeOf(opened?.sessionId ?? "")?.identity).toEqual(
			child.identity,
		);
		const slot = child.slot;
		expect(
			JSON.parse(await readFile(slot.file, "utf8")),
			"a slot naming none",
		).toEqual({});
		expect(roster.held, "held as its child derived it").toEqual([
			entry(a),
			derived(opened?.sessionId ?? ""),
		]);
	});

	it("tells the caller its child's refusal, and stops that child", async () => {
		units.next = { refuses: true };

		const reply = await supervisor.begin({
			...opening("open-2"),
			cwd: "/nowhere",
		});

		expect(reply).toMatchObject({
			id: "open-2",
			ok: false,
			error: { message: "no such folder" },
		});
		expect(units.stopped).toEqual(units.started);
		expect(routes.listed()).toEqual([]);
		const slot = slotNamed(units.started[0] ?? "");
		expect(existsSync(slot.file), "its slot is cleared").toBe(false);
	});

	it("fails, and stops its child, when the roster won't hold what it opened", async () => {
		roster.refuses = true;

		await expect(supervisor.begin(opening("open-3"))).rejects.toThrow(
			"can't be written",
		);

		expect(units.stopped).toEqual(units.started);
		expect(routes.listed()).toEqual([]);
	});

	it("names the conversation a child built but never answered for, holding it", async () => {
		units.next = { opensUnanswered: true };

		const reply = await supervisor.begin(opening("open-5"));

		expect(reply).toMatchObject({
			id: "open-5",
			ok: false,
			error: { code: "open_unsettled" },
		});
		const [running] = routes.listed();
		expect(running, "routed to").toBeDefined();
		expect(reply.ok ? "" : reply.error.message).toContain(
			running?.sessionId ?? "none",
		);
		expect(roster.held).toEqual([entry(a), derived(running?.sessionId ?? "")]);
		expect(units.stopped, "left running").toEqual([]);
	});

	it("asks nothing of its child when the host stops watching as it starts", async () => {
		const beginning = supervisor.begin(opening("open-6"));
		// Its unit has started, and its child listens a moment later.
		await vi.waitFor(() => expect(units.started).toHaveLength(1));

		supervisor.close();

		await expect(beginning).rejects.toThrow("stopped watching");
		await pauseFor(LISTENS_AFTER_MS * 2);
		const [child] = [...units.children.values()];
		expect(child?.asked ?? [], "nothing asked").toEqual([]);
		expect(units.stopped).toEqual([]);
	});

	it("tells the caller a child that never answers doesn't, and stops it", async () => {
		units.next = { silent: true };

		const reply = await supervisor.begin(opening("open-4"));

		expect(reply).toMatchObject({
			id: "open-4",
			ok: false,
			error: { code: "child_unreachable" },
		});
		expect(units.stopped).toEqual(units.started);
	});
});

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
		expect(said).toEqual([expect.stringContaining("could not be watched")]);
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

	it("leaves a child that is leaving to the next host when it stops watching", async () => {
		await supervisor.resume(entry(a));
		const slot = slotOf(folder, key, a);
		childOf(a).say({ type: "ending", why: "parked" });
		await vi.waitFor(() => expect(ended).toEqual([[a, "parked"]]));

		supervisor.close();
		await pauseFor(800);

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
		await pauseFor(LISTENS_AFTER_MS);
		expect(ended, "no ending is taken from a child no longer watched").toEqual(
			[],
		);
	});
});
