/**
 * A compacted conversation's reads on the host's agent: once pi has
 * compacted, the context durable reads for a request starts at what pi
 * kept, not at the conversation's first entry. Before the agent told
 * durable of pi's compactions, every start read the whole log for its
 * first request, 38,734 entries for one conversation on 26 November.
 * Runs fixtures/hosted-session.mts as hosted-agent.test.ts does, so on a
 * pi built with the host's patches, skipping each case without one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { hostPiFor } from "../end-to-end/support/host-pi.ts";
import { type Observed, said, sessionRuns } from "./fixtures/session-runs.ts";

/** The host's pi, found again for each case, which skips or fails without one. */
let packageDir = "";
beforeEach(({ skip }) => {
	packageDir = hostPiFor(skip);
});
const { observe } = sessionRuns(() => packageDir);
/** Two runs in two processes, each loading pi's whole package. */
const TWO_RUNS_MS = 60_000;

/** The scans of a context durable read for a request: a range up to the log's tail, oldest entries first. */
function contextScans(observed: Observed): NonNullable<Observed["scans"]> {
	return (observed.scans ?? []).filter(
		(scan) => scan.maxEntryId !== undefined && scan.order === undefined,
	);
}

/** A compacted conversation reopened and asked again, on the host's agent. */
async function reopenedAfter(compacting: string): Promise<Observed> {
	const folder = mkdtempSync(join(tmpdir(), "hosted-compacted-"));
	try {
		await observe("hosted", compacting, folder);
		return await observe("hosted", "reopen-compacted", folder);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

describe("a compacted conversation's reads on the host's agent", {
	timeout: TWO_RUNS_MS,
}, () => {
	it("reads only what pi kept, for a compaction the agent heard", async () => {
		const reopened = await reopenedAfter("compacted");

		expect(said(reopened, "assistant").at(-1)).toBe("four");
		const scans = contextScans(reopened);
		expect(scans.length, "durable read a context").toBeGreaterThan(0);
		expect(
			scans.filter((scan) => scan.minEntryId === undefined),
			"no context read starts at the conversation's first entry",
		).toEqual([]);
	});

	it("reads only what pi kept, for a compaction from before the agent heard them", async () => {
		// Conversations compacted before this change are marked at their next start.
		const reopened = await reopenedAfter("compacted-unheard");

		expect(said(reopened, "assistant").at(-1)).toBe("four");
		const scans = contextScans(reopened);
		expect(scans.length, "durable read a context").toBeGreaterThan(0);
		expect(
			scans.filter((scan) => scan.minEntryId === undefined),
			"no context read starts at the conversation's first entry",
		).toEqual([]);
	});
});
