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
	listReviewProviders,
	pruneAttachments,
	REVIEW_READY,
	REVIEW_REGISTER_PROVIDER,
	REVIEW_REQUEST_SUBSTRATE,
	type ReviewProvider,
	type ReviewSubstrateApi,
	registerReviewProvider,
} from "../../lib/review/index.js";
import { ReviewerArtifactsStore } from "../../lib/subagent/index.js";
import {
	attachmentDir,
	forgetReviewEngine,
	registerBuiltinReviewProviders,
	rememberSession,
	reviewEngine,
	runArtifactDir,
	runDir,
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
	pi.on("session_start", (_event, ctx) => {
		// Which session this is, from the only thing that knows. What a
		// session has attached is scoped by it, and a session that cannot
		// say who it is shares a directory with every other one.
		rememberSession(ctx.sessionManager.getSessionId());
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
