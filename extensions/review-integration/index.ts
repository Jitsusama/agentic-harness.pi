/**
 * Review Integration Extension
 *
 * Hosts the review substrate: owns the provider registry for a
 * session, registers the providers this package ships, and
 * exposes the four tools that read and write a review.
 *
 * Providers register over the event bus rather than by importing
 * the registry, so one can live in another package entirely. The
 * handshake runs both ways: this extension emits `review:ready`
 * when its registry is live, and accepts registrations at any
 * time, so neither load order matters.
 */

import type {
	ExtensionAPI,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
	clearTargetBindings,
	createRunStore,
	inheritAttachments,
	listReviewProviders,
	pruneAttachments,
	REVIEW_READY,
	REVIEW_REGISTER_PROVIDER,
	REVIEW_REQUEST_SUBSTRATE,
	type ReviewProvider,
	type ReviewSubstrateApi,
	registerReviewProvider,
} from "../../lib/review/index.js";
import {
	ReviewerArtifactsStore,
	recoverReviewerRuns,
} from "../../lib/subagent/index.js";
import { count } from "../../lib/ui/index.js";
import {
	attachmentDir,
	forgetReviewEngine,
	registerBuiltinReviewProviders,
	rememberSession,
	reviewEngine,
	runArtifactDir,
	runDir,
	sessionIdIn,
	sessionKey,
} from "./engine.js";
import { guardPublishes } from "./guard-publish.js";
import {
	registerAskTool,
	registerDraftTool,
	registerOfferTool,
	registerReviewTool,
	registerSayTool,
	registerSeeTool,
} from "./tools.js";
import { forgetWorkLayer, watchForWorkLayer } from "./work.js";

/**
 * Whether a bus payload is a usable provider. The bus is
 * untyped, and a malformed registration should be ignored
 * rather than corrupting the registry.
 */
function isProvider(data: unknown): data is ReviewProvider {
	if (typeof data !== "object" || data === null) return false;
	const candidate = data as Partial<ReviewProvider>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.priority === "number" &&
		typeof candidate.claimReference === "function" &&
		typeof candidate.claimRepo === "function" &&
		typeof candidate.capabilities === "function"
	);
}

/**
 * How many rounds' transcripts to keep, and for how long.
 *
 * A round is seven reviewers and each one's event stream is capped at
 * ten megabytes across rotations, so a busy day writes hundreds of
 * megabytes. Keeping a transcript is what makes a lost round
 * diagnosable; keeping every transcript ever written is just a disk
 * that fills. An unfinished run is held far longer, because that is
 * the one somebody may still be trying to recover, and a round still
 * open on the ledger is held until somebody settles it, because until
 * they collect it these files are the only copy of what its reviewers
 * said.
 */
const ROUNDS_RETAIN = 100;
/**
 * How many uncollected rounds before the sweep says so.
 *
 * Not one, because one is the ordinary state of somebody who started
 * a round this morning and has not read it yet, and a message at
 * every session start is a message nobody reads. Enough of them to be
 * a habit rather than a moment.
 */
const ROUNDS_HELD_BEFORE_SAYING = 5;
/**
 * How many sweep failures to print before summarizing the rest.
 *
 * These arrive per run directory, and what causes them is rarely one
 * run: a permissions change lands on all of them at once, so the
 * choice is a cap or a hundred lines.
 */
const MOST_WARNINGS = 5;
const ROUNDS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ROUNDS_ABANDONED_AFTER_MS = 4 * ROUNDS_MAX_AGE_MS;

/**
 * How long a session's attachments outlive the session.
 *
 * Generous, because the cost of keeping one is a few hundred bytes and
 * the cost of taking it early is somebody's resumed session forgetting
 * what it was working on. The sweep never touches the caller's own.
 */
const ATTACHMENTS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Give back the disk that finished rounds are still holding.
 *
 * At session start rather than after a round, so a sweep never delays
 * an answer somebody is waiting for, and advisory throughout: failing
 * to reclaim space is not a reason to fail a session.
 */
async function reclaimRoundTranscripts(): Promise<void> {
	// Every path up front, before anything is awaited. These resolve
	// against the environment each time they are called, and this runs
	// unawaited, so a second lookup after the first await is a lookup
	// against whatever the environment says by then. In a test that
	// points the state directory at a sandbox and takes it away again,
	// that is a sweep of the real one.
	//
	// Every path, so the ledger is read here too and passed down. It
	// was being looked up inside the sweep, one await later, by a
	// function extracted out of this one from below this comment.
	const transcripts = runArtifactDir();
	const rounds = runDir();
	const attached = attachmentDir();
	const mine = sessionKey();
	// Separately, because one failing is not a reason to skip the
	// other, and the transcript sweep races other sessions by nature.
	// Each in its own function for the same reason: declining the
	// transcript sweep has to be a decision about the transcript sweep,
	// and a bare return inside this one was twice a decision about
	// everything below it.
	await sweepTranscripts(transcripts, rounds);
	try {
		await pruneAttachments(attached, {
			olderThanMs: ATTACHMENTS_MAX_AGE_MS,
			keep: mine,
		});
	} catch {
		// Advisory, for the same reason.
	}
	try {
		await reapOrphanedReviewers(transcripts);
	} catch {
		// Advisory, for the same reason.
	}
}

