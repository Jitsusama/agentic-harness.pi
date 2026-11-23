/**
 * The soak at its smallest, parked and woken in turn: the first
 * conversation by a window, timed to its answer apart from its first
 * drawing. The second wakes by the mesh, which this case leaves to the
 * soak's own fault list.
 */
import { describe, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { RUN_MS, soaked, soakOut, soakPackageDir } from "./soaked.ts";

const packageDir = soakPackageDir();
const out = soakOut("parked");

describe.skipIf(!packageDir)(
	"the soak, parked (needs a pi with the host's patches: pnpm test:host)",
	() => {
		it(
			"wakes a window's conversation on its own, timing its answer apart from its first drawing",
			async () => {
				const { said, report } = await soaked(out, []);
				expect(report, said).toMatchObject({ faults: [] });
				// At the first checkpoint the first conversation wakes by a window;
				// the second's mesh wake is checked only as having no faults.
				expect(
					isRecord(report) && Array.isArray(report.checkpoints)
						? report.checkpoints[0]
						: undefined,
					"the window's wake, how big its record was, and when it answered and drew",
				).toMatchObject({
					windowWakes: [
						{
							conversation: 0,
							recordBytes: expect.any(Number),
							answeredMs: expect.any(Number),
							drawnMs: expect.any(Number),
						},
					],
				});
			},
			RUN_MS,
		);
	},
);
