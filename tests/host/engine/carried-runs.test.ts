/**
 * A run the host carries on after a restart, as pi's extensions see it:
 * pi prepares it as it prepares a typed prompt's run, so every section an
 * extension adds at the run's start (the harness's resident block, its
 * standing context) reaches the carried turn's request as it reaches the
 * next typed one's. Each scenario runs in a node process of its own on a
 * pi built with the host's patches, as hosted-agent.test.ts's do.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { hostPiFor } from "../end-to-end/support/host-pi.ts";
import { said, sessionRuns } from "./fixtures/session-runs.ts";

/** The host's pi, found again for each case, which skips or fails without one. */
let packageDir = "";
beforeEach(({ skip }) => {
	packageDir = hostPiFor(skip);
});
const { observe, killed } = sessionRuns(() => packageDir);
/** Two sessions in two processes, each loading pi's whole package. */
const SESSION_PAIR_MS = 60_000;
/** Three sessions in three processes, one waiting up to 20 s for its carried run to end. */
const SESSION_TRIO_MS = 90_000;
/** The longest a park may hold a stopping host's close, as hosted-agent.test.ts holds it; the fixture's slow handler takes twice that. */
const PARKED_CLOSE_MOST_MS = 5_000;
/** The words reopen-typed-as-it-ends types and steers with, and the file it says what it saw in, as the fixture names them. */
const TYPED_AS_IT_ENDS = "typed as it ended";
const STEERED_AS_IT_ENDS = "steered as it ended";
const TYPED_AS_IT_ENDS_FILE = "typed-as-it-ends.json";

describe("a run the host carries on after a restart", {
	timeout: SESSION_PAIR_MS,
}, () => {
	it("lets its stopping host close at once while pi still prepares it", async () => {
		// A park left a stopping host's close waiting on a slow handler's preparation of a carried run, up to 30 s.
		const folder = mkdtempSync(join(tmpdir(), "carried-park-"));
		try {
			expect(await killed("crash-in-tool", folder)).toBe("SIGKILL");
			const observed = await observe("hosted", "reopen-park-preparing", folder);
			const seen = observed.events.map((event) => event.type);
			const parking = seen.indexOf("parking");
			expect(seen, "pi began preparing the carried run").toContain("preparing");
			expect(
				parking,
				"the host parked while pi prepared the run",
			).toBeGreaterThan(seen.indexOf("preparing"));
			expect(
				seen.slice(parking + 1),
				"pi was shown nothing once the host parked",
			).toEqual(["closed"]);
			const closed = observed.events.find((event) => event.type === "closed");
			expect(
				closed?.ms,
				"the close waited on no preparation the park had abandoned",
			).toBeLessThan(PARKED_CLOSE_MOST_MS);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("keeps words typed as it ends through the host dying as pi settles it", {
		timeout: SESSION_TRIO_MS,
	}, async () => {
		// Words pi queued as the carried run ended lived only in the agent's memory until pi had settled the run.
		const folder = mkdtempSync(join(tmpdir(), "carried-typed-end-"));
		try {
			expect(await killed("crash-in-tool", folder)).toBe("SIGKILL");
			expect(await killed("reopen-typed-as-it-ends", folder)).toBe("SIGKILL");
			const typed: unknown = JSON.parse(
				readFileSync(join(folder, TYPED_AS_IT_ENDS_FILE), "utf8"),
			);
			expect(
				typed,
				"the words were typed once the carried run ended, pi's run still open",
			).toMatchObject({
				typed: true,
				ended: true,
				streaming: true,
				queuedOnceTyped: true,
			});
			// Only pi's settle writes the file, and the host killed itself there, so it died as pi settled the run.
			const observed = await observe("hosted", "reopen-after-typed", folder);
			const saw = `(it saw ${JSON.stringify(typed)})`;
			expect(
				said(observed, "user"),
				`the words typed as the run ended outlived the host ${saw}`,
			).toContain(TYPED_AS_IT_ENDS);
			expect(
				said(observed, "user"),
				`the words steered as the run ended outlived the host ${saw}`,
			).toContain(STEERED_AS_IT_ENDS);
			expect(
				typed,
				"the words had run inside pi's run, none left queued as it settled",
			).toMatchObject({ queuedAtSettle: false });
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("reaches the model with the sections a typed prompt's run has", async () => {
		// Until pi prepared the host's own runs, a carried turn went out without the harness's resident block and standing context, 271 times in one probe on 16 November.
		const folder = mkdtempSync(join(tmpdir(), "carried-sections-"));
		try {
			expect(await killed("crash-in-tool", folder)).toBe("SIGKILL");
			const observed = await observe("hosted", "reopen-sectioned", folder);
			expect(
				observed.events
					.filter((event) => event.type === "prepared")
					.map((event) => event.trigger),
				"pi prepared the carried run, then the typed one",
			).toEqual(["continue", "user"]);
			const requests = observed.events.filter(
				(event) => event.type === "request",
			);
			expect(
				requests.map((request) => request.sectioned),
				"both requests carried the extension's section",
			).toEqual([true, true]);
			expect(
				requests.map((request) => request.paired),
				"pi's update went after the tool result the restart owed, as a provider requires",
			).toEqual([true, true]);
			expect(
				requests[0]?.prompt,
				"the carried turn's sections are the typed turn's",
			).toBe(requests[1]?.prompt);
			expect(said(observed, "assistant").slice(-2)).toEqual([
				"after the restart",
				"and your words",
			]);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});
});
