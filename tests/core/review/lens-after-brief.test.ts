/**
 * Each reviewer still gets its own lens, now after the shared brief.
 *
 * A lens used to be its reviewer's whole system prompt, which made each
 * reviewer's request differ from its second line, so none could read
 * the brief another had written to the cache. It now rides after the
 * brief, and the system prompt every reviewer shares is what keeps it
 * an instruction rather than material. What this holds is the half a
 * cost measurement cannot see: that every built-in reviewer is still
 * handed its own charter, in full, as the thing it reads through.
 */

import { describe, expect, it } from "vitest";
import {
	BUILT_IN_ROSTER,
	builtInPersonaDir,
} from "../../../extensions/review-integration/roster.ts";
import {
	LENS_SYSTEM_PROMPT,
	lensFor,
} from "../../../lib/core/review/ask/prompt.ts";
import { chartersOnDisk } from "../../../lib/core/review/index.ts";
import { type RunPi, runReviewer } from "../../../lib/subagent/subagent.ts";

const ANSWER = JSON.stringify({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text: "{}" }] },
});

/** What each built-in reviewer's pi is started with. */
async function builtInArgs(): Promise<
	Map<string, { args: string[]; charter: string }>
> {
	const charters = await chartersOnDisk(builtInPersonaDir());
	const started = new Map<string, { args: string[]; charter: string }>();
	for (const reviewer of BUILT_IN_ROSTER.reviewers) {
		const charter = charters.get(reviewer.persona ?? "") ?? "";
		const runPi: RunPi = async (opts) => {
			started.set(reviewer.id, { args: opts.args, charter });
			return { stdout: ANSWER, stderr: "", exitCode: 0 };
		};
		await runReviewer({
			reviewer: { id: reviewer.id },
			prompt: "the round's brief",
			cwd: "/t",
			runPi,
			...lensFor(charter),
		});
	}
	return started;
}

describe("a built-in reviewer's lens", () => {
	it("reaches it whole, as the last thing in its first message", async () => {
		const started = await builtInArgs();

		expect(started.size).toBe(BUILT_IN_ROSTER.reviewers.length);
		for (const { args, charter } of started.values()) {
			expect(charter.length).toBeGreaterThan(200);
			expect(args.at(-1)).toContain(charter.trim());
			expect(args.at(-1)).toMatch(/^## Your lens/);
		}
	});

	it("is a different lens for each reviewer", async () => {
		const lenses = [...(await builtInArgs()).values()].map(({ args }) =>
			args.at(-1),
		);

		expect(new Set(lenses).size).toBe(lenses.length);
	});

	it("is named as an instruction by the system prompt every reviewer shares", async () => {
		for (const { args } of (await builtInArgs()).values()) {
			expect(args[args.indexOf("--system-prompt") + 1]).toBe(
				LENS_SYSTEM_PROMPT,
			);
		}
		expect(LENS_SYSTEM_PROMPT).toMatch(/lens is part of your instructions/);
		expect(LENS_SYSTEM_PROMPT).toMatch(/Your lens/);
	});

	it("leaves the reviewers' requests the same up to the lens", async () => {
		const all = [...(await builtInArgs()).values()].map(({ args }) =>
			args.slice(0, -1),
		);

		for (const args of all) expect(args).toEqual(all[0]);
	});

	it("is nothing for a participant with no charter, which keeps pi's own prompt", () => {
		expect(lensFor(undefined)).toEqual({});
	});
});