/**
 * Reclaim what finished rounds are holding, or decline and say why.
 *
 * Its own function because declining is a real outcome here, and the
 * two ways of expressing that inside the caller were a bare return
 * that also cancelled the sweeps below it and a flag threaded past
 * them.
 */
async function sweepTranscripts(
	transcripts: string,
	rounds: string,
): Promise<void> {
	try {
		// Which rounds are still waiting to be collected. A detached
		// round is finished on disk and unfinished to the person who
		// started it, and this is the only thing that tells the two
		// apart: without it the sweep deletes reviews that have been paid
		// for and were about to be read.
		//
		// Inside the try, so a ledger that will not read takes the sweep
		// with it. An empty set is not the cautious reading of an
		// unreadable ledger, it is the most destructive one: a detached
		// round that finished on disk is terminal, so with nothing
		// protecting it the ordinary week takes it, and the findings go
		// while the ledger entry advertising them stays. Skipping costs a
		// session's worth of disk, and the next session sweeps.
		const { open, unreadable } = await createRunStore(rounds).openRunIds();
		if (unreadable.length > 0) {
			// An incomplete protect set is worse than none of the sweep. The
			// rounds missing from it cannot be named, and each one is a
			// detached round that finished on disk, so nothing protecting it
			// means the ordinary week takes findings nobody has read.
			//
			// Named, and named as something to go and fix, because nothing
			// heals a torn file: this is not one session's sweep deferred,
			// it is every sweep from here until somebody deals with it.
			console.error(
				`[review-integration] round transcripts will not be swept while ${unreadable.join(", ")} cannot be read, since a round waiting to be collected cannot be told from one nobody needs. Nothing repairs that file on its own, so this holds for every session until it is fixed or moved aside.`,
			);
			return;
		}
		const swept = await new ReviewerArtifactsStore(
			transcripts,
		).cleanupTerminalRuns({
			maxRuns: ROUNDS_RETAIN,
			maxAgeMs: ROUNDS_MAX_AGE_MS,
			abandonedAfterMs: ROUNDS_ABANDONED_AFTER_MS,
			protect: open,
		});
		// How much protection is holding, once there is enough of it to
		// be worth a person's attention. Nothing else can tell them: a
		// protected round is one nobody collected, every listing is scoped
		// to one change, and a round opened against a change nobody
		// attaches again appears in none of them. Protection is absolute,
		// so this is the only population here that grows without a limit.
		if (swept.held >= ROUNDS_HELD_BEFORE_SAYING) {
			console.error(
				`[review-integration] ${swept.held} rounds are open and holding their reviewers' transcripts, which until a round is collected is the only copy of what its reviewers said, and is megabytes per reviewer. Attach the change a round was started on and collect it to file the findings, or stop it to close one that left nothing. Both need the change, so deal first with the changes you are about to stop thinking about.`,
			);
		}
		// Said out loud, because the summary was being computed and
		// dropped. A round is megabytes per reviewer, so a sweep that
		// cannot delete what it decided to delete is a disk filling at a
		// rate nothing reports, and the way that gets noticed is the disk
		// being full. Only the failures: a sweep doing its job every
		// session start has nothing to say.
		// Capped, because the failures that produce these are the ones
		// that hit every run at once: a mode botched across the tree
		// would otherwise print a hundred lines into somebody's session
		// start and bury whatever else was said.
		for (const warning of swept.warnings.slice(0, MOST_WARNINGS)) {
			console.error(`[review-integration] round transcripts: ${warning}`);
		}
		if (swept.warnings.length > MOST_WARNINGS) {
			console.error(
				`[review-integration] and ${swept.warnings.length - MOST_WARNINGS} more like it, which together say the transcripts directory is not writable rather than that one round is stuck.`,
			);
		}
	} catch (error) {
		// Advisory. A sweep that cannot run costs disk, and failing the
		// session over it would cost the session. Named rather than
		// silent, because whatever lands here means this directory is
		// growing with nothing watching it.
		//
		// A ledger that will not read is no longer one of them: that is
		// answered rather than thrown, and declined above by name. What
		// is left is the store failing to list its own root, and a change
		// ledger whose file is there and will not open, which the read
		// refuses over rather than treating as a change with no history.
		console.error(
			`[review-integration] round transcripts were not swept: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Give a fork what the session it came from was working on.
 *
 * A fork is the same conversation continued, and pi mints it a new
 * session id. Attachments are scoped by session id, which is what
 * stopped one session retargeting another's round, and the cost was
 * paid here: every fork began with nothing attached, so the first
 * review call after one refused for want of a change, or acted on
 * whatever got named by hand instead.
 *
 * Only for a fork. Pi names a previous session file on a resume and on
 * a new session too, and neither should inherit: a resume already
 * carries the id its attachments are under, and a new session is
 * somebody starting clean.
 *
 * Unawaited by the caller, like the other housekeeping, so starting a
 * session is never delayed by it, and advisory throughout: a fork that
 * cannot read its parent starts where it would have started anyway.
 */
async function carryAttachmentsIntoAFork(
	event: SessionStartEvent,
): Promise<void> {
	// Typed as pi types it, so a rename upstream is a compile error
	// here rather than a condition that silently stops matching.
	if (event.reason !== "fork") return;
	const { previousSessionFile } = event;
	if (previousSessionFile === undefined) return;
	// Read before anything is awaited, for the reason the sweep gives:
	// this resolves against the environment each time, and a lookup
	// after an await is a lookup against whatever the environment says
	// by then.
	const root = attachmentDir();
	const mine = sessionKey();
	try {
		const parent = await sessionIdIn(previousSessionFile);
		if (parent === undefined) return;
		await inheritAttachments(root, parent, mine);
	} catch (error) {
		// Advisory, so a fork never fails to start over a convenience,
		// but never silent. This catch swallowed a missing export the
		// first time it ran, and a fork that quietly forgets what it
		// was working on is the bug this function exists to fix.
		console.warn(`Could not carry attachments into this fork: ${error}`);
	}
}

/**
 * Find reviewers whose supervisor died and stop them.
 *
 * A supervisor that dies hard leaves its reviewer holding a model
 * open until the reviewer's own backstop, three quarters of an hour
 * later, with nobody left to give the answer to. Nothing else can
 * reach it: the pid was known only to the process that died, and the
 * cancellation file that would stop it is read by that same
 * supervisor.
 *
 * At session start, beside the other reclamations, and for the same
 * reason: it is about the machine rather than about this session's
 * work, so it must not delay anything a person is waiting on.
 */
async function reapOrphanedReviewers(transcripts: string): Promise<void> {
	const store = new ReviewerArtifactsStore(transcripts);
	const { reaped } = await recoverReviewerRuns(store);
	if (reaped.length === 0) return;
	// Said out loud. A session that quietly kills processes it found
	// running is worse than one that leaves them, and somebody paying
	// for those tokens should be told they stopped.
	console.warn(
		`Stopped ${count(reaped.length, "reviewer")} whose supervisor had died: ${reaped
			.map((one) => `${one.runId}/${one.reviewerId}`)
			.join(", ")}.`,
	);
}

export default function reviewIntegration(pi: ExtensionAPI) {
	registerBuiltinReviewProviders(pi);

	registerReviewTool(pi);
	registerSeeTool(pi);
	registerSayTool(pi);
	registerAskTool(pi);
	registerDraftTool(pi);
	registerOfferTool(pi);

	const api: ReviewSubstrateApi = {
		registerProvider(provider: ReviewProvider) {
			registerReviewProvider(provider);
		},
		listProviders() {
			return listReviewProviders().map((provider) => provider.id);
		},
		async engine() {
			return (await reviewEngine(pi)).engine;
		},
	};

	pi.events.on(REVIEW_REGISTER_PROVIDER, (data: unknown) => {
		if (isProvider(data)) registerReviewProvider(data);
	});
	// A consumer that loaded after this extension missed the
	// announcement, and the bus does not replay. Asking is how it
	// catches up, so load order decides nothing.
	pi.events.on(REVIEW_REQUEST_SUBSTRATE, () => {
		pi.events.emit(REVIEW_READY, api);
	});
	pi.events.emit(REVIEW_READY, api);

	// This package is a consumer of the working layer as well as a
	// host of the review one: a round asks it for a tree pinned to
	// the commit under review. The dependency is optional, so a
	// missing working layer costs a caveat rather than the round.
	watchForWorkLayer(pi);

	// And an answerer for it. The working layer asks before publishing a
	// branch, and whether a change is queued to merge is a fact only this side
	// holds. Registered unconditionally: either something asks and this
	// answers, or nothing asks and it costs nothing.
	guardPublishes(pi);

	// On pi's own lifecycle API rather than the event bus, because the
	// bus hands a handler the event and nothing else, and which session
	// this is only comes with the context.
	pi.on("session_start", async (event, ctx) => {
		// Which session this is, from the only thing that knows. What a
		// session has attached is scoped by it, and a session that cannot
		// say who it is shares a directory with every other one.
		rememberSession(ctx.sessionManager.getSessionId());
		// Awaited, and before the sweep. Awaited because a fork whose
		// first review call lands before the copy finishes sees the
		// refusal this exists to prevent, and before the sweep because
		// the sweep spares only the session asking: at a fork that is
		// not the session being read from, so an idle parent is a
		// candidate for deletion in the same tick as the copy.
		await carryAttachmentsIntoAFork(event);
		// A new session must not inherit the last one's bindings, or
		// a target could stay pinned to a provider the user has since
		// reconfigured away from.
		clearTargetBindings();
		forgetReviewEngine();
		// Nor the last one's broker, which would hand out trees from a
		// registry the new session has not rebuilt yet.
		forgetWorkLayer();
		watchForWorkLayer(pi);
		void reclaimRoundTranscripts();
	});
}
