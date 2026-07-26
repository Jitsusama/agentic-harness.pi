/**
 * What the page asked the network for, and what it got back.
 *
 * The protocol reports one request as a scatter of events over
 * time: sent, replied to, finished or failed, and sometimes
 * sent again when it redirects. Nothing here judges any of it;
 * this only reassembles the pieces into the record the events
 * were always describing.
 */

/**
 * The phase timings Chrome reports for a reply.
 *
 * Every field but requestTime is an offset in milliseconds from
 * it, and a phase that did not happen is reported as -1 rather
 * than left out. Named rather than treated as a bag of numbers,
 * so the shape matches what the protocol actually sends.
 */
export interface ResourceTiming {
	readonly requestTime: number;
	readonly proxyStart?: number;
	readonly proxyEnd?: number;
	readonly dnsStart?: number;
	readonly dnsEnd?: number;
	readonly connectStart?: number;
	readonly connectEnd?: number;
	readonly sslStart?: number;
	readonly sslEnd?: number;
	readonly workerStart?: number;
	readonly workerReady?: number;
	readonly workerFetchStart?: number;
	readonly workerRespondWithSettled?: number;
	readonly sendStart?: number;
	readonly sendEnd?: number;
	readonly pushStart?: number;
	readonly pushEnd?: number;
	readonly receiveHeadersStart?: number;
	readonly receiveHeadersEnd?: number;
}

/** One hop a request took before arriving. */
export interface RedirectHop {
	readonly url: string;
	readonly status: number;
	readonly location?: string;
}

/** Where a request got to. */
export type RequestState = "pending" | "complete" | "failed" | "cancelled";

/** One request, whole. */
export interface NetworkRequest {
	readonly id: string;
	readonly url: string;
	readonly method: string;
	readonly resourceType: string;
	/** The protocol's monotonic clock, good for measuring spans. */
	readonly startedAt: number;
	/**
	 * Wall clock seconds since the epoch, good for saying when.
	 * Kept apart from startedAt because the monotonic clock has no
	 * relationship to any calendar.
	 */
	readonly wallTimeSeconds?: number;
	readonly state: RequestState;
	readonly requestHeaders: Readonly<Record<string, string>>;
	readonly redirects: readonly RedirectHop[];
	readonly postData?: string;
	readonly status?: number;
	readonly statusText?: string;
	readonly mimeType?: string;
	readonly responseHeaders?: Readonly<Record<string, string>>;
	readonly remoteAddress?: string;
	readonly fromCache?: boolean;
	readonly durationMs?: number;
	readonly transferredBytes?: number;
	readonly failure?: string;
	readonly initiator?: string;
	readonly timing?: ResourceTiming;
}

/** Network.requestWillBeSent, as the protocol sends it. */
export interface RequestSent {
	readonly requestId: string;
	readonly timestamp: number;
	readonly wallTime?: number;
	readonly type?: string;
	readonly request: {
		readonly url: string;
		readonly method: string;
		readonly headers: Readonly<Record<string, string>>;
		readonly postData?: string;
		readonly hasPostData?: boolean;
	};
	readonly initiator?: { readonly type: string };
	readonly redirectResponse?: {
		readonly url: string;
		readonly status: number;
		readonly statusText?: string;
		readonly headers?: Readonly<Record<string, string>>;
	};
}

/** Network.responseReceived, as the protocol sends it. */
export interface ResponseReceived {
	readonly requestId: string;
	readonly timestamp: number;
	readonly type?: string;
	readonly response: {
		readonly url: string;
		readonly status: number;
		readonly statusText?: string;
		readonly headers: Readonly<Record<string, string>>;
		readonly mimeType?: string;
		readonly remoteIPAddress?: string;
		readonly remotePort?: number;
		readonly fromDiskCache?: boolean;
		readonly encodedDataLength?: number;
		readonly protocol?: string;
		readonly timing?: ResourceTiming;
	};
}

/** Network.loadingFinished, as the protocol sends it. */
export interface LoadingFinished {
	readonly requestId: string;
	readonly timestamp: number;
	readonly encodedDataLength?: number;
}

/** Network.loadingFailed, as the protocol sends it. */
export interface LoadingFailed {
	readonly requestId: string;
	readonly timestamp: number;
	readonly errorText: string;
	readonly canceled?: boolean;
	readonly blockedReason?: string;
}

/** Any of the four events, tagged so the fold can tell them apart. */
export type NetworkEvent =
	| { readonly kind: "sent"; readonly event: RequestSent }
	| { readonly kind: "received"; readonly event: ResponseReceived }
	| { readonly kind: "finished"; readonly event: LoadingFinished }
	| { readonly kind: "failed"; readonly event: LoadingFailed };

