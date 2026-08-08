/**
 * The roster has to be found where it is written.
 *
 * `review_ask` reads its roster from the package config, and the
 * envelope keeps every extension's settings under `sections`. Reading
 * one level too high finds nothing for every well-formed config there
 * is, so the tool refuses with "no roster is configured" no matter
 * what the file says, and the refusal reads like a config problem
 * rather than a lookup bug. That is worth a test of its own because
 * the shape is invisible: `undefined` is exactly what an absent
 * section looks like.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rosterFromConfig } from "../../extensions/review-integration/tools/ask.js";
import { loadPackageConfig } from "../../lib/internal/config/loader.js";

/** A config file holding one roster, written where the loader reads. */
async function configHolding(sections: unknown): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "review-roster-"));
	const path = join(dir, "config.json");
	await writeFile(path, JSON.stringify({ version: 1, sections }), "utf8");
	return path;
}

const ONE_REVIEWER = {
	reviewers: [{ id: "opus", model: "anthropic/claude-opus-4-8" }],
};

describe("finding the roster in the package config", () => {
	it("reads a roster written under sections, where every section lives", async () => {
		const path = await configHolding({ review: { ask: ONE_REVIEWER } });

		const roster = await rosterFromConfig(await loadPackageConfig(path), path);

		expect(roster.reviewers.map((r) => r.id)).toEqual(["opus"]);
	});

	it("applies what this one call asked for, over the file", async () => {
		// The whole point of an override: trying a reviewer at a different
		// setting used to mean editing the config, running, and editing it
		// back, while the fan-out tool next door has taken these per call
		// since it was written.
		const path = await configHolding({ review: { ask: ONE_REVIEWER } });

		const roster = await rosterFromConfig(await loadPackageConfig(path), path, {
			opus: { thinkingLevel: "xhigh" },
		});

		expect(roster.reviewers[0]).toEqual({
			id: "opus",
			model: "anthropic/claude-opus-4-8",
			thinkingLevel: "xhigh",
		});
	});

	it("refuses an override naming nobody, rather than running without it", async () => {
		// Silently ignoring it is the expensive failure: the round runs,
		// bills what a round bills, and the setting that was the reason
		// for asking was never applied.
		const path = await configHolding({ review: { ask: ONE_REVIEWER } });

		await expect(
			rosterFromConfig(await loadPackageConfig(path), path, {
				sonnet: { thinkingLevel: "xhigh" },
			}),
		).rejects.toThrow(/sonnet/);
	});

	it("reads the judge alongside the reviewers", async () => {
		const path = await configHolding({
			review: {
				ask: {
					...ONE_REVIEWER,
					judge: { id: "judge", model: "anthropic/claude-opus-4-8" },
				},
			},
		});

		const roster = await rosterFromConfig(await loadPackageConfig(path), path);

		expect(roster.judge?.id).toBe("judge");
	});

	it("does not look at the top level, where a section never sits", async () => {
		// The shape that used to be read. Finding a roster here would mean
		// the lookup still accepts a file no other extension would.
		const dir = await mkdtemp(join(tmpdir(), "review-roster-"));
		const path = join(dir, "config.json");
		await writeFile(
			path,
			JSON.stringify({
				version: 1,
				sections: {},
				review: { ask: ONE_REVIEWER },
			}),
			"utf8",
		);

		await expect(
			rosterFromConfig(await loadPackageConfig(path), path),
		).rejects.toThrow(/No roster is configured/);
	});

	it("says where to write the roster when there is none", async () => {
		const path = await configHolding({});

		await expect(
			rosterFromConfig(await loadPackageConfig(path), path),
		).rejects.toThrow(new RegExp(`review.ask section to ${path}`));
	});

	it("passes a malformed roster's own refusal through", async () => {
		// A model with a colon: pi reads that as a thinking-level
		// separator, so the roster parser refuses it by name.
		const path = await configHolding({
			review: { ask: { reviewers: [{ id: "x", model: "a:b" }] } },
		});

		await expect(
			rosterFromConfig(await loadPackageConfig(path), path),
		).rejects.toThrow(/colon/i);
	});
});
