/** The host keeping a warm spare child, which its next resume or open takes in place of starting a unit. */
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { slotOf } from "../../../host/service/child-units.ts";
import { spareMarks } from "../../../host/service/spare.ts";
import {
	a,
	b,
	deferred,
	entry,
	folder,
	key,
	LISTENS_AFTER_MS,
	opening,
	pause,
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
		// A fixed wait: nothing starting is the claim, so no event marks its
		// end; past several spare checks, a spare kept would have started.
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
		expect(units.started[0]).toBe(spare);
		expect(units.started, "a unit of its own").not.toContain(
			slotOf(folder, key, a).unit,
		);
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
		// A fixed wait: past the fake unit's start, so the spare is inside its
		// warm, which only `warms` ends, when the resume asks.
		await pause(LISTENS_AFTER_MS * 2);

		const resumed = await supervisor.resume(entry(a));

		expect(resumed.sessionId).toBe(a);
		const own = slotOf(folder, key, a);
		expect(units.started).toEqual([spare, own.unit]);
		expect(routes.routeOf(a)?.socket).toBe(own.socket);
		warms.settle();
		await vi.waitFor(() => expect(existsSync(warmMark(spare))).toBe(true));
	});

	it("is passed over once its install moved since it warmed, and replaced", async () => {
		superviseAgain({
			clocks: {
				spares: () => true,
				spareAfterMs: SPARE_AFTER_MS,
				spareCheckMs: SPARE_CHECK_MS,
				spareMoved: async (version) =>
					version === "one"
						? "the install's two changes the host's own code"
						: undefined,
			},
		});
		units.next = { spareVersion: "one" };
		await supervisor.adopt();
		const spare = await warmSpare();

		const resumed = await supervisor.resume(entry(a));

		expect(resumed.sessionId).toBe(a);
		const own = slotOf(folder, key, a);
		expect(units.started.slice(0, 2)).toEqual([spare, own.unit]);
		expect(routes.routeOf(a)?.socket).toBe(own.socket);
		expect(
			said.some((line) =>
				line.includes(
					`${spare}: passed over a warm spare, since the install's two changes`,
				),
			),
		).toBe(true);
		await vi.waitFor(() => expect(units.started).toHaveLength(3));
		await vi.waitFor(() => expect(units.stopped).toContain(spare));
		expect(reported).toEqual([]);
	});

	it("starts no sooner than its wait after a take, however often the check looks", async () => {
		const after = 400;
		superviseAgain({
			clocks: { spares: () => true, spareAfterMs: after, spareCheckMs: 20 },
		});
		// A fixed wait: nothing starting before the adopt is the claim, so no
		// event marks its end; past several checks, one would have started.
		await pause(SETTLED_MS / 3);
		expect(units.started, "before the adopt").toEqual([]);
		const adopted = Date.now();
		await supervisor.adopt();
		await warmSpare();
		expect(Date.now() - adopted).toBeGreaterThanOrEqual(after - 20);

		const took = Date.now();
		await supervisor.resume(entry(a));

		await vi.waitFor(() => expect(units.started).toHaveLength(2), {
			timeout: after * 5,
		});
		expect(Date.now() - took).toBeGreaterThanOrEqual(after - 20);
		expect(reported).toEqual([]);
	});

	it("found gone by a take is let go then, and replaced without waiting for the check", async () => {
		superviseAgain({
			clocks: {
				spares: () => true,
				spareAfterMs: SPARE_AFTER_MS,
				spareCheckMs: 60_000,
			},
		});
		let first = true;
		units.traitsOf = () => {
			const leaves = first;
			first = false;
			return { spareLeaves: leaves };
		};
		await supervisor.adopt();
		await vi.waitFor(() => expect(units.started).toHaveLength(1));
		const left = units.started[0] ?? "";
		await vi.waitFor(() => expect(units.children.has(left)).toBe(false));

		const resumed = await supervisor.resume(entry(a));

		expect(resumed.sessionId).toBe(a);
		const own = slotOf(folder, key, a);
		// Its replacement may start before or after the resume's own unit.
		expect(units.started[0]).toBe(left);
		expect(units.started).toContain(own.unit);
		expect(
			said.some((line) => line.includes(`${left}: a warm spare left untaken`)),
		).toBe(true);
		await vi.waitFor(() => expect(units.started).toHaveLength(3));
		await vi.waitFor(() =>
			expect(existsSync(slotNamed(left).file)).toBe(false),
		);
		expect(reported).toEqual([]);
	});

	it("is stopped and replaced once it runs past its warm's limit with no warm mark", async () => {
		superviseAgain({
			clocks: {
				spares: () => true,
				spareAfterMs: SPARE_AFTER_MS,
				spareCheckMs: SPARE_CHECK_MS,
				spareWarmWithinMs: 200,
			},
		});
		units.next = { warmsWhen: new Promise<void>(() => undefined) };
		await supervisor.adopt();
		await vi.waitFor(() => expect(units.started).toHaveLength(1));
		const stuck = units.started[0] ?? "";

		await vi.waitFor(() => expect(units.stopped).toContain(stuck));

		expect(
			said.some((line) =>
				line.includes(`${stuck}: stopped a spare that never warmed`),
			),
		).toBe(true);
		await vi.waitFor(() => {
			expect(units.started).toHaveLength(2);
			expect(existsSync(warmMark(units.started[1] ?? ""))).toBe(true);
		});
		expect(reported).toEqual([]);
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
		// A fixed wait: no fourth start is the claim, so no event marks its
		// end; past several spare checks, a spare still kept would have started.
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

	it("left untaken is stopped as its host stops, since no next host wants it", async () => {
		keepingSpares();
		await supervisor.adopt();
		const spare = await warmSpare();

		supervisor.close();

		await vi.waitFor(() => expect(units.stopped).toEqual([spare]));
		expect(
			units.children.has(spare),
			"the stopped spare runs on as a child",
		).toBe(false);
	});

	it("left untaken is let go by the next host, which takes up none", async () => {
		keepingSpares();
		await supervisor.adopt();
		const spare = await warmSpare();

		// Its stop as its host closes doesn't land, as when that host was
		// killed first, so the spare still runs as the next host starts.
		units.lingers = true;
		superviseAgain({ nextHost: true });
		units.lingers = false;
		expect(units.children.has(spare), "the spare stopped with its host").toBe(
			true,
		);
		const taken = await supervisor.adopt();

		expect(taken).toBe(0);
		await vi.waitFor(() =>
			expect(
				existsSync(slotNamed(spare).file),
				"the untaken spare's slot is still there",
			).toBe(false),
		);
		expect(units.children.has(spare)).toBe(false);
		expect(units.stopped).toEqual([spare, spare]);
		expect(said.some((line) => line.includes("a spare untaken"))).toBe(true);
	});

	it("starts behind the starts already waiting their turn, once one gives it back", async () => {
		// Its wait after the adopt long enough for both resumes to reach the
		// gate first, as a host start's do, however loaded the machine.
		const after = 200;
		superviseAgain({
			clocks: {
				spares: () => true,
				spareAfterMs: after,
				spareCheckMs: SPARE_CHECK_MS,
			},
		});
		roster.held = [entry(a), entry(b)];
		const listen = deferred();
		units.traitsOf = () => ({ listensWhen: listen.promise });
		await supervisor.adopt();
		const resumes = [supervisor.resume(entry(a)), supervisor.resume(entry(b))];
		await vi.waitFor(() => expect(units.started).toHaveLength(2));
		// A fixed wait: no spare starting is the claim, so no event marks its
		// end; past its wait after the adopt, one let by the gate would start.
		await pause(after * 2);
		expect(new Set(units.started)).toEqual(
			new Set([slotOf(folder, key, a).unit, slotOf(folder, key, b).unit]),
		);

		units.traitsOf = undefined;
		listen.settle();
		await Promise.all(resumes);

		await vi.waitFor(() => {
			expect(units.started).toHaveLength(3);
			expect(
				existsSync(warmMark(units.started[2] ?? "")),
				"the spare, started third, never warmed",
			).toBe(true);
		});
		expect(reported).toEqual([]);
	});

	it("holds its turn while it warms, so a start beside it waits", async () => {
		keepingSpares();
		roster.held = [entry(a), entry(b)];
		const warms = deferred();
		units.next = { warmsWhen: warms.promise };
		await supervisor.adopt();
		await vi.waitFor(() => expect(units.started).toHaveLength(1));
		const spare = units.started[0] ?? "";
		const listen = deferred();
		units.traitsOf = () => ({ listensWhen: listen.promise });
		const first = supervisor.resume(entry(a));
		const second = supervisor.resume(entry(b));
		// A fixed wait: the second not starting is the claim, so no event
		// marks its end; past a start's own, one given a turn would have.
		await pause(LISTENS_AFTER_MS * 2);
		expect(units.started).toEqual([spare, slotOf(folder, key, a).unit]);

		warms.settle();

		// Given its turn once the spare is warm, it takes that spare.
		await second;
		expect(routes.routeOf(b)?.socket).toBe(slotNamed(spare).socket);
		listen.settle();
		await first;
		expect(reported).toEqual([]);
	});

	it("gives its turn back once held as long as any start may, warm or not", async () => {
		superviseAgain({
			clocks: {
				spares: () => true,
				spareAfterMs: SPARE_AFTER_MS,
				spareCheckMs: 60_000,
				turnHeldWithinMs: 200,
			},
		});
		roster.held = [entry(a), entry(b)];
		units.next = { warmsWhen: new Promise<void>(() => undefined) };
		await supervisor.adopt();
		await vi.waitFor(() => expect(units.started).toHaveLength(1));
		const spare = units.started[0] ?? "";
		const listen = deferred();
		units.traitsOf = () => ({ listensWhen: listen.promise });
		const first = supervisor.resume(entry(a));
		const second = supervisor.resume(entry(b));

		// The first holds the other turn until it listens, so the second
		// starts only on the turn the spare gave back.
		await vi.waitFor(() =>
			expect(units.started).toContain(slotOf(folder, key, b).unit),
		);
		expect(said).toContainEqual(
			expect.stringContaining(`${spare}: a spare held its turn to start`),
		);
		listen.settle();
		await Promise.all([first, second]);
	});

	it("still warming as its host closes during a take, is stopped once the take passes it over", async () => {
		keepingSpares();
		roster.held = [entry(a)];
		units.next = { warmsWhen: new Promise<void>(() => undefined) };
		await supervisor.adopt();
		await vi.waitFor(() => expect(units.started).toHaveLength(1));
		const spare = units.started[0] ?? "";
		const answer = deferred();
		units.goneAnswers = answer.promise;
		const resume = supervisor.resume(entry(a)).catch(() => undefined);
		// The take has asked whether the spare is gone once its answer is taken.
		await vi.waitFor(() => expect(units.goneAnswers).toBeUndefined());

		supervisor.close();
		expect(units.stopped, "close stopped a spare being taken").toEqual([]);
		answer.settle();

		await vi.waitFor(() => expect(units.stopped).toEqual([spare]));
		await resume;
	});

	it("gives its turn back once its unit ends before it warms, and says so", async () => {
		superviseAgain({
			clocks: {
				spares: () => true,
				spareAfterMs: SPARE_AFTER_MS,
				spareCheckMs: 60_000,
				turnHeldWithinMs: 60_000,
			},
		});
		roster.held = [entry(a), entry(b)];
		units.next = { warmsWhen: new Promise<void>(() => undefined) };
		await supervisor.adopt();
		await vi.waitFor(() => expect(units.started).toHaveLength(1));
		const spare = units.started[0] ?? "";
		const listen = deferred();
		units.traitsOf = () => ({ listensWhen: listen.promise });
		const first = supervisor.resume(entry(a));
		const second = supervisor.resume(entry(b));
		await vi.waitFor(() =>
			expect(units.started).toContain(slotOf(folder, key, a).unit),
		);

		// Its unit ends cold, as a spare whose warm crashed does.
		units.children.delete(spare);

		await vi.waitFor(
			() => expect(units.started).toContain(slotOf(folder, key, b).unit),
			{ timeout: 10_000 },
		);
		expect(said).toContainEqual(
			expect.stringContaining(`${spare}: a spare ended before it warmed`),
		);
		listen.settle();
		await Promise.all([first, second]);
	});

	it("once warm, is never stopped as cold when it takes its mark away to leave", async () => {
		superviseAgain({
			clocks: {
				spares: () => true,
				spareAfterMs: SPARE_AFTER_MS,
				spareCheckMs: SPARE_CHECK_MS,
				spareWarmWithinMs: 200,
			},
		});
		// Leaving untaken, it unlinks its mark and runs on a moment, past the
		// checks that would stop a cold one.
		units.traitsOf = () => ({ leavesAfterMs: SETTLED_MS * 2 });
		await supervisor.adopt();
		const spare = await warmSpare();
		await vi.waitFor(() =>
			expect(said).toContainEqual(
				expect.stringContaining(`${spare}: a spare was seen warm`),
			),
		);

		await rm(warmMark(spare));
		// A fixed wait: no stop is the claim, so no event marks its end; past
		// its warm's limit and several checks, a cold one would be stopped.
		await pause(SETTLED_MS);

		expect(units.stopped).not.toContain(spare);
		expect(said.some((line) => line.includes("never warmed"))).toBe(false);
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
