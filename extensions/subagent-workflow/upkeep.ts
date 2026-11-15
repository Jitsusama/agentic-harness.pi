/**
 * What a session start does for the machine's fleets: gives back the
 * disk finished fleets still hold, stops subagents whose supervisor
 * died, and tells a returning conversation of its own fleets that were
 * cut off.
 *
 * Apart from the tool, since none of it runs a fleet: it changes with
 * what is kept and for how long, not with how a fleet is asked for.
 */

import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tickFacts } from "../../lib/internal/process-ticks.ts";
import { ReviewerArtifactsStore } from "../../lib/subagent/artifacts.ts";
import { firstInWindow } from "../../lib/subagent/first-in-window.ts";
import {
	abandonedFleets,
	createFleetLedger,
	type FleetLedger,
	type FleetRun,
	stillHeld,
} from "../../lib/subagent/fleet.ts";
import { answersTo } from "../../lib/subagent/handing.ts";
import {
	ORPHAN_LOOK_WINDOW_MS,
	recoverReviewerRuns,
} from "../../lib/subagent/recovery.ts";
import type { Aside } from "../../lib/ui/aside.ts";
import { count } from "../../lib/ui/count.ts";
import { recordOrSay } from "./bookkeeping.ts";
import { digestFleetRuns } from "./digests.ts";

// Raw fleet run directories (per-subagent events, stderr and
// result files) are only needed while a run is live or under
// recovery, so they age out on a bounded window and count.
const FLEET_RUNS_RETAIN = 100;
const FLEET_RUNS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A run killed before its reviewer wrote a result is not terminal, so
// the terminal-only sweep could never reclaim it and it lived forever.
// Four times the normal window, because an unfinished run is kept for
// recovery and the question is whether anybody could still resume it.
// The same window keeps a cut-off fleet's transcripts, counted from
// when it was cut off: long enough for its conversation to come back
// and read them, and then it goes the way of any finished fleet.
const FLEET_RUNS_ABANDONED_AFTER_MS = 4 * FLEET_RUNS_MAX_AGE_MS;
/**
 * How often the machine's fleets are swept, by the first session start
 * in each window. Every start swept them all, reading every ledger
 * record and every run's streams to find what the start before it had
 * just found: 2,048 records and 405 runs on 4 November, about half a
 * second of CPU at each start. What the sweep keeps is counted in days,
 * so a window of minutes changes nothing it decides.
 */
const FLEET_SWEEP_WINDOW_MS = 5 * 60 * 1000;
/**
 * A note earlier versions kept of the abandoned fleets they had
 * named, removed wherever it is found.
 *
 * Rebuilt by every session start from what that session saw, so two
 * sessions starting together each wrote their own reading and the last
 * one won, which made a certain "gone" lose to an unsure one and the
 * same fleets get named again. Whether a fleet has been told now lives
 * on its own record.
 */
const ABANDONED_SAID_BEFORE = "abandoned-said.json";
/**
 * What a restored conversation is told about its own cut-off fleets.
 *
 * A message to the model rather than a notice to the screen. The
 * conversation that dispatched a fleet is the one place knowing it was
 * cut off is worth anything, since it knows what the fleet was for,
 * and every other session has no use for it at all.
 */
export const FLEET_CUT_OFF_MESSAGE = "subagent-fleet-cut-off";
/**
 * How many sweep failures to print before summarizing the rest.
 *
 * These arrive per run directory, and what causes them is rarely one
 * run: a permissions change lands on all of them at once, so the
 * choice is a cap or a hundred lines at somebody's session start.
 */
const MOST_WARNINGS = 5;

/**
 * Tell this conversation about the fleets it dispatched that were cut
 * off when it last ended, once each.
 *
 * Only a conversation that has come back can match, since a fleet is
 * cut off for its session ending, so in every other session this says
 * nothing. Told before the record is marked, so a mark that fails costs
 * telling it once more rather than never.
 */
async function tellOwnCutOffs(
	held: readonly FleetRun[],
	runs: string,
	ledger: FleetLedger,
	conversation: Conversation,
	say: Aside,
): Promise<void> {
	const { session, tell } = conversation;
	if (session === undefined) return;
	const store = new ReviewerArtifactsStore(runs);
	for (const run of held) {
		const cut = run.cutOff;
		if (run.session !== session || cut?.why !== "owner-gone" || cut.told) {
			continue;
		}
		const dir = store.rootPaths(run.id).runDir;
		const until = new Date(Date.parse(cut.at) + FLEET_RUNS_ABANDONED_AFTER_MS)
			.toISOString()
			.slice(0, 10);
		const kept = (await exists(dir))
			? `What its subagents wrote is under ${dir}, kept until ${until}.`
			: "Nothing its subagents wrote was kept.";
		tell(
			`The subagent fleet ${run.id} (${run.jobs.join(", ")}), dispatched from this conversation at ${run.startedAt}, was cut off when this session last ended, so its answers never came back. ${kept} If its work still matters, read what it left or dispatch it again.`,
		);
		await recordOrSay(
			() => ledger.told(run.id),
			`could not note that ${run.id} was told, so it may be told again`,
			say,
		);
	}
}