/** A running record of every request, in the order they started. */
export interface NetworkRecorder {
	apply(event: NetworkEvent): void;
	all(): readonly NetworkRequest[];
}

/** Seconds, as the protocol counts, to milliseconds. */
const MS_PER_SECOND = 1000;

export function createNetworkRecorder(): NetworkRecorder {
	// Insertion-ordered, so requests read in the order the page
	// asked for them without a sort that could tie.
	const byId = new Map<string, NetworkRequest>();

	return {
		apply(entry) {
			if (entry.kind === "sent") return applySent(byId, entry.event);

			const existing = byId.get(entry.event.requestId);
			// A reply to a request that started before capture was
			// on says nothing on its own, and inventing a record for
			// it would report a request with no url or method.
			if (!existing) return;

			byId.set(
				entry.event.requestId,
				entry.kind === "received"
					? withResponse(existing, entry.event)
					: entry.kind === "finished"
						? withCompletion(existing, entry.event)
						: withFailure(existing, entry.event),
			);
		},
		all() {
			return [...byId.values()];
		},
	};
}

/**
 * A request starting, or the next hop of one that redirected.
 *
 * A redirect reuses the request id and arrives as another sent
 * event carrying the reply that redirected it. Overwriting
 * would lose the hop, which is often the thing being
 * investigated.
 */
function applySent(
	byId: Map<string, NetworkRequest>,
	event: RequestSent,
): void {
	const previous = byId.get(event.requestId);
	const hop = event.redirectResponse;
	const redirects =
		previous && hop
			? [
					...previous.redirects,
					{
						url: hop.url,
						status: hop.status,
						...(hop.headers?.location === undefined
							? {}
							: { location: hop.headers.location }),
					},
				]
			: (previous?.redirects ?? []);

	byId.set(event.requestId, {
		id: event.requestId,
		url: event.request.url,
		method: event.request.method,
		resourceType: event.type ?? "Other",
		startedAt: previous?.startedAt ?? event.timestamp,
		...((previous?.wallTimeSeconds ?? event.wallTime) === undefined
			? {}
			: { wallTimeSeconds: previous?.wallTimeSeconds ?? event.wallTime }),
		state: "pending",
		requestHeaders: event.request.headers,
		redirects,
		...(event.request.postData === undefined
			? {}
			: { postData: event.request.postData }),
		...(event.initiator?.type === undefined
			? {}
			: { initiator: event.initiator.type }),
	});
}

/** The reply, folded onto the request that asked for it. */
function withResponse(
	request: NetworkRequest,
	event: ResponseReceived,
): NetworkRequest {
	const response = event.response;
	return {
		...request,
		status: response.status,
		...(response.statusText === undefined
			? {}
			: { statusText: response.statusText }),
		...(response.mimeType === undefined ? {} : { mimeType: response.mimeType }),
		responseHeaders: response.headers,
		...(response.remoteIPAddress === undefined
			? {}
			: {
					remoteAddress:
						response.remotePort === undefined
							? response.remoteIPAddress
							: `${response.remoteIPAddress}:${response.remotePort}`,
				}),
		...(response.fromDiskCache === undefined
			? {}
			: { fromCache: response.fromDiskCache }),
		...(response.timing === undefined ? {} : { timing: response.timing }),
	};
}

/** The request finished, however its status reads. */
function withCompletion(
	request: NetworkRequest,
	event: LoadingFinished,
): NetworkRequest {
	return {
		...request,
		// A 404 is a completed transaction. Whether the answer was
		// the wanted one is the reader's judgment, not the
		// protocol's, and not this module's either.
		state: "complete",
		durationMs: Math.round(
			(event.timestamp - request.startedAt) * MS_PER_SECOND,
		),
		...(event.encodedDataLength === undefined
			? {}
			: { transferredBytes: event.encodedDataLength }),
	};
}

/** The request did not finish, and why. */
function withFailure(
	request: NetworkRequest,
	event: LoadingFailed,
): NetworkRequest {
	return {
		...request,
		// A cancellation is usually the page changing its mind,
		// which is not the same news as a request that broke.
		state: event.canceled ? "cancelled" : "failed",
		failure: event.blockedReason
			? `${event.errorText} (blocked: ${event.blockedReason})`
			: event.errorText,
		durationMs: Math.round(
			(event.timestamp - request.startedAt) * MS_PER_SECOND,
		),
	};
}
