/**
 * The host starting and watching the children that run its resumed
 * conversations, and letting each go.
 *
 * Long because each case races two of the supervisor's steps over the
 * same slots and routes, as child-supervisor.ts is long for; its opens,
 * claims and leavings already have files of their own.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	childSupervisor,
	STARTS_AT_ONCE,
} from "../../../host/service/child-supervisor.ts";
import { slotOf } from "../../../host/service/child-units.ts";
import {
	a,
	b,
	becameTold,
	childOf,
	conversation,
	deferred,
	ended,
	entry,
	folder,
	growing,
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

	it("is given up at its listen time, naming its unit, when its child spent a starved child's CPU without listening", async () => {
		superviseAgain({ clocks: { listensWithinMs: 300 } });
		units.next = { neverListens: true };
		units.spent = 20_000;

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			new Error(
				`${slotOf(folder, key, a).unit} did not listen within 300 ms, with 20000 ms of CPU`,
			),
		);
	});

	it("waits past its listen time on a child starved of CPU, and routes to it once it listens", async () => {
		superviseAgain({ clocks: { listensWithinMs: 300 } });
		units.next = { listensWhen: pause(1_500) };
		units.spent = growing(200, 20);

		const running = await supervisor.resume(entry(a), true);

		expect(running.sessionId).toBe(a);
		expect(routes.routeOf(a)?.socket).toBe(slotOf(folder, key, a).socket);
		expect(units.stopped, "its child left running").toEqual([]);
		const unit = slotOf(folder, key, a).unit;
		expect(
			said.filter((line) => line.includes("hasn't listened")),
			"said once, as it waits on",
		).toEqual([
			`${unit} hasn't listened in 300 ms, but has had only 200 ms of CPU: it is starved rather than stuck, so it is waited on`,
		]);
		expect(
			said.filter((line) => line.includes("listened after")),
			"its wait said once it listens",
		).toEqual([
			expect.stringMatching(
				new RegExp(
					`^${unit} listened after \\d+ ms, starved, having had 2\\d\\d ms of CPU$`,
				),
			),
		]);
	});

	it("is given up as stuck when its child gains no CPU for a whole listen time", async () => {
		superviseAgain({
			clocks: { listensWithinMs: 300, starvedWithinMs: 10_000 },
		});
		units.next = { neverListens: true };
		units.spent = 50;
		const asked = Date.now();

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			/did not listen within \d+ ms, with 50 ms of CPU, none of it in the last \d+ ms: it is stuck rather than starved/,
		);
		expect(Date.now() - asked, "well before the ceiling").toBeLessThan(5_000);
	}, 15_000);

	it("is given up as stuck when its child gains only a sliver of CPU over a whole listen time", async () => {
		// A listen time of two asks, so the sliver is summed across them.
		superviseAgain({
			clocks: { listensWithinMs: 2_000, starvedWithinMs: 10_000 },
		});
		units.next = { neverListens: true };
		// 1 ms a second, 0.1% of a core, under the 0.25% a starved child gains.
		units.spent = growing(50, 1);
		const asked = Date.now();

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			/did not listen within \d+ ms, with 5\d ms of CPU, only 2 ms of it in the last \d+ ms: it is stuck rather than starved/,
		);
		expect(Date.now() - asked, "well before the ceiling").toBeLessThan(8_000);
	}, 15_000);

	it("waits on a child whose CPU grows under its share at each ask but not over a whole listen time", async () => {
		// 4 ms a second, 0.4% of a core: under the 5 ms of a 2 s listen time
		// at each ask, over it across two.
		superviseAgain({
			clocks: { listensWithinMs: 2_000, starvedWithinMs: 10_000 },
		});
		// Past two listen times, so it is judged over a whole one twice.
		units.next = { listensWhen: pause(5_000) };
		units.spent = growing(50, 4);

		const running = await supervisor.resume(entry(a), true);

		expect(running.sessionId).toBe(a);
		expect(units.stopped, "its child left running").toEqual([]);
	}, 15_000);

	it("stops as stuck, naming its CPU, a child whose CPU grows at every ask but under its share over a whole listen time", async () => {
		// 1.5 ms a second, 0.15% of a core: never the 5 ms of a 2 s listen
		// time, even judged over a window a loaded machine stretches to 3 s.
		superviseAgain({
			clocks: { listensWithinMs: 2_000, starvedWithinMs: 10_000 },
		});
		units.next = { neverListens: true };
		units.spent = growing(50, 1.5);

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			/did not listen within \d+ ms, with 5[34] ms of CPU, only [34] ms of it in the last \d+ ms: it is stuck rather than starved$/,
		);
		await vi.waitFor(() =>
			expect(units.stopped, "its child stopped").toEqual(units.started),
		);
	}, 15_000);

	it("waits on a child whose first CPU ask systemd doesn't answer, asking again", async () => {
		superviseAgain({
			clocks: { listensWithinMs: 300, starvedWithinMs: 10_000 },
		});
		units.next = { listensWhen: pause(1_500) };
		const answers = [undefined, 100];
		let asks = 0;
		units.spent = () =>
			asks < answers.length ? answers[asks++] : 100 + 20 * asks++;

		const running = await supervisor.resume(entry(a), true);

		expect(running.sessionId).toBe(a);
		expect(asks, "its CPU asked again").toBeGreaterThan(1);
	});

	it("is given up once systemd hasn't said its child's CPU for two listen times", async () => {
		superviseAgain({
			clocks: { listensWithinMs: 300, starvedWithinMs: 10_000 },
		});
		units.next = { neverListens: true };
		units.spent = () => undefined;
		const asked = Date.now();

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			/did not listen within \d+ ms$/,
		);
		expect(Date.now() - asked, "past both listen times").toBeGreaterThanOrEqual(
			600,
		);
		expect(Date.now() - asked, "well before the ceiling").toBeLessThan(5_000);
	}, 15_000);

	it("gives up a starved child at its listen time when resumed bounded, as the host's start does", async () => {
		superviseAgain({
			clocks: { listensWithinMs: 300, starvedWithinMs: 10_000 },
		});
		units.next = { neverListens: true };
		units.spent = growing(200, 20);
		const asked = Date.now();

		await expect(supervisor.resume(entry(a), false, true)).rejects.toThrow(
			`${slotOf(folder, key, a).unit} did not listen within 300 ms`,
		);
		expect(Date.now() - asked, "at its listen time").toBeLessThan(3_000);
		expect(units.cpuAsks, "its CPU never asked").toBe(0);
	});

	it("is given up once a starved child spends its CPU while waited on", async () => {
		superviseAgain({
			clocks: {
				listensWithinMs: 300,
				listensWithinCpuMs: 1_000,
				starvedWithinMs: 10_000,
			},
		});
		units.next = { neverListens: true };
		units.spent = growing(100, 400);
		const asked = Date.now();

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			/did not listen within \d+ ms, with 1\d{3} ms of CPU$/,
		);
		expect(Date.now() - asked, "well before the ceiling").toBeLessThan(5_000);
	}, 15_000);

	it("keeps waiting on a starved child when systemd fails to say its CPU", async () => {
		superviseAgain({
			clocks: { listensWithinMs: 300, starvedWithinMs: 10_000 },
		});
		// It listens once its CPU has been asked through the failures, so a
		// slow machine can't have it listen first.
		let heard = (): void => undefined;
		units.next = {
			listensWhen: new Promise<void>((resolve) => {
				heard = resolve;
			}),
		};
		const answers = [100, undefined, undefined, undefined];
		let asks = 0;
		units.spent = () => {
			if (asks >= answers.length) heard();
			return asks < answers.length ? answers[asks++] : 100 + asks++;
		};

		const running = await supervisor.resume(entry(a), true);

		expect(running.sessionId).toBe(a);
		expect(asks, "its CPU asked through the failures").toBeGreaterThan(3);
		// Asked once a second, five times before it listens.
	}, 15_000);

	it("gives up a wake's resume waiting on a starved child as soon as asked, stopping that child", async () => {
		superviseAgain({
			clocks: { listensWithinMs: 300, starvedWithinMs: 10_000 },
		});
		units.next = { neverListens: true };
		units.spent = growing(200, 20);
		const resumed = supervisor.resume(entry(a), true);
		const outcome = expect(resumed).rejects.toThrow(
			`The resume of ${a} was given up before its child had it`,
		);
		await vi.waitFor(() =>
			expect(said.join("\n")).toContain("starved rather than stuck"),
		);
		const asked = Date.now();

		supervisor.giveUp(a);

		await outcome;
		expect(Date.now() - asked, "at once, not at the ceiling").toBeLessThan(
			1_000,
		);
		await vi.waitFor(() => expect(units.stopped).toEqual(units.started));
		expect(routes.listed()).toEqual([]);
	}, 15_000);

	it("gives up a wake's resume whose starved child hasn't answered its watch, stopping that child", async () => {
		superviseAgain({ clocks: { starvedWithinMs: 10_000 } });
		units.next = { silent: true };
		units.spent = growing(200, 20);
		const resumed = supervisor.resume(entry(a), true);
		const outcome = expect(resumed).rejects.toThrow("was given up");
		// Its answer is judged a second into its watch, past its 500 ms.
		await vi.waitFor(
			() => expect(said.join("\n")).toContain("hasn't answered its watch"),
			{ timeout: 5_000 },
		);

		supervisor.giveUp(a);

		await outcome;
		await vi.waitFor(() => expect(units.stopped).toEqual(units.started));
	}, 15_000);

	it("starts no child for a resume given up while it waits on an adopt", async () => {
		// A slot an earlier host left naming it, whose take-up waits on systemd.
		await writeFile(
			slotOf(folder, key, a).file,
			JSON.stringify({ session: entry(a) }),
		);
		const answering = deferred();
		units.goneAnswers = answering.promise;
		const adopting = supervisor.adopt();
		const resumed = supervisor.resume(entry(a), true);
		const outcome = expect(resumed).rejects.toThrow("was given up");

		supervisor.giveUp(a);
		answering.settle();

		await outcome;
		await adopting;
		expect(units.started, "no child started").toEqual([]);
	});

	it("gives up nothing of a conversation whose child has it, nor of one not starting", async () => {
		supervisor.giveUp(a);
		await supervisor.resume(entry(a));

		supervisor.giveUp(a);

		expect(routes.routeOf(a), "still routed to its child").toBeDefined();
		expect(units.stopped).toEqual([]);
	});

	it("stops waiting on a starved child whose unit ends", async () => {
		superviseAgain({
			clocks: { listensWithinMs: 300, starvedWithinMs: 10_000 },
		});
		units.next = { neverListens: true };
		units.spent = growing(0, 50);
		const unit = slotOf(folder, key, a).unit;
		const asked = Date.now();
		const resumed = supervisor.resume(entry(a));
		const outcome = expect(resumed).rejects.toThrow(
			`${unit} ended before it listened`,
		);
		// Past its first ask of whether its unit has gone, a second in.
		await pause(1_200);
		units.children.delete(unit);

		await outcome;
		expect(Date.now() - asked, "well before the ceiling").toBeLessThan(5_000);
	}, 15_000);

	it("is given up at its listen time when its child spent its CPU without listening", async () => {
		superviseAgain({
			clocks: { listensWithinMs: 300, listensWithinCpuMs: 1_000 },
		});
		units.next = { neverListens: true };
		units.spent = 1_000;
		const asked = Date.now();

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			`${slotOf(folder, key, a).unit} did not listen within 300 ms, with 1000 ms of CPU`,
		);
		expect(Date.now() - asked).toBeLessThan(3_000);
	});

	it("is given up once a starved child has had all the time it may wait", async () => {
		superviseAgain({
			clocks: { listensWithinMs: 300, starvedWithinMs: 1_200 },
		});
		units.next = { neverListens: true };
		units.spent = growing(0, 50);
		const asked = Date.now();

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			new RegExp(
				`${slotOf(folder, key, a).unit} did not listen within 1200 ms, with \\d+ ms of CPU$`,
			),
		);
		expect(Date.now() - asked, "past its listen time").toBeGreaterThanOrEqual(
			1_200,
		);
	});

	it("waits past its answer time on a child starved of CPU as it builds its conversation, and routes to it once it answers", async () => {
		superviseAgain({ clocks: { starvedWithinMs: 10_000 } });
		units.next = { answersWatchAfterMs: 2_500 };
		units.spent = growing(200, 20);

		const running = await supervisor.resume(entry(a), true);

		expect(running.sessionId).toBe(a);
		expect(routes.routeOf(a)?.socket).toBe(slotOf(folder, key, a).socket);
		expect(units.stopped, "its child left running").toEqual([]);
		const unit = slotOf(folder, key, a).unit;
		// Its CPU counts from a second into the watch, and it is first judged
		// at once then, past its 500 ms, so no time has passed to gain any.
		expect(
			said.filter((line) => line.includes("hasn't answered")),
			"said once, as it waits on",
		).toEqual([
			`${unit} hasn't answered its watch in 500 ms, but has had only 0 ms of CPU since it was watched: it is starved rather than stuck, so it is waited on`,
		]);
		expect(
			said.filter((line) => line.includes("answered its watch after")),
			"its wait said once it answers",
		).toEqual([
			expect.stringMatching(
				new RegExp(
					`^${unit} answered its watch after \\d+ ms, starved, having had \\d+ ms of CPU since it was watched$`,
				),
			),
		]);
	}, 15_000);

	it("gives a starved child no more than its answer time when resumed bounded, asking nothing of its CPU", async () => {
		superviseAgain({ clocks: { starvedWithinMs: 10_000 } });
		units.next = { answersWatchAfterMs: 2_500 };
		units.spent = growing(200, 20);
		const asked = Date.now();

		await expect(supervisor.resume(entry(a), false, true)).rejects.toThrow(
			"The child gave its watch no answer within 500 ms",
		);
		expect(Date.now() - asked, "at its answer time").toBeLessThan(2_000);
		expect(units.cpuAsks, "its CPU never asked").toBe(0);
	});

	it("is given up as stuck, and its child stopped, when it gains no CPU while it doesn't answer its watch", async () => {
		superviseAgain({ clocks: { starvedWithinMs: 10_000 } });
		units.next = { silent: true };
		units.spent = 50;
		const asked = Date.now();

		await expect(supervisor.resume(entry(a), true)).rejects.toThrow(
			/^The child gave its watch no answer within \d+ ms, with 0 ms of CPU since it was watched, none of it in the last \d+ ms: it is stuck rather than starved$/,
		);
		expect(Date.now() - asked, "well before the ceiling").toBeLessThan(5_000);
		expect(units.stopped).toEqual(units.started);
	}, 15_000);

	it("is given up once a child that doesn't answer its watch spends a starved child's CPU", async () => {
		superviseAgain({
			clocks: { listensWithinCpuMs: 1_000, starvedWithinMs: 10_000 },
		});
		units.next = { silent: true };
		units.spent = growing(100, 400);
		const asked = Date.now();

		await expect(supervisor.resume(entry(a), true)).rejects.toThrow(
			/^The child gave its watch no answer within \d+ ms, with 1\d{3} ms of CPU since it was watched$/,
		);
		expect(Date.now() - asked, "well before the ceiling").toBeLessThan(5_000);
	}, 15_000);

	it("is given up once a starved child that doesn't answer its watch has had all the time it may wait, listening and answering", async () => {
		// A listen time under the ceiling, which is never less than one.
		superviseAgain({
			clocks: { listensWithinMs: 300, starvedWithinMs: 2_000 },
		});
		units.next = { silent: true };
		units.spent = growing(0, 50);
		const asked = Date.now();

		await expect(supervisor.resume(entry(a), true)).rejects.toThrow(
			/^The child gave its watch no answer within \d+ ms, with \d+ ms of CPU since it was watched$/,
		);
		const took = Date.now() - asked;
		expect(took, "past its answer time").toBeGreaterThanOrEqual(1_900);
		expect(took, "by the ceiling its listening began").toBeLessThan(3_500);
	}, 15_000);

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
		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			`not ${a} as asked`,
		);
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

/** A conversation's id, the `n`th of several a case starts at once. */
function nth(n: number): string {
	return `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** The unit a conversation's child runs as. */
function unitOf(sessionId: string): string {
	return slotOf(folder, key, sessionId).unit;
}

/**
 * Each unit's start as the supervisor asks it, beside how many children
 * had answered by then, and how many were then between their own start
 * and their first answer.
 */
function startsWatched(answered: () => number): {
	order: string[];
	answered: number[];
	waiting: number[];
} {
	const start = units.start;
	const seen = {
		order: [] as string[],
		answered: [] as number[],
		waiting: [] as number[],
	};
	units.start = (unit) => {
		seen.order.push(unit);
		seen.answered.push(answered());
		seen.waiting.push(seen.order.length - answered());
		return start(unit);
	};
	return seen;
}

describe("children starting at once", () => {
	it("starts no more than two children before one answers, and every one in turn", async () => {
		const ids = [1, 2, 3, 4, 5].map(nth);
		let answered = 0;
		const seen = startsWatched(() => answered);

		const resumed = await Promise.all(
			ids.map((id) =>
				supervisor.resume(entry(id)).then((one) => {
					answered += 1;
					return one;
				}),
			),
		);

		expect(
			Math.max(...seen.waiting),
			"children started and not yet answered, at each start",
		).toBeLessThanOrEqual(2);
		expect(resumed.map(({ sessionId }) => sessionId)).toEqual(ids);
		expect(units.started).toHaveLength(5);
		expect(STARTS_AT_ONCE).toBe(2);
	});

	it("times a child's listening from its own start, not from the wait for its turn", async () => {
		superviseAgain({
			clocks: { listensWithinMs: 300, answersWithinMs: 5_000 },
		});
		const first = nth(1);
		const second = nth(2);
		const third = nth(3);
		// The first two keep the gate for a second, answering their watches
		// late, past the 300 ms the third may take to listen.
		units.traitsOf = (unit) =>
			unit === unitOf(third) ? {} : { answersWatchAfterMs: 1_000 };
		let answered = 0;
		const seen = startsWatched(() => answered);
		const count = (one: Promise<unknown>) =>
			one.then(() => {
				answered += 1;
			});

		// The third asked last, so it is the one left waiting.
		const ahead = [first, second].map((id) =>
			count(supervisor.resume(entry(id), false, true)),
		);
		await vi.waitFor(() => expect(units.started).toHaveLength(2));
		await Promise.all([
			...ahead,
			count(supervisor.resume(entry(third), false, true)),
		]);

		expect(routes.routeOf(third), "resumed, not given up").toBeDefined();
		expect(
			seen.answered[seen.order.indexOf(unitOf(third))],
			"its unit started only once another answered",
		).toBeGreaterThan(0);
	}, 15_000);

	it("starts a wake before the resumes queued ahead of it", async () => {
		// Each held apart, so one turn is freed at a time: two freed at once
		// let their starts race to systemd in either order.
		const holdingFirst = deferred();
		const holdingSecond = deferred();
		const first = nth(1);
		const second = nth(2);
		units.traitsOf = (unit) => {
			if (unit === unitOf(first)) return { listensWhen: holdingFirst.promise };
			if (unit === unitOf(second))
				return { listensWhen: holdingSecond.promise };
			return {};
		};
		const starting = [
			supervisor.resume(entry(first)),
			supervisor.resume(entry(second)),
		];
		await vi.waitFor(() => expect(units.started).toHaveLength(2));
		const queued = [3, 4, 5].map(nth);
		const woken = nth(6);
		const later = queued.map((id) => supervisor.resume(entry(id)));
		const waking = supervisor.resume(entry(woken), true);
		// Long enough for each queued start to reach its unit's start were
		// there no gate, so a red names starts past it, not a race.
		await pause(100);
		expect(units.started, "none past the gate while it is full").toHaveLength(
			2,
		);

		holdingFirst.settle();
		await waking;
		expect(units.started[2], "the wake given the first turn freed").toBe(
			unitOf(woken),
		);

		holdingSecond.settle();
		await Promise.all([...starting, ...later]);
		expect(units.started.slice(3).sort(), "then the rest").toEqual(
			queued.map(unitOf).sort(),
		);
	});

	it("lets a wake given up while it waits at the gate go at once, starting no child for it", async () => {
		const holding = deferred();
		units.traitsOf = () => ({ listensWhen: holding.promise });
		const starting = [1, 2].map((n) => supervisor.resume(entry(nth(n))));
		await vi.waitFor(() => expect(units.started).toHaveLength(2));
		const woken = nth(3);
		const waking = supervisor.resume(entry(woken), true);
		const outcome = expect(waking).rejects.toThrow("was given up");
		// Long enough for it to reach its unit's start were there no gate.
		await pause(100);
		const asked = Date.now();

		supervisor.giveUp(woken);

		await outcome;
		expect(Date.now() - asked, "at once").toBeLessThan(1_000);
		holding.settle();
		await Promise.all(starting);
		expect(units.started, "no unit started for it").not.toContain(
			unitOf(woken),
		);
	});

	// A starved child nobody bounds is waited on for minutes; holding its
	// turn all that time would hold every other start on the host.
	it("gives a turn back once it has been held its whole time, so starts that hang leave the rest to start", async () => {
		superviseAgain({ clocks: { turnHeldWithinMs: 300 } });
		const systemd = deferred();
		const start = units.start;
		units.start = async (unit) => {
			await start(unit);
			if (units.started.length <= 2) await systemd.promise;
		};
		const hanging = [1, 2].map((n) => supervisor.resume(entry(nth(n))));
		await vi.waitFor(() => expect(units.started).toHaveLength(2));
		const asked = Date.now();

		const after = await supervisor.resume(entry(nth(3)));

		expect(after.sessionId).toBe(nth(3));
		expect(
			Date.now() - asked,
			"once a turn was held its time, not when a hung start settles",
		).toBeLessThan(2_000);
		systemd.settle();
		await Promise.allSettled(hanging);
	});

	it("starts none of the children waiting at the gate once the host stops watching, letting each go at once", async () => {
		// The first two hang in systemd's start, so neither gives its turn
		// back: only the stop itself can let the waiting ones go.
		const systemd = deferred();
		const start = units.start;
		units.start = async (unit) => {
			await start(unit);
			await systemd.promise;
		};
		const starting = [1, 2].map((n) => supervisor.resume(entry(nth(n))));
		await vi.waitFor(() => expect(units.started).toHaveLength(2));
		const waiting = [3, 4, 5].map((n) => supervisor.resume(entry(nth(n))));
		// Long enough for each to reach its unit's start were there no gate.
		await pause(100);
		const stopped = Date.now();

		supervisor.close();

		for (const one of waiting)
			await expect(one).rejects.toThrow("stopped watching");
		expect(Date.now() - stopped, "let go at once").toBeLessThan(1_000);
		expect(units.started, "none started past the gate").toHaveLength(2);
		systemd.settle();
		for (const one of starting)
			await expect(one).rejects.toThrow("stopped watching");
		// Each started child listens later, and is left for the next host.
		await vi.waitFor(() =>
			expect(
				[...units.children.values()].every(Boolean),
				"every started child listening",
			).toBe(true),
		);
	});
});

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
		await vi.waitFor(() =>
			expect(becameTold, "told on, for a repeat to name it").toEqual([[a, b]]),
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

	it("says a conversation has left only once the roster holds what it became", async () => {
		await supervisor.resume(entry(a));
		const write = deferred();
		roster.written = write.promise;
		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});
		await vi.waitFor(() => expect(routes.routeOf(b)).toBeDefined());

		let hasLeft = false;
		const leaving = supervisor.left(a).then(() => {
			hasLeft = true;
		});
		// A fixed wait, since what it shows is that nothing settles: long
		// enough for a left that didn't wait on the write to have settled.
		await pause(LISTENS_AFTER_MS);
		expect(hasLeft, "left before the roster replaced it").toBe(false);
		write.settle();
		await leaving;

		expect(roster.held, "the roster holds what it became").toEqual([entry(b)]);
	});

	it("says a conversation has left only once the roster holds what it became, heard while it waited on its slot", async () => {
		await supervisor.resume(entry(a));
		// The first leave's look at the slot holds every later claim on it.
		const looked = deferred();
		units.goneAnswers = looked.promise;
		const first = supervisor.left(a);
		const write = deferred();
		roster.written = write.promise;
		let hasLeft = false;
		const leaving = supervisor.left(a).then(() => {
			hasLeft = true;
		});
		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});
		await vi.waitFor(() => expect(routes.routeOf(b)).toBeDefined());
		looked.settle();
		await expect(first, "a still ran when it looked").rejects.toThrow(
			"still runs",
		);

		// A fixed wait, since what it shows is that nothing settles: long
		// enough for a left that didn't wait on the write to have settled.
		await pause(LISTENS_AFTER_MS);
		expect(hasLeft, "left before the roster replaced it").toBe(false);
		write.settle();
		await leaving;

		expect(roster.held, "the roster holds what it became").toEqual([entry(b)]);
	});

	it("says a conversation has not left a slot it became another in once a child of it lingers there again", async () => {
		await supervisor.resume(entry(a));
		const last = childOf(a);
		const slotA = slotOf(folder, key, a);
		last.say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});
		await vi.waitFor(() => expect(roster.held).toEqual([entry(b)]));
		last.say({ type: "ending", why: "parked" });
		await vi.waitFor(() => expect(ended).toEqual([[b, "parked"]]));
		void last.exit();
		await vi.waitFor(() => expect(units.forgotten).toContain(slotA.unit));

		units.lingers = true;
		units.next = { silent: true };
		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			"no answer within",
		);

		await expect(supervisor.left(a)).rejects.toThrow(
			`${a} still runs in ${slotA.unit}`,
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
		expect(becameTold, "nothing told on").toEqual([]);
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
		expect(
			becameTold,
			"nothing told on, so a repeat names what the roster holds",
		).toEqual([]);
	});

	it("says a conversation has left once the roster has refused what it became, not before", async () => {
		await supervisor.resume(entry(a));
		const write = deferred();
		roster.written = write.promise;
		roster.refuses = true;
		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});
		await vi.waitFor(() => expect(routes.routeOf(b)).toBeDefined());

		let hasLeft = false;
		const leaving = supervisor.left(a).then(() => {
			hasLeft = true;
		});
		// A fixed wait, since what it shows is that nothing settles: long
		// enough for a left that didn't wait on the write to have settled.
		await pause(LISTENS_AFTER_MS);
		expect(hasLeft, "left before the roster answered").toBe(false);
		write.settle();

		await expect(
			leaving,
			"a refused write is let go, not thrown at whoever waits to leave",
		).resolves.toBeUndefined();
		expect(String(reported[0])).toContain("can't be written");
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
