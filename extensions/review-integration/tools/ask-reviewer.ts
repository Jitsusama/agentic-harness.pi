/**
 * How a `review_ask` round runs each reviewer: what it inherits, the
 * sandbox it runs under, the contract and journal it is given, the
 * clocks it is held to, and the impure things a round needs to ask it,
 * count it and keep what it said.
 *
 * Apart from the rounds because this changes with how a reviewer is
 * started and watched, which is the same for every kind of round, and
 * one place keeps a reviewer that waits and one left running from
 * differing in what they get.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lensFor } from "../../../lib/core/review/ask/prompt.ts";
import {
	type AskAnswer,
	type AskContext,
	type AskRound,
	type AskRun,
	boundsFor,
	type ChangeRef,
	type CouncilDeps,
	createFindingStore,
	createRunStore,
	type Finding,
	type Participant,
	type ReviewerBudget,
	reviewerBudget,
} from "../../../lib/core/review/index.ts";
import { loadPackageConfig } from "../../../lib/internal/config/loader.ts";
import { askedSandbox } from "../../../lib/internal/fence/fence-stage.ts";
import {
	fencedChildrenRefusal,
	packageRoot,
} from "../../../lib/internal/fence/installed-only.ts";
import { packageConfigPath } from "../../../lib/internal/paths.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import {
	SANDBOX_NAMES,
	SANDBOX_VARIABLE,
	STRICT,
} from "../../../lib/internal/sandbox/sandbox.ts";
import { firstResponseBegun } from "../../../lib/subagent/first-response.ts";
import type { ReviewerThinkingLevel } from "../../../lib/subagent/index.ts";
import {
	getParentPiInstall,
	getSubagentDefaults,
	JOURNAL_PACK_PATH,
	ReviewerArtifactsStore,
	runReviewer,
	summarizeStreamActivity,
} from "../../../lib/subagent/index.ts";
import { fromScript } from "../../../lib/subagent/runpi/fresh.ts";
import { REVIEW_SLUG } from "../config.ts";
import {
	answerDir,
	findingDir,
	runArtifactDir,
	runDir,
	sessionKey,
} from "../engine.ts";
import type { RoundWatch } from "../progress.ts";
import { answerFromReviewer, keepAnswer, reviewerRunner } from "../reviewer.ts";
import { recordReviewerRun } from "../run-record.ts";
import { askedInRound, roundOpened } from "../run-records.ts";

/** Whether this participant's limits come from its own entry. */
export function keepsItsOwnClocks(participant: Participant): boolean {
	return (
		participant.backstopMs !== undefined ||
		participant.idleMs !== undefined ||
		participant.answerMs !== undefined
	);
}

/**
 * Keep one answer, and never let keeping it cost the round.
 *
 * A full disk or a read-only state directory is a reason to lose the
 * archive, not a reason to lose the findings the reviewer just spent
 * ten minutes producing.
 */
async function keptAt(
	runId: string,
	participantId: string,
	text: string,
): Promise<string | undefined> {
	try {
		return await keepAnswer(answerDir(), runId, participantId, text);
	} catch {
		return undefined;
	}
}

/**
 * What bounds this round's reviewers, as configured.
 *
 * Read from the same section the roster comes from, because who is
 * asked and how long they get are one decision about one fan-out.
 * Falls back to the defaults for any config that cannot be read: a
 * round is better bounded generously than refused over a budget.
 *
 * Hands back a way to ask about one participant rather than the budget
 * itself, because a participant may keep clocks of its own and every
 * place that bounds a reviewer has to narrow to it. A round budget
 * that could be spread straight into a spawn is a round budget that
 * will be, at whichever of the three sites somebody forgets, and that
 * join is the failure this project keeps making. A function cannot be
 * spread, so forgetting stops compiling.
 */
export async function boundsForRound(): Promise<
	(participant: Participant) => ReviewerBudget
> {
	const loaded = await loadPackageConfig(packageConfigPath());
	const review = loaded.ok ? loaded.config.sections[REVIEW_SLUG] : undefined;
	const round = reviewerBudget(
		isRecord(review) ? (review as { ask?: unknown }).ask : undefined,
	);
	return (participant) => boundsFor(participant, round);
}

/**
 * The output contract for one round.
 *
 * A path rather than prose, because it is loaded into the subagent as a
 * skill. Resolved from this file so it works whatever directory the
 * session was started in.
 */
export function contractSkill(round: AskRound): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(
		here,
		"..",
		"..",
		"..",
		"skills",
		`review-${round}-format`,
		"SKILL.md",
	);
}

