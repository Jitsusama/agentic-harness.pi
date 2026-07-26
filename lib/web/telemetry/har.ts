/**
 * Recorded requests as an HTTP Archive.
 *
 * HAR is what every other tool reads, so exporting it is how a
 * capture leaves here without being trapped in our own shape.
 * The format has invariants of its own, and they are the reason
 * this is a module rather than a JSON.stringify: entry.time has
 * to equal the sum of the timings that are not -1, send, wait
 * and receive have to be present and non-negative, and any
 * field the spec does not define has to start with an
 * underscore or a reader is entitled to reject the file.
 *
 * Where the protocol gives no answer, this says so with -1
 * rather than guessing, and puts anything extra we do know in
 * an underscore field instead of overstating a spec one.
 */

import type { NetworkRequest } from "./network.js";

/** A name and value, as HAR writes headers and query parameters. */
export interface HarPair {
	readonly name: string;
	readonly value: string;
}

/** HAR's per-request timing breakdown, in milliseconds. */
export interface HarTimings {
	readonly blocked: number;
	readonly dns: number;
	readonly connect: number;
	readonly ssl: number;
	readonly send: number;
	readonly wait: number;
	readonly receive: number;
}

/** One archived request and its reply. */
export interface HarEntry {
	readonly startedDateTime: string;
	readonly time: number;
	readonly request: {
		readonly method: string;
		readonly url: string;
		readonly httpVersion: string;
		readonly cookies: readonly HarPair[];
		readonly headers: readonly HarPair[];
		readonly queryString: readonly HarPair[];
		readonly headersSize: number;
		readonly bodySize: number;
		readonly postData?: {
			readonly mimeType: string;
			readonly text: string;
		};
	};
	readonly response: {
		readonly status: number;
		readonly statusText: string;
		readonly httpVersion: string;
		readonly cookies: readonly HarPair[];
		readonly headers: readonly HarPair[];
		readonly content: {
			readonly size: number;
			readonly mimeType: string;
			readonly text?: string;
			readonly encoding?: string;
		};
		readonly redirectURL: string;
		readonly headersSize: number;
		readonly bodySize: number;
	};
	readonly cache: Record<string, never>;
	readonly timings: HarTimings;
	readonly serverIPAddress?: string;
	readonly connection?: string;
	/** What the request was for, which HAR has no field for. */
	readonly _resourceType?: string;
	/** Why it failed, which HAR has no field for either. */
	readonly _failure?: string;
	/** Bytes over the wire including headers, which bodySize is not. */
	readonly _transferredBytes?: number;
}

/** The archive itself. */
export interface Har {
	readonly log: {
		readonly version: "1.2";
		readonly creator: { readonly name: string; readonly version: string };
		readonly pages: readonly unknown[];
		readonly entries: readonly HarEntry[];
	};
}

/** A body already fetched for a request, keyed by request id. */
export interface HarOptions {
	readonly bodies?: ReadonlyMap<
		string,
		{ body: string; base64Encoded: boolean }
	>;
}

/** What HAR uses for a measurement that does not apply. */
const NOT_APPLICABLE = -1;

/** Milliseconds in a second, for the protocol's seconds-based clocks. */
const MS_PER_SECOND = 1000;

export function toHar(
	requests: readonly NetworkRequest[],
	options: HarOptions = {},
): Har {
	return {
		log: {
			version: "1.2",
			creator: { name: "pi browser-integration", version: "1" },
			pages: [],
			entries: requests.map((request) => entryOf(request, options)),
		},
	};
}

/** One request, in the shape a HAR reader expects. */
function entryOf(request: NetworkRequest, options: HarOptions): HarEntry {
	const timings = timingsOf(request);
	const body = options.bodies?.get(request.id);
	const contentType = headerOf(request.responseHeaders, "content-type");
	const location = headerOf(request.responseHeaders, "location");

	return {
		startedDateTime: startedAt(request),
		// The spec requires this to be the sum, so it is computed
		// from the parts rather than from the measured duration,
		// which would usually differ by a rounding.
		time: total(timings),
		request: {
			method: request.method,
			url: request.url,
			httpVersion: "",
			cookies: [],
			headers: pairsOf(request.requestHeaders),
			queryString: queryOf(request.url),
			headersSize: NOT_APPLICABLE,
			bodySize: request.postData ? request.postData.length : NOT_APPLICABLE,
			...(request.postData === undefined
				? {}
				: {
						postData: {
							mimeType: headerOf(request.requestHeaders, "content-type") ?? "",
							text: request.postData,
						},
					}),
		},
		response: {
			status: request.status ?? 0,
			statusText: request.statusText ?? "",
			httpVersion: "",
			cookies: [],
			headers: pairsOf(request.responseHeaders),
			content: {
				size: body ? body.body.length : 0,
				mimeType: request.mimeType ?? contentType ?? "",
				...(body === undefined ? {} : { text: body.body }),
				...(body?.base64Encoded ? { encoding: "base64" } : {}),
			},
			// Empty rather than absent: the field is required, and a
			// reader distinguishes "no redirect" from "not recorded".
			redirectURL: location ?? "",
			headersSize: NOT_APPLICABLE,
			// The protocol counts bytes over the wire, headers
			// included, which is not what bodySize means. Saying -1 is
			// honest; the number we do have goes in its own field.
			bodySize: NOT_APPLICABLE,
		},
		cache: {},
		timings,
		...(request.remoteAddress === undefined
			? {}
			: { serverIPAddress: request.remoteAddress }),
		_resourceType: request.resourceType,
		...(request.failure === undefined ? {} : { _failure: request.failure }),
		...(request.transferredBytes === undefined
			? {}
			: { _transferredBytes: request.transferredBytes }),
	};
}

