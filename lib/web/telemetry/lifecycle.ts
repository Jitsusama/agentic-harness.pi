/**
 * Where the page went, and whether it survived the trip.
 *
 * A session's readings are only meaningful against the document
 * they were taken from, so a navigation is a fact worth keeping
 * beside them. A crash is worth keeping for a stronger reason:
 * everything recorded after one belongs to a different tab.
 */

/** What happened to the page. */
export type LifecycleKind =
	| "navigated"
	| "routeChanged"
	| "crashed"
	| "recovered";

/** One thing that happened to the page. */
export interface LifecycleEvent {
	readonly kind: LifecycleKind;
	readonly url?: string;
	/**
	 * How an in-page route change was made. Chrome reports
	 * pushState and replaceState identically as "historyApi", so
	 * this never claims to know which was called.
	 */
	readonly via?: string;
	/** Why Chrome said the navigation was happening, when it said. */
	readonly reason?: string;
}

/** The protocol events this fold consumes. */
export type LifecycleInput =
	| {
			readonly kind: "requested";
			readonly frameId: string;
			readonly reason: string;
	  }
	| {
			readonly kind: "navigated";
			readonly frameId: string;
			readonly url: string;
	  }
	| {
			readonly kind: "within";
			readonly frameId: string;
			readonly url: string;
			readonly navigationType?: string;
	  }
	| { readonly kind: "crashed" }
	| { readonly kind: "recovered"; readonly url?: string };

/** A running record of where the page has been. */
export interface LifecycleRecorder {
	apply(input: LifecycleInput): void;
	all(): readonly LifecycleEvent[];
	/** Follow a new main frame, after a recovery replaced the tab. */
	adoptFrame(frameId: string): void;
}

export function createLifecycleRecorder(
	mainFrameId: string,
): LifecycleRecorder {
	const events: LifecycleEvent[] = [];
	let main = mainFrameId;
	// Chrome announces why it is about to navigate in a separate
	// event just before the navigation itself, so the reason is
	// held until the navigation it belongs to arrives.
	let pendingReason: string | undefined;

	return {
		adoptFrame(frameId) {
			main = frameId;
		},
		apply(input) {
			if (input.kind === "crashed") {
				events.push({ kind: "crashed" });
				return;
			}
			if (input.kind === "recovered") {
				events.push({
					kind: "recovered",
					...(input.url === undefined ? {} : { url: input.url }),
				});
				return;
			}

			// A subframe navigating is the page's business, not the
			// session's: the session is looking at the main document,
			// and an advertisement reloading itself is not news.
			if (input.frameId !== main) return;

			if (input.kind === "requested") {
				pendingReason = input.reason;
				return;
			}
			if (input.kind === "navigated") {
				events.push({
					kind: "navigated",
					url: input.url,
					...(pendingReason === undefined ? {} : { reason: pendingReason }),
				});
				pendingReason = undefined;
				return;
			}
			// A framework that announces its route on startup says the
			// page it is already on, so a plain arrival was recorded
			// twice: once as the navigation and once as the app noticing
			// it. That made the trail longer than the number of pages
			// visited, which is misleading when the trail is what you are
			// counting history depth from. A route change to where we
			// already are is not a move.
			const last = events[events.length - 1];
			if (last && "url" in last && last.url === input.url) return;
			events.push({
				kind: "routeChanged",
				url: input.url,
				...(input.navigationType === undefined
					? {}
					: { via: input.navigationType }),
			});
		},
		all() {
			return events;
		},
	};
}

/** Where the page has been, in order. */
export function renderLifecycle(events: readonly LifecycleEvent[]): string {
	if (events.length === 0) return "The page has not navigated.";

	return events
		.map((event) => {
			if (event.kind === "crashed") {
				return (
					"crashed: the tab died, and nothing read before it " +
					"belongs to the tab reading now"
				);
			}
			if (event.kind === "recovered") {
				return `recovered: a fresh tab${
					event.url ? `, back at ${event.url}` : ""
				}`;
			}
			if (event.kind === "routeChanged") {
				return `route changed to ${event.url}${
					event.via ? ` (${event.via})` : ""
				}`;
			}
			return `navigated to ${event.url}${
				event.reason ? ` (${event.reason})` : ""
			}`;
		})
		.join("\n");
}
