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
	listReviewProviders,
	REVIEW_READY,
	REVIEW_REGISTER_PROVIDER,
	REVIEW_REQUEST_SUBSTRATE,
	type ReviewProvider,
	type ReviewSubstrateApi,
	registerReviewProvider,
} from "../../lib/review/index.js";
import {
	forgetReviewEngine,
	registerBuiltinReviewProviders,
	reviewEngine,
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

	pi.events.on("session_start", () => {
		// A new session must not inherit the last one's bindings, or
		// a target could stay pinned to a provider the user has since
		// reconfigured away from.
		clearTargetBindings();
		forgetReviewEngine();
		// Nor the last one's broker, which would hand out trees from a
		// registry the new session has not rebuilt yet.
		forgetWorkLayer();
		watchForWorkLayer(pi);
	});
}