/**
 * The rounds where writing a finding down as you find it makes sense.
 *
 * The finding-shaped ones. A critique states positions on findings
 * somebody else raised and an audit states standings on threads, so
 * neither has anything to record, and offering the tool would invite
 * an answer in the wrong shape.
 */
const RECORDS_FINDINGS: ReadonlySet<AskRound> = new Set([
	"council",
	"judge",
	"stack",
]);

/**
 * The pack that lets a reviewer write a finding down mid-investigation.
 *
 * Outside `extensions/` deliberately: pi scans that directory, and this
 * tool belongs to a reviewer subagent rather than to the session that
 * dispatched one.
 */
export function journalPack(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	// The location comes from the library, beside the name of the tool
	// this file registers. They are one fact: this loads the pack and
	// then permits that tool by name, and a rename that moves one
	// without the other leaves a reviewer told to call something
	// nothing has registered.
	// Checked at the read, because this is the exact line that took a
	// council down: the constant had just been added to a script
	// module, the session had reloaded rather than restarted, and
	// splitting undefined threw once per reviewer with nothing in the
	// message naming a module or a remedy.
	const path = fromScript(
		JOURNAL_PACK_PATH,
		"JOURNAL_PACK_PATH",
		"lib/subagent/runpi/journal.mjs",
	);
	return join(here, "..", "..", "..", ...path.split("/"));
}

/**
 * Settles once a reviewer's first response has begun, read from the
 * log its supervisor keeps, or once waiting stops being worth it.
 *
 * Both runners write that log in the same place, so the waiting round
 * and the detached one wait the same way.
 */
export async function firstResponseOf(
	runId: string,
	participantId: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const { eventsPath } = new ReviewerArtifactsStore(runArtifactDir()).paths(
		runId,
		participantId,
	);
	return await firstResponseBegun(eventsPath, {
		withinMs: FIRST_RESPONSE_WAIT_MS,
		...(signal === undefined ? {} : { signal }),
	});
}

/**
 * The longest the rest of a round waits on its first reviewer.
 *
 * Its first response normally begins within half a minute: a few
 * seconds for pi to start and the rest for the model to read the
 * brief. Past this the first reviewer is stuck or the brief is
 * enormous, and the rest go ahead and pay for the brief themselves, as
 * every reviewer did before rounds waited at all.
 */
const FIRST_RESPONSE_WAIT_MS = 120_000;

/**
 * Whether a reviewer inherits the machine it runs on.
 *
 * It did, and three things came in that way. The operator's own
 * skills, so the same change reviewed on two machines got two
 * different councils and neither said why. Every extension pi could
 * discover, loaded into a child nobody meant to give them to. And the
 * context files in the working directory, which for a reviewer is a
 * tree pinned to the commit under review: the change's own AGENTS.md,
 * read as standing instruction, written by the author of the change.
 *
 * The last one is the same hole the repo-lens rule closed, sitting
 * open beside it and needing no opt-in at all. Measured with a file
 * that told a child to answer every question with one word, which it
 * then did.
 *
 * A round now says what its reviewers get: the output contract, the
 * journal, the charter, and the repo's conventions as quoted material
 * in the prompt. A constant rather than a literal at two call sites,
 * because a reviewer that waits and a reviewer that is left running
 * must not differ in what they inherit.
 */
export const ISOLATED = true;

/**
 * What every reviewer's pi runs under: the strict sandbox, always and
 * for every round, since each reads a change a stranger may have
 * written, and one rule is easier to trust than a choice. Given to each
 * run as it starts, so a resumed or retried reviewer takes it from the
 * round that starts it, never from a run saved earlier.
 */
export const FENCED = { [SANDBOX_VARIABLE]: STRICT } as const;

/**
 * The extensions that hold a reviewer to that sandbox, by their place
 * in this package. `ISOLATED` loads none of the session's, so the
 * sandbox alone would fence nothing: these run its commands inside the
 * fence, hold its file tools to it and scrub credentials from what they
 * answer, before a finding could quote one onto the change. The shell
 * is first: a reviewer that names no tools gets pi's default palette,
 * whose own bash runs as the person, and until 21 November every
 * reviewer's did, since nothing loaded this package's in its place.
 */
const FENCE_EXTENSIONS = [
	"extensions/shell-workflow/index.ts",
	"extensions/sandbox-file-interceptor/index.ts",
	"extensions/secret-scrub-interceptor/index.ts",
] as const;

