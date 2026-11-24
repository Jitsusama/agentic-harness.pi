/** The host keeping a warm spare child, which its next resume or open takes in place of starting a unit. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { spareMarks } from "../../../host/service/spare.ts";
import {
	a,
	deferred,
	entry,
	opening,
	pause,
	reported,
	routes,
	said,
	slotNamed,
	superviseAgain,
	superviseEachTest,
	supervisor,
	units,
} from "./support/supervised-children.ts";

superviseEachTest();

/** How soon a spare starts after an adopt or a take, in these cases. */
const SPARE_AFTER_MS = 30;
/** How often the supervisor looks at its spare, in these cases. */
const SPARE_CHECK_MS = 50;
/** Long enough for any spare these cases start to have started and warmed. */
const SETTLED_MS = 600;

/** A supervisor keeping spares while `wanted` says so. */
function keepingSpares(wanted: () => boolean = () => true): void {
	superviseAgain({
		clocks: {
			spares: wanted,
			spareAfterMs: SPARE_AFTER_MS,
			spareCheckMs: SPARE_CHECK_MS,
		},
	});
}

/** The mark a warm spare in `unit` writes once it is warm. */
function warmMark(unit: string): string {
	return spareMarks(slotNamed(unit).file).warm;
}

/** Wait until the first spare started is warm, and say its unit. */
async function warmSpare(): Promise<string> {
	await vi.waitFor(() => {
		expect(units.started).toHaveLength(1);
		expect(existsSync(warmMark(units.started[0] ?? ""))).toBe(true);
	});
	return units.started[0] ?? "";
}

describe("a warm spare", () => {
	it("is kept by no host whose policy asks for none", async () => {
		superviseAgain({
			clocks: { spareAfterMs: SPARE_AFTER_MS, spareCheckMs: SPARE_CHECK_MS },
		});
		await supervisor.adopt();
		await pause(SETTLED_MS);

		expect(units.started).toEqual([]);
	});

	it("starts once the host has adopted, its slot naming no conversation", async () => {
		keepingSpares();
		await supervisor.adopt();
		const unit = await warmSpare();

		expect(JSON.parse(await readFile(slotNamed(unit).file, "utf8"))).toEqual({
			spare: true,
		});
		expect(reported).toEqual([]);
	});

	it("is taken by a resume, which starts no unit, and another spare starts after", async () => {
		keepingSpares();
		await supervisor.adopt();
		const spare = await warmSpare();

		const resumed = await supervisor.resume(entry(a));

		expect(resumed.sessionId).toBe(a);
		expect(units.started, "the spare alone, so far").toEqual([spare]);
		expect(routes.routeOf(a)?.socket).toBe(slotNamed(spare).socket);
		expect(JSON.parse(await readFile(slotNamed(spare).file, "utf8"))).toEqual({
			session: entry(a),
		});
		expect(said.some((line) => line.includes("took a warm spare"))).toBe(true);
		await vi.waitFor(() => expect(units.started).toHaveLength(2));
		expect(reported).toEqual([]);
	});

	it("is taken by an open, whose child the host then routes to", async () => {
		keepingSpares();
		await supervisor.adopt();
		const spare = await warmSpare();

		const reply = await supervisor.begin(opening("o1"));

		expect(reply.ok).toBe(true);
		expect(units.started[0]).toBe(spare);
		const opened = routes.listed()[0]?.sessionId ?? "";
		expect(routes.routeOf(opened)?.socket).toBe(slotNamed(spare).socket);
		expect(reported).toEqual([]);
	});

	it("is passed over while it still warms, the resume starting its own unit", async () => {
		keepingSpares();
		const warms = deferred();
		units.next = { warmsWhen: warms.promise };
		await supervisor.adopt();
		await vi.waitFor(() => expect(units.started).toHaveLength(1));
		const spare = units.started[0] ?? "";

		const resumed = await supervisor.resume(entry(a));

		expect(resumed.sessionId).toBe(a);
		expect(units.started).toEqual([spare, slotNamed(a).unit]);
		expect(routes.routeOf(a)?.socket).toBe(slotNamed(a).socket);
		warms.settle();
		await vi.waitFor(() => expect(existsSync(warmMark(spare))).toBe(true));
	});

	it("is let go and replaced once it leaves untaken", async () => {
		keepingSpares();
		let first = true;
		units.traitsOf = () => {
			const leaves = first;
			first = false;
			return { spareLeaves: leaves };
		};
		await supervisor.adopt();

		await vi.waitFor(() => expect(units.started).toHaveLength(2));
		const [left, next] = units.started;
		await vi.waitFor(() =>
			expect(existsSync(slotNamed(left ?? "").file)).toBe(false),
		);
		expect(said.some((line) => line.includes("left untaken"))).toBe(true);
		await vi.waitFor(() => expect(existsSync(warmMark(next ?? ""))).toBe(true));
		expect(reported).toEqual([]);
	});

	it("is given up once three in a row leave soon after starting", async () => {
		keepingSpares();
		units.traitsOf = () => ({ spareLeaves: true });
		await supervisor.adopt();

		await vi.waitFor(() =>
			expect(said.some((line) => line.includes("keeps no warm spare"))).toBe(
				true,
			),
		);
		await pause(SETTLED_MS);
		expect(units.started).toHaveLength(3);
	});

	it("is stopped once the policy no longer asks for one", async () => {
		let wanted = true;
		keepingSpares(() => wanted);
		await supervisor.adopt();
		const spare = await warmSpare();

		wanted = false;

		await vi.waitFor(() => expect(units.stopped).toEqual([spare]));
		await vi.waitFor(() =>
			expect(existsSync(slotNamed(spare).file)).toBe(false),
		);
		expect(units.started).toEqual([spare]);
	});

	it("left untaken is stopped by the next host, which takes up none", async () => {
		keepingSpares();
		await supervisor.adopt();
		const spare = await warmSpare();

		superviseAgain({ nextHost: true });
		const taken = await supervisor.adopt();

		expect(taken).toBe(0);
		await vi.waitFor(() => expect(units.stopped).toEqual([spare]));
		expect(said.some((line) => line.includes("a spare untaken"))).toBe(true);
	});

	it("once taken, is taken up by the next host as the conversation it runs", async () => {
		keepingSpares();
		await supervisor.adopt();
		const spare = await warmSpare();
		await supervisor.resume(entry(a));

		superviseAgain({ nextHost: true });
		const taken = await supervisor.adopt();

		expect(taken).toBe(1);
		expect(routes.routeOf(a)?.socket).toBe(slotNamed(spare).socket);
		expect(units.stopped).not.toContain(spare);
	});

	it("frees its slot once what it ran parks, and the next wake takes the next spare", async () => {
		keepingSpares();
		await supervisor.adopt();
		const first = await warmSpare();
		await supervisor.resume(entry(a));
		await vi.waitFor(() => {
			expect(units.started).toHaveLength(2);
			expect(existsSync(warmMark(units.started[1] ?? ""))).toBe(true);
		});
		const second = units.started[1] ?? "";

		await units.children.get(first)?.end("parked");
		await supervisor.left(a);
		await supervisor.resume(entry(a), true);

		expect(existsSync(slotNamed(first).file)).toBe(false);
		expect(routes.routeOf(a)?.socket).toBe(slotNamed(second).socket);
		expect(units.started.slice(0, 2)).toEqual([first, second]);
		expect(reported).toEqual([]);
	});
});
