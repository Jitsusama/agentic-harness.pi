/**
 * A command handed to the background holds a heavy lease while it runs,
 * whatever it runs, so a mycelium node never moves a session out from
 * under it (5HJZ8Z, 16 November).
 */
import { describe, expect, it } from "vitest";
import { createHeavyCalls } from "../../../extensions/mesh-workflow/leases.ts";
import { type LeaseEvent, MOST_HOLD_MS } from "../../../lib/mesh/lease.ts";

const text = (words: string) => [{ type: "text", text: words }];

const tracked = () => {
	const events: LeaseEvent[] = [];
	const calls = createHeavyCalls(
		(event) => events.push(event),
		(command) => `why: ${command}`,
	);
	return { events, calls };
};

const BACKGROUND =
	"Running as background command j7. Its result will arrive as a message of its own when it ends.";

describe("a command handed to the background", () => {
	it("claims heavy work named by its job and first words until the job ends", () => {
		const { events, calls } = tracked();
		calls.called("1", "ls -la\nsleep 600");
		expect(events, "a plain command claims nothing as it starts").toEqual([]);

		calls.answered("1", text(BACKGROUND));
		expect(events).toEqual([
			{
				take: {
					subject: "background j7: ls -la",
					why: "ls -la",
					ms: MOST_HOLD_MS,
					quiet: true,
				},
			},
		]);
		calls.finished("1");

		expect(events.filter((event) => "release" in event)).toEqual([
			{ release: "background j7: ls -la" },
		]);
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
		const long = `echo ${"x".repeat(200)}`;
		calls.called("1", long);

		calls.answered("1", text(BACKGROUND));

		const [taken] = events;
		expect(taken !== undefined && "take" in taken, "a take").toBe(true);
		if (taken === undefined || !("take" in taken)) return;
		expect(taken.take.subject.length).toBeLessThanOrEqual(80);
		expect(taken.take.subject).toMatch(/^background j7: echo x+\.\.\.$/);
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
		first.calls.called("1", "ls");
		first.calls.answered("1", text(BACKGROUND));

		const events: LeaseEvent[] = [];
		const after = createHeavyCalls(
			(event) => events.push(event),
			undefined,
			first.calls.held(),
		);
		after.finished("1");

		expect(events).toEqual([{ release: "background j7: ls" }]);
	});
});
