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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
 * the one somebody may still be trying to recover.
 */
const ROUNDS_RETAIN = 100;
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
	// Both paths up front, before anything is awaited. These resolve
	// against the environment each time they are called, and this runs
	// unawaited, so a second lookup after the first await is a lookup
	// against whatever the environment says by then. In a test that
	// points the state directory at a sandbox and takes it away again,
	// that is a sweep of the real one.
	const transcripts = runArtifactDir();
	const attached = attachmentDir();
	const mine = sessionKey();
	// Which rounds are still waiting to be collected. A detached round
	// is finished on disk and unfinished to the person who started it,
	// and this is the only thing that tells the two apart: without it
	// the sweep deletes reviews that have been paid for and were about
	// to be read.
	let protect: ReadonlySet<string> = new Set();
	try {
		protect = await createRunStore(runDir()).openRunIds();
	} catch {
		// An unreadable ledger must not stop the sweep, but it must not
		// licence one either: an empty protect set is the cautious
		// reading only because the sweep below keeps anything it is
		// unsure about for the abandoned window first.
	}
	// Separately, because one failing is not a reason to skip the
	// other, and the transcript sweep races other sessions by nature.
	try {
		await new ReviewerArtifactsStore(transcripts).cleanupTerminalRuns({
			maxRuns: ROUNDS_RETAIN,
			maxAgeMs: ROUNDS_MAX_AGE_MS,
			abandonedAfterMs: ROUNDS_ABANDONED_AFTER_MS,
			protect,
		});
	} catch {
		// Advisory. A sweep that cannot run costs disk, and failing the
		// session over it would cost the session.
	}
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
async function carryAttachmentsIntoAFork(event: unknown): Promise<void> {
	if (typeof event !== "object" || event === null) return;
	const started = event as { reason?: unknown; previousSessionFile?: unknown };
	if (started.reason !== "fork") return;
	if (typeof started.previousSessionFile !== "string") return;
	// Read before anything is awaited, for the reason the sweep gives:
	// this resolves against the environment each time, and a lookup
	// after an await is a lookup against whatever the environment says
	// by then.
	const root = attachmentDir();
	const mine = sessionKey();
	try {
		const parent = await sessionIdIn(started.previousSessionFile);
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
	pi.on("session_start", (event, ctx) => {
		// Which session this is, from the only thing that knows. What a
		// session has attached is scoped by it, and a session that cannot
		// say who it is shares a directory with every other one.
		rememberSession(ctx.sessionManager.getSessionId());
		void carryAttachmentsIntoAFork(event);
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
