/**
 * A command handed to the background holds a heavy lease while it runs,
 * so a mycelium node never moves a session out from under it (5HJZ8Z,
 * 16 November), unless it only waits and reads (23 November).
 */
import { describe, expect, it } from "vitest";
import {
	createHeavyCalls,
	parkWaitingCalls,
	takeWaitingCalls,
} from "../../../../extensions/mesh-workflow/leases.ts";
import { type LeaseEvent, MOST_HOLD_MS } from "../../../../lib/mesh/lease.ts";

const text = (words: string) => [{ type: "text", text: words }];

const tracked = () => {
	const events: LeaseEvent[] = [];
	const waiting = new Map<string, string>();
	const calls = createHeavyCalls(
		(event) => events.push(event),
		(command) => `why: ${command}`,
		[],
		waiting,
	);
	return { events, calls, waiting };
};

const BACKGROUND =
	"Running as background command j7. Its result will arrive as a message of its own when it ends.";

describe("a command handed to the background", () => {
	it("claims heavy work named by its job and first words until the job ends", () => {
		const { events, calls } = tracked();
		calls.called("1", "./watch.sh\nsleep 600");
		expect(events, "a plain command claims nothing as it starts").toEqual([]);

		calls.answered("1", text(BACKGROUND));
		expect(events).toEqual([
			{
				take: {
					subject: "background j7: ./watch.sh",
					why: "./watch.sh",
					ms: MOST_HOLD_MS,
					quiet: true,
				},
			},
		]);
		calls.finished("1");

		expect(events.filter((event) => "release" in event)).toEqual([
			{ release: "background j7: ./watch.sh" },
		]);
	});

	it("claims nothing for a loop that only waits and reads, so a carry may stop it", () => {
		const { events, calls } = tracked();
		calls.called(
			"1",
			"while ! grep -q '^rc=' $TMPDIR/test.log; do sleep 10; done; tail -5 $TMPDIR/test.log",
		);

		calls.answered("1", text(BACKGROUND));
		calls.finished("1");

		expect(events).toEqual([]);
	});

	it("keeps a long wait by its job until it ends, so a carry names it though its label is cut", () => {
		const { events, calls, waiting } = tracked();
		calls.called(
			"1",
			"while ! grep -q rc= /tmp/pi-quest-QEST-20261025-85PKB2/ht-2019.log; do sleep 10; done",
		);
		calls.called("2", "until test -f done; do\n  sleep 5\ndone");
		calls.called("3", "./watch.sh");

		calls.answered("1", text(BACKGROUND));
		calls.answered("2", text(BACKGROUND.replace("j7", "j8")));
		calls.answered("3", text(BACKGROUND.replace("j7", "j9")));

		expect([...waiting]).toEqual([
			["1", "j7"],
			["2", "j8"],
		]);
		calls.finished("1");
		expect([...waiting]).toEqual([["2", "j8"]]);
		expect(events, "only the script claims").toHaveLength(1);
	});

	it("keeps the waits through a reload", () => {
		const { calls, waiting } = tracked();
		calls.called("1", "sleep 600");
		calls.answered("1", text(BACKGROUND));

		parkWaitingCalls(waiting);
		calls.clear();

		expect(waiting.size).toBe(0);
		expect(takeWaitingCalls()).toEqual([["1", "j7"]]);
		expect(takeWaitingCalls(), "taken once").toEqual([]);
	});

	it("claims nothing for a wait taken up through a restart", () => {
		const { events, calls } = tracked();

		calls.takenUp("1", "j3", "sleep 300; cat $TMPDIR/out.log");

		expect(events).toEqual([]);
	});

	it("still claims a wait known only by a label cut short, since what was cut can't be read", () => {
		const { events, calls } = tracked();

		calls.takenUp("1", "j3", "sleep 300 ...");

		expect(events).toHaveLength(1);
	});

	it("claims nothing more for heavy work it already holds", () => {
		const { events, calls } = tracked();
		calls.called("1", "nix build .#a");

		calls.answered("1", text(BACKGROUND));

		expect(events).toEqual([
			{ take: { subject: "build", why: "why: nix build .#a" } },
		]);
	});

	it("claims nothing for a plain command that answers in its turn", () => {
		const { events, calls } = tracked();
		calls.called("1", "ls -la");

		calls.answered("1", text("total 0"));
		calls.finished("1");

		expect(events).toEqual([]);
	});

	it("cuts long first words, so a subject stays a line", () => {
		const { events, calls } = tracked();
		const long = `./say.sh ${"x".repeat(200)}`;
		calls.called("1", long);

		calls.answered("1", text(BACKGROUND));

		const [taken] = events;
		expect(taken !== undefined && "take" in taken, "a take").toBe(true);
		if (taken === undefined || !("take" in taken)) return;
		expect(taken.take.subject.length).toBeLessThanOrEqual(80);
		expect(taken.take.subject).toMatch(/^background j7: \.\/say\.sh x+\.\.\.$/);
	});

	it("claims a background command taken up through a restart until it ends", () => {
		const { events, calls } = tracked();

		calls.takenUp("1", "j3", "pnpm -s lint");
		calls.finished("1");

		expect(events).toEqual([
			{
				take: {
					subject: "background j3: pnpm -s lint",
					why: "pnpm -s lint",
					ms: MOST_HOLD_MS,
					quiet: true,
				},
			},
			{ release: "background j3: pnpm -s lint" },
		]);
	});

	it("keeps its claim through a reload, given back when the job ends there", () => {
		const first = tracked();
		first.calls.called("1", "./watch.sh");
		first.calls.answered("1", text(BACKGROUND));

		const events: LeaseEvent[] = [];
		const after = createHeavyCalls(
			(event) => events.push(event),
			undefined,
			first.calls.held(),
		);
		after.finished("1");

		expect(events).toEqual([{ release: "background j7: ./watch.sh" }]);
	});
});
