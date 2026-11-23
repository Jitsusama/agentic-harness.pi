/**
 * The soak through the real-model slice's door, the script's own model
 * standing in for the AI proxy, so every kind of request a real slice takes
 * goes through it at no cost.
 */
import { describe, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { soakProvider } from "./soak-provider.ts";
import { RUN_MS, soaked, soakOut, soakPackageDir } from "./soaked.ts";

const packageDir = soakPackageDir();
const out = soakOut("door");

describe.skipIf(!packageDir)(
	"the soak, through the real-model slice's door (needs a pi with the host's patches: pnpm test:host)",
	() => {
		it(
			"passes every request on, holds, steers and aborts through it, and compares by shape",
			async () => {
				// The script's own model stands in for the AI proxy, so every kind
				// a real slice takes goes through its door at no cost.
				const standIn = await soakProvider();
				try {
					const { said, report } = await soaked(
						out,
						["--real", "stand-in"],
						["6,6", "1"],
						{
							SHOPIFY_PI_PROXY_ORIGIN: standIn.endpoint,
							SHOPIFY_PROXY_KEY: "stand-in-key",
						},
					);
					expect(report, said).toMatchObject({
						turns: 12,
						faults: [],
						kinds: { read: 1, bash: 1, steer: 2, job: 1, abort: 1 },
						real: { model: "stand-in", refusals: [] },
					});
					expect(
						standIn.answered(),
						"every request reached the stand-in",
					).toBeGreaterThan(12);
					const real = isRecord(report) ? report.real : undefined;
					expect(
						isRecord(real) && isRecord(real.usage)
							? real.usage.hosted
							: undefined,
						"each answer's tokens, as the stand-in said them",
					).toMatchObject({ input: expect.any(Number) });
					expect(
						isRecord(report) && Array.isArray(report.parity)
							? report.parity.map((one) =>
									isRecord(one) ? one.unexpected : undefined,
								)
							: undefined,
						"each conversation's record has plain pi's shape",
					).toEqual([0, 0]);
				} finally {
					await standIn.close();
				}
			},
			RUN_MS,
		);
	},
);