/**
 * Why this session may start no reviewer, or nothing: it is fenced and
 * runs this package, or an extension registered for every subagent,
 * from outside the install. Asked as a round begins, before it claims
 * an identity or opens on the ledger, and again as each reviewer is
 * given the fence's extensions.
 */
export function reviewersRefused(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (askedSandbox(env, SANDBOX_NAMES).name === undefined) return undefined;
	const outside = fencedChildrenRefusal(
		false,
		getSubagentDefaults().extensions,
	);
	return outside === undefined ? undefined : `No reviewer started: ${outside}`;
}

/**
 * The fence's extensions, where this package has them: refused, as a
 * fenced session's subagents are, when that session runs this package
 * from outside the install, where its fenced commands could have
 * written the fence's own code.
 */
export function fencePacks(): string[] {
	const refused = reviewersRefused();
	if (refused !== undefined) throw new Error(refused);
	const root = packageRoot();
	return FENCE_EXTENSIONS.map((path) => join(root, ...path.split("/")));
}

/**
 * The impure things a round needs, over the subagent engine and the
 * finding store.
 *
 * The child is pinned to the parent's own pi install rather than to
 * whatever `pi` resolves to on PATH, so a reviewer runs the same
 * build as the session that asked it.
 */
export function deps(
	change: ChangeRef,
	cwd: string,
	watch: RoundWatch,
	charters: ReadonlyMap<string, string> = new Map(),
	// Which round the spend belongs to, when that is not the round
	// doing the asking. A retry runs a throwaway round and substitutes
	// its outcome into the held one, so billing it to the id it ran
	// under files the money against a round the ledger never names and
	// leaves the round that actually paid under-reporting forever. The
	// artifacts still go under the fresh id, because the transcript
	// belongs to the attempt that produced it.
	billTo?: string,
) {
	const findings = createFindingStore(findingDir());
	// The watch knows which round this is, so it is not passed twice.
	const contract = contractSkill(watch.round);
	// Read once for the round rather than once per participant, and
	// started here rather than awaited, so seven reviewers share one
	// config read without any of them waiting on it to be asked.
	const bounds = boundsForRound();
	return {
		warmed: (participant: Participant, runId: string) =>
			firstResponseOf(runId, participant.id, watch.signalFor(participant.id)),
		// Said in the round's run record while it goes on, for the launcher.
		ask: (
			participant: Participant,
			prompt: string,
			context: AskContext,
		): Promise<AskAnswer> =>
			askedInRound(change, watch.round, context.runId, participant, () =>
				askOne(participant, prompt, context),
			),
		record(raised: Omit<Finding, "id">[]) {
			return findings.record(change, raised);
		},
		now: () => new Date(),
		// Written down before the first reviewer is dispatched, so the
		// most expensive thing this tool does stops being the one thing
		// nothing records until it is over. Recorded rather than
		// replaced, since at this point the round is new.
		async opened(run: AskRun) {
			roundOpened(change, run);
			try {
				await createRunStore(runDir()).keep(change, {
					...run,
					startedBy: sessionKey(),
				});
			} catch {
				// Bookkeeping must not cost the round. A ledger that could
				// not be written is worth less than seven reviews, and the
				// settled write at the end will say so again anyway.
			}
		},
		// Every round reports. A round that fans out and says nothing for
		// minutes is indistinguishable from one that has hung, which is
		// the whole reason this exists.
		progress: watch.progress,
	};

	async function askOne(
		participant: Participant,
		prompt: string,
		context: AskContext,
	): Promise<AskAnswer> {
		// This participant's, which is the round's unless it keeps its
		// own. Resolved here rather than once for the round, because a
		// clock sized for the slowest member is a clock every faster
		// member is also held to.
		const budget = (await bounds)(participant);
		// Taken here rather than from the result, since what a run cost
		// in wall time is a fact about the round and the runner does
		// not report one.
		const startedAt = Date.now();
		const result = await runReviewer({
			reviewer: {
				id: participant.id,
				...(participant.model === undefined
					? {}
					: { model: participant.model }),
				...(participant.thinkingLevel === undefined
					? {}
					: {
							thinkingLevel: participant.thinkingLevel as ReviewerThinkingLevel,
						}),
				...(participant.tools === undefined
					? {}
					: { tools: participant.tools }),
			},
			prompt,
			cwd,
			isolated: ISOLATED,
			// The round's output contract, which is what the prompt means
			// by "your output contract skill". Attaching it here rather
			// than restating it in the prompt keeps one copy: a contract
			// stated twice drifts, and the copy in the prompt is the one
			// nobody updates.
			extraSkills: [contract],
			// So a finding survives the reviewer that found it. Every
			// other protection here recovers an answer, and an answer
			// only exists if the reviewer reached the end.
			extraExtensions: [
				...(RECORDS_FINDINGS.has(watch.round) ? [journalPack()] : []),
				...fencePacks(),
			],
			env: FENCED,
			// The charter is a standing instruction, and the system prompt
			// says so, but it rides after the round's brief: every
			// participant's request is then the same up to the end of the
			// brief, which the first writes to the cache and the rest read.
			...lensFor(charters.get(participant.id)),
			// Supervised rather than fire-and-forget, so the reviewer
			// leaves a transcript, a stderr log and a resumable session
			// under the round's own directory. The spawn runner kept all
			// of that in memory and dropped it, which is why a round that
			// cost fifty dollars could be investigated only by paying for
			// it again.
			runPi: reviewerRunner(getParentPiInstall(), runArtifactDir()),
			// Names what this reviewer leaves behind after the round that
			// paid for it, so a transcript can be found from the ledger.
			runId: context.runId,
			// Two things, both of which need the session the supervisor
			// persists: a resume after a transient provider drop, and,
			// for a reviewer we stopped, an ask for the findings it had
			// already formed. The second is the one that matters here,
			// since a stop carries no error and so can never reach the
			// first.
			autoResume: true,
			// Cancellable, so Escape on the panel really stops the work
			// rather than only hiding it. The runner kills the child on
			// abort; all that was ever missing was passing the signal down.
			// This participant's own, so cancelling one leaves the rest
			// running. It is derived from the round's, so Escape still
			// reaches every one of them.
			signal: watch.signalFor(participant.id),
			// Bounded twice, and the idle clock is the one doing the work:
			// it catches a participant that has gone silent, while the wall
			// clock only backstops one that nothing else will stop. Bounding
			// on the wall clock alone is what killed six rounds of reviewers
			// that were still working.
			...budget,
			// The one place a subprocess becomes something a person can
			// watch. The library cannot see a stream, so it is told.
			...(context.report === undefined
				? {}
				: {
						onEvent(event) {
							const activity = summarizeStreamActivity(event);
							if (activity !== null) context.report?.(activity);
						},
					}),
		});
		// Counted before it is read, and counted whatever it turns
		// out to say. This is the same publication a fleet makes for
		// each of its subagents, and it is what puts a round in the
		// footer meter and in the run table beside one.
		recordReviewerRun({
			runId: billTo ?? context.runId,
			participantId: participant.id,
			...(participant.model === undefined ? {} : { model: participant.model }),
			// Left unset, the child inherits pi's default, which this
			// process cannot see, so unset records as unknown.
			thinkingLevel: participant.thinkingLevel ?? null,
			startedAt,
			result,
		});
		// Told what it was allowed, so a stop records the clock it ran
		// out of rather than only that one did. A retry cannot
		// otherwise tell whether anything has changed since.
		const answer = answerFromReviewer(result, budget);
		if ("failure" in answer) return answer;
		// Kept before it is read, and kept whatever it turns out to
		// hold. An answer that parses is already represented by its
		// findings; the one worth keeping is the one that does not,
		// and that is exactly the one the old path threw away.
		return {
			...answer,
			answerPath: await keptAt(context.runId, participant.id, answer.text),
		};
	}
}

/**
 * The same dependencies, for a round that is not a new round.
 *
 * A retry runs one participant through the council path to substitute
 * its outcome into a round that already exists. That path now opens a
 * ledger entry before it asks, which is right for a round somebody
 * asked for and wrong here: it would leave a one-participant round on
 * the ledger that nothing ever settles, and an unsettled round is
 * precisely the signal meaning a session died holding one. The retry
 * would manufacture the alarm it is meant to help answer.
 *
 * Both retries, now that the judge writes itself down too. Only the
 * council path was wrapped, which was harmless for exactly as long as
 * the judge ignored the callback, and became a stray round the day it
 * stopped.
 */
export function substituting(deps: CouncilDeps): Omit<CouncilDeps, "opened"> {
	// Typed against CouncilDeps rather than a structural constraint.
	// `T extends { opened?: unknown }` was satisfied by every object
	// type, so renaming the callback would have left this returning
	// its argument untouched and quietly restored the stray round,
	// with nothing to report it. Named concretely, the same rename is
	// a compile error here.
	const { opened: _discarded, ...rest } = deps;
	return rest;
}
