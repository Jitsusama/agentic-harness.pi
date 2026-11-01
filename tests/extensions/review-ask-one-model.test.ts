/**
 * A review round runs on one model, its spread coming from personas.
 *
 * A model a round's `who` names must be the one that participant runs
 * on without it, the roster's or the session's, unless the person asked
 * for it by name; what the config names is never refused.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refusedWhoModel } from "../../extensions/review-integration/tools/ask.ts";
import { loadPackageConfig } from "../../lib/internal/config/loader.ts";

const OPUS = "anthropic/claude-opus-5-5";

/** A config whose roster has one reviewer on no model and a judge on one. */
async function roster() {
	const dir = await mkdtemp(join(tmpdir(), "review-one-model-"));
	const path = join(dir, "config.json");
	const ask = {
		reviewers: [{ id: "hawk" }],
		judge: { id: "judge", model: "anthropic/claude-opus-4-8" },
	};
	await writeFile(
		path,
		JSON.stringify({ version: 1, sections: { review: { ask } } }),
	);
	return { loaded: await loadPackageConfig(path), path };
}

/** Where a round is asked from, after the person typed `said`. */
const seat = (said: string[] = []) => ({
	place: {},
	sessionModel: OPUS,
	said,
});

describe("a round's who naming a model", () => {
	it("is refused when it is another than the participant's usual one", async () => {
		const { loaded, path } = await roster();
		const refused = await refusedWhoModel(
			{ hawk: { model: "openai/gpt-5.5" } },
			loaded,
			path,
			"reviewers",
			seat(["review it from several angles"]),
		);
		expect(refused).toContain("hawk: openai/gpt-5.5 is refused");
		expect(refused).toContain(OPUS);
	});

	it("runs when the person asked for that model by name", async () => {
		const { loaded, path } = await roster();
		expect(
			await refusedWhoModel(
				{ hawk: { model: "openai/gpt-5.5" } },
				loaded,
				path,
				"reviewers",
				seat(["have gpt review it"]),
			),
		).toBeUndefined();
	});

	it("runs on the usual model, the roster's own included", async () => {
		const { loaded, path } = await roster();
		expect(
			await refusedWhoModel(
				{ hawk: { model: OPUS } },
				loaded,
				path,
				"reviewers",
				seat(),
			),
		).toBeUndefined();
		expect(
			await refusedWhoModel(
				{ judge: { model: "anthropic/claude-opus-4-8" } },
				loaded,
				path,
				"judge",
				seat(),
			),
		).toBeUndefined();
	});

	it("is not asked about a who that only changes the persona", async () => {
		const { loaded, path } = await roster();
		expect(
			await refusedWhoModel(
				{ hawk: { persona: "test-skeptic" } },
				loaded,
				path,
				"reviewers",
				seat(),
			),
		).toBeUndefined();
	});
});