/** Whether a path is there at all. */
async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		// Gone, or unreachable. Both mean there is nothing to send
		// somebody to go and read.
		return false;
	}
}

/**
 * Stop a subagent whose supervisor died, and say what happened to it.
 *
 * The narrow case, and the only orphan a fleet can have. A supervisor
 * whose session goes stops its own child within half a second, since
 * a fleet job is always one somebody is waiting for and its request
 * carries the waiting pid; that is asserted against the real script
 * in `tests/lib/subagent/runpi/parent-exit.test.ts`. So a dead
 * session leaves nothing running, and no ledger reading is needed to
 * work out whose fleet this was.
 *
 * A supervisor that is itself killed is the gap. Its child was
 * spawned into its own process group and outlives it, holding an
 * expensive model against a wall clock nothing is watching, and the
 * pid was only ever known to the process that died.
 */
export async function stopOrphanedSubagents(
	runs: string,
	say: Aside,
): Promise<void> {
	try {
		// Once a window for the whole machine, by whichever session starts
		// first in it. Every session starts or reloads at once after a
		// restart or an install, and each walked every run kept to find
		// what the first had just found: a second and a half of CPU apiece
		// on 3 November. An orphan is only ever looked for at a start, so
		// one left in a window waits for the first start after it.
		if (!(await firstInWindow(runs, "orphans", ORPHAN_LOOK_WINDOW_MS))) {
			return;
		}
		const { reaped, stale, warnings } = await recoverReviewerRuns(
			new ReviewerArtifactsStore(runs),
		);
		// Said out loud, and both halves of it. A session that quietly
		// interferes with processes it finds running is worse than one
		// that leaves them, and whoever is paying for those tokens should
		// hear that they stopped.
		//
		// Stale is the larger set: every one of those was asked to stop,
		// and only the ones whose lease named a process that is
		// identifiably still there could be killed as well. Reporting the
		// killable subset alone would say nothing at all about the run
		// whose child had already gone, which is the ordinary case.
		//
		// Said once, which the recovery decides rather than this: the
		// runs it names are the ones nobody had asked before, since
		// nothing empties this population and the same line would
		// otherwise be printed at every session start forever.
		if (stale.length > 0) {
			say(
				`[subagent-workflow] asked ${count(stale.length, "subagent")} whose supervisor had died to stop${reaped.length > 0 ? `, and killed ${count(reaped.length, "child", "children")} still holding on` : ""}: ${stale
					.map((one) => `${one.runId}/${one.reviewerId}`)
					.join(", ")}`,
			);
		}
		// Capped for the reason the sweep's are: what produces these is
		// rarely one run.
		for (const warning of warnings.slice(0, MOST_WARNINGS)) {
			say(`[subagent-workflow] orphaned subagents: ${warning}`);
		}
	} catch (error) {
		// Advisory, like the sweep beside it: a session that cannot
		// check for orphans is still a session.
		say(
			`[subagent-workflow] could not look for orphaned subagents: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** The conversation a session start belongs to, and how to tell it. */
interface Conversation {
	/** Its pi session id, when pi says. */
	readonly session: string | undefined;
	/** Whether it said anything before this start (see {@link cameBack}). */
	readonly cameBack: boolean;
	/** Tell the model in it something, out of the person's way. */
	readonly tell: (content: string) => void;
}

/**
 * Give back the disk that finished fleets are still holding.
 *
 * Its own function rather than an event handler body, because it is
 * four policies in a row and a handler should say which ones rather
 * than be them.
 */
export async function sweepFleetRuns(
	runs: string,
	fleets: string,
	say: Aside,
	conversation: Conversation,
): Promise<void> {
	const transcripts = join(runs, "runs");
	const ledger = createFleetLedger(fleets);
	try {
		// The machine's sweep is the first start's in its window. A
		// conversation that came back still reads the ledger, to cut off
		// and hear of its own fleets, which nobody else can tell it of.
		const sweeps = await firstInWindow(runs, "sweep", FLEET_SWEEP_WINDOW_MS);
		if (!sweeps && !conversation.cameBack) return;
		const before = await ledger.everyFleet();
		const { unreadable } = before;
		if (unreadable.length > 0) {
			// Declined rather than swept with an empty protect set. An
			// empty set is not the cautious reading of a ledger that will
			// not open: a fleet's transcripts are the only copy of what it
			// said, so sweeping without knowing which are spoken for
			// deletes exactly the work this protects.
			say(
				`[subagent-workflow] fleet runs will not be swept while ${unreadable.join(", ")} cannot be read, because nothing can then say which fleets nobody has collected. Nothing repairs those files on their own, so this holds for every session until they are fixed or moved aside.`,
			);
			return;
		}
		// Cut off every open fleet whose session has provably gone, on its
		// record, once. Only a decisive "gone" counts: a reading the
		// machine would not settle changes nothing, so it can never undo
		// what another session already proved.
		const store = new ReviewerArtifactsStore(runs);
		const abandoned = await abandonedFleets(before.runs, tickFacts, (run) =>
			answersTo(store.rootPaths(run.id).runDir),
		);
		for (const run of abandoned) {
			await recordOrSay(
				() => ledger.cutOff(run.id, "owner-gone"),
				`could not record that ${run.id} was cut off when its session ended, so it stays held as open`,
				say,
			);
		}
		// One walk after those writes, answering every question below. Two
		// reads inside one handler can disagree, and the pair that
		// disagrees is a protect set that kept a run beside a listing that
		// no longer mentions it. With nothing cut off there were no such
		// writes, and the first walk already is that one.
		const held =
			abandoned.length === 0 ? before.runs : (await ledger.everyFleet()).runs;
		if (!sweeps) {
			await tellOwnCutOffs(held, runs, ledger, conversation, say);
			return;
		}
		const kept = stillHeld(
			held,
			new Date(Date.now() - FLEET_RUNS_ABANDONED_AFTER_MS),
		);
		// Digest before sweeping. The sweep is right that whole streams
		// cost too much disk to keep, and wrong that they are only needed
		// while a run is live: they are the only record of what fleet
		// spend bought. A digest is under one percent of a stream and
		// keeps every turn's usage, so the bytes can go and the index stay.
		const digested = await digestFleetRuns(transcripts, join(runs, "digests"));
		// A run that could not be digested, or whose subagent is still
		// writing, is spared, since its stream is still the only copy:
		// nothing is swept that was not first captured.
		const protect = new Set([
			...kept,
			...digested.failed,
			...digested.deferred,
		]);
		if (digested.failed.size > 0) {
			say(
				`[subagent-workflow] kept ${count(digested.failed.size, "fleet")} back from the sweep because ${digested.failed.size === 1 ? "its stream" : "their streams"} could not be digested, and a stream is the only copy of what a subagent did: ${[...digested.failed].join(", ")}`,
			);
		}
		const swept = await new ReviewerArtifactsStore(runs).cleanupTerminalRuns({
			maxRuns: FLEET_RUNS_RETAIN,
			maxAgeMs: FLEET_RUNS_MAX_AGE_MS,
			abandonedAfterMs: FLEET_RUNS_ABANDONED_AFTER_MS,
			protect,
		});
		// Nobody else is told anything about held or cut-off fleets. A
		// fleet another session is running is that session's business, and
		// a cut-off one is worth a word only to the conversation that
		// dispatched it, which hears below when it comes back.
		await rm(join(runs, ABANDONED_SAID_BEFORE), { force: true }).catch(
			() => undefined,
		);
		await tellOwnCutOffs(held, runs, ledger, conversation, say);
		// Capped, because what produces these is rarely one run: a
		// permissions change lands on all of them at once.
		for (const warning of swept.warnings.slice(0, MOST_WARNINGS)) {
			say(`[subagent-workflow] fleet runs: ${warning}`);
		}
		if (swept.warnings.length > MOST_WARNINGS) {
			say(
				`[subagent-workflow] and ${swept.warnings.length - MOST_WARNINGS} more like it, which together say ${transcripts} is not writable rather than that one fleet is stuck.`,
			);
		}
		// Last, and only once the sweep has run, so a record is dropped
		// after the transcripts it points at have gone rather than
		// before. The window is the transcripts' own longest one.
		await ledger.forgetSettledBefore(
			new Date(Date.now() - FLEET_RUNS_ABANDONED_AFTER_MS),
		);
	} catch (error) {
		// Retention is advisory; a transient sweep failure is fine. Said
		// rather than swallowed, though, for the reason the cap above
		// exists: this is the failure that reclaims nothing at all, so
		// reporting the one that misses a single directory and hiding
		// this one gets the priority backwards.
		say(
			`[subagent-workflow] fleet runs were not swept: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
