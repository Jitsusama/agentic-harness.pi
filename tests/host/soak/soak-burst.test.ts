/**
 * The soak at its smallest, woken in a burst: every parked conversation
 * woken by a window at once, then a fresh host on the same state that wakes
 * them all again, each timed, with the loop weighed after.
 */
import { describe, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { RUN_MS, soaked, soakOut, soakPackageDir } from "./soaked.ts";

const packageDir = soakPackageDir();
const out = soakOut("burst");

describe.skipIf(!packageDir)(
	"the soak, woken in a burst (needs a pi with the host's patches: pnpm test:host)",
	() => {
		it(
			"wakes every parked conversation by a window at once, timing each, and weighs the loop after",
			async () => {
				const { said, report } = await soaked(out, ["--burst", "--restart"]);
				expect(report, said).toMatchObject({ faults: [] });
				const first =
					isRecord(report) && Array.isArray(report.checkpoints)
						? report.checkpoints[0]
						: undefined;
				expect(
					first,
					"both conversations' wakes, and none one at a time",
				).toMatchObject({
					burstWakes: [
						{ conversation: 0, answeredMs: expect.any(Number) },
						{ conversation: 1, answeredMs: expect.any(Number) },
					],
					windowWakes: [],
				});
				expect(first, "how late the loop ran through the burst").toMatchObject({
					afterBurst: {
						loopP99Ms: expect.any(Number),
						loopMaxMs: expect.any(Number),
					},
				});
				expect(said, "the checkpoint line says the burst").toMatch(
					/burst of 2: slowest answered \d+ ms, loop max \d+ ms/,
				);
				expect(
					isRecord(report) ? report.restart : undefined,
					"a fresh host on the same state, timed to its socket, holding both parked, then both woken at once",
				).toMatchObject({
					toSocketMs: expect.any(Number),
					parkedAtStart: 2,
					wakes: [
						{ conversation: 0, answeredMs: expect.any(Number) },
						{ conversation: 1, answeredMs: expect.any(Number) },
					],
					allAnsweredMs: expect.any(Number),
					after: { loopMaxMs: expect.any(Number) },
				});
				expect(said, "a line says the restart").toMatch(
					/restart: socket in \d+ ms, 2 of 2 parked, all answered in \d+ ms/,
				);
			},
			RUN_MS,
		);
	},
);
