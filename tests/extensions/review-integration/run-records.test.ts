/**
 * A review round is said in its run record under the session that
 * asked, from when it opens until everyone it asks has answered.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	rememberSession,
	runArtifactDir,
} from "../../../extensions/review-integration/engine.ts";
import {
	askedInRound,
	roundDispatched,
	roundOpened,
} from "../../../extensions/review-integration/run-records.ts";
import type { AskRun, ChangeRef } from "../../../lib/core/review/index.ts";
import { ReviewerArtifactsStore } from "../../../lib/subagent/artifacts.ts";
import { runRecordsDir } from "../../../lib/subagent/run-record.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "round-record-"));
	vi.stubEnv("XDG_STATE_HOME", root);
	rememberSession("01a1b240-2928-74b2-80e2-553612fecd1a");
});

afterEach(() => {
	rememberSession(undefined);
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

const change: ChangeRef = {
	provider: "github",
	repo: { key: "github:Jitsusama/core.nix" },
	id: "2054",
	label: "Jitsusama/core.nix#2054",
};

const council = (id: string): AskRun => ({
	id,
	round: "council",
	startedAt: "2026-11-07T04:00:00.000Z",
	participants: [
		{
			id: "lead",
			role: "reviewer",
			model: "anthropic/claude-opus-5-5",
			persona: "correctness",
		},
		{
			id: "second",
			role: "reviewer",
			model: "anthropic/claude-opus-5-5",
			persona: "security",
		},
	],
	outcomes: [],
});

/** A reviewer's answer, written as its supervisor writes it. */
function answered(runId: string, member: string): void {
	const path = new ReviewerArtifactsStore(runArtifactDir()).paths(
		runId,
		member,
	).resultPath;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({
			state: "complete",
			completedAt: "2026-11-07T04:05:00.000Z",
		}),
	);
}

function recordOf(runId: string): Record<string, unknown> {
	const body = JSON.parse(
		readFileSync(join(runRecordsDir(), `review.${runId}.json`), "utf8"),
	);
	return body.runs[0];
}

describe("a review round's record", () => {
	it("goes on while the lead answers alone, and ends once everyone has", async () => {
		const id = "council-20261107T040000000-000001";
		roundOpened(change, council(id));

		await askedInRound(change, "council", id, { id: "lead" }, async () =>
			answered(id, "lead"),
		);
		// Waited for, since the record's first write is its own.
		await vi.waitFor(() => expect(() => recordOf(id)).not.toThrow());
		expect(recordOf(id)).toMatchObject({
			kind: "council",
			parent: "01a1b240-2928-74b2-80e2-553612fecd1a",
			about: "Jitsusama/core.nix#2054",
			state: "running",
		});

		await askedInRound(change, "council", id, { id: "second" }, async () =>
			answered(id, "second"),
		);
		expect(recordOf(id)).toMatchObject({ state: "done" });
		expect(recordOf(id).members).toEqual([
			expect.objectContaining({
				id: "lead",
				persona: "correctness",
				state: "complete",
			}),
			expect.objectContaining({
				id: "second",
				persona: "security",
				state: "complete",
			}),
		]);
	});

	it("says a round asked without opening, as a retry is, from its first ask", async () => {
		const id = "retry-1";

		await askedInRound(change, "judge", id, { id: "judge" }, async () =>
			answered(id, "judge"),
		);

		expect(recordOf(id)).toMatchObject({ kind: "judge", state: "done" });
	});

	it("says a detached round's reviewer that never started as failed", async () => {
		const id = "council-detached";
		roundOpened(change, council(id));
		answered(id, "lead");

		await roundDispatched(id);

		expect(recordOf(id)).toMatchObject({ state: "done" });
		expect(recordOf(id).members).toEqual([
			expect.objectContaining({ id: "lead", state: "complete" }),
			expect.objectContaining({ id: "second", state: "failed" }),
		]);
	});
});