/**
 * When the request started, on a clock that means something.
 *
 * The protocol's own timestamp is monotonic and has no relation
 * to any calendar, so the wall clock is the only one that can
 * answer this. Without it there is nothing honest to say, and
 * the epoch is the conventional placeholder.
 */
function startedAt(request: NetworkRequest): string {
	const seconds = request.wallTimeSeconds;
	return seconds === undefined
		? new Date(0).toISOString()
		: new Date(seconds * MS_PER_SECOND).toISOString();
}

/**
 * The phases of the request, in HAR's vocabulary.
 *
 * The protocol reports offsets in milliseconds from the moment
 * the request began, with -1 for a phase that did not happen.
 * HAR wants durations instead, and treats -1 the same way, so
 * the translation is subtraction where both ends are real and
 * -1 wherever either is not.
 */
function timingsOf(request: NetworkRequest): HarTimings {
	const timing = request.timing;
	if (!timing) {
		// Nothing was measured. Rather than invent a breakdown, put
		// the whole measured duration in receive, which keeps the
		// sum invariant true and the total honest.
		return {
			blocked: NOT_APPLICABLE,
			dns: NOT_APPLICABLE,
			connect: NOT_APPLICABLE,
			ssl: NOT_APPLICABLE,
			send: 0,
			wait: 0,
			receive: Math.max(0, request.durationMs ?? 0),
		};
	}

	const dns = span(timing.dnsStart, timing.dnsEnd);
	const connect = span(timing.connectStart, timing.connectEnd);
	const ssl = span(timing.sslStart, timing.sslEnd);
	const send = Math.max(0, span(timing.sendStart, timing.sendEnd));
	const wait = Math.max(0, span(timing.sendEnd, timing.receiveHeadersEnd));

	// Whatever came before the first phase that happened is time
	// the request spent queued.
	const firstPhase = [timing.dnsStart, timing.connectStart, timing.sendStart]
		.filter((offset): offset is number => offset !== undefined && offset >= 0)
		.sort((left, right) => left - right)[0];
	const blocked = firstPhase === undefined ? NOT_APPLICABLE : firstPhase;

	// Everything after the headers arrived was spent reading the
	// body, when we know how long the whole thing took.
	const headersDone = timing.receiveHeadersEnd ?? 0;
	const receive =
		request.durationMs === undefined
			? 0
			: Math.max(0, request.durationMs - headersDone);

	return { blocked, dns, connect, ssl, send, wait, receive };
}

/** A duration between two offsets, or -1 if either did not happen. */
function span(start: number | undefined, end: number | undefined): number {
	if (start === undefined || end === undefined) return NOT_APPLICABLE;
	if (start < 0 || end < 0) return NOT_APPLICABLE;
	return end - start;
}

/** The sum HAR requires entry.time to equal. */
function total(timings: HarTimings): number {
	return Object.values(timings)
		.filter((value) => value >= 0)
		.reduce((sum, value) => sum + value, 0);
}

/** Headers as HAR's name and value pairs. */
function pairsOf(
	headers: Readonly<Record<string, string>> | undefined,
): readonly HarPair[] {
	return Object.entries(headers ?? {}).map(([name, value]) => ({
		name,
		value,
	}));
}

/** One header, found without caring how it was capitalized. */
function headerOf(
	headers: Readonly<Record<string, string>> | undefined,
	wanted: string,
): string | undefined {
	const found = Object.entries(headers ?? {}).find(
		([name]) => name.toLowerCase() === wanted,
	);
	return found?.[1];
}

/** The query string, split the way a url says it splits. */
function queryOf(url: string): readonly HarPair[] {
	try {
		return [...new URL(url).searchParams].map(([name, value]) => ({
			name,
			value,
		}));
	} catch {
		// A url the URL parser rejects has no query worth reporting,
		// and failing the whole export over it would be worse.
		return [];
	}
}
