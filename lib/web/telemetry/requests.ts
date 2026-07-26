/**
 * Reading a run of requests back.
 *
 * Presentation only. The one editorial choice is ordering the
 * summary by what usually matters: a list of forty successful
 * requests buries the one that failed, so the failures are
 * counted before the list rather than found in it.
 */

import type { NetworkRequest } from "./network.js";

/** Where a status stops being a success. */
const FIRST_ERROR_STATUS = 400;

/** Bytes in a kilobyte, as a browser's network panel counts them. */
const BYTES_PER_KB = 1024;

/** Width of the method column, the longest common verb plus room. */
const METHOD_WIDTH = 6;

/** Width of the status column. */
const STATUS_WIDTH = 8;

/**
 * What the caller asked for, so an empty answer can say which
 * kind of empty it is.
 */
export interface RequestQuery {
	/** The filter applied, when one was. */
	readonly filter?: string;
	/** How many were recorded before filtering. */
	readonly recorded?: number;
}

export function renderRequests(
	requests: readonly NetworkRequest[],
	query: RequestQuery = {},
): string {
	if (requests.length === 0) {
		// An empty filtered list is not a silent page, and saying so
		// was actively misleading: asked for failures on a page that
		// had made eighty requests and had none, the answer was "the
		// page has not requested anything", which reads as the
		// telemetry being broken rather than as good news.
		if (query.filter !== undefined && (query.recorded ?? 0) > 0) {
			return (
				`Nothing matched '${query.filter}', out of ` +
				`${query.recorded} requests recorded.`
			);
		}
		return "The page has not requested anything.";
	}

	const lines = [summarize(requests), ""];
	for (const [index, request] of requests.entries()) {
		// An ordinal rather than the protocol's hex id: the reader
		// has to be able to type it back to ask for a body.
		lines.push(
			`${`#${index + 1}`.padStart(4)}  ` +
				`${request.method.padEnd(METHOD_WIDTH)}` +
				`${statusOf(request).padEnd(STATUS_WIDTH)}` +
				`${timingOf(request).padStart(7)}  ${request.url}`,
		);
		for (const hop of request.redirects) {
			lines.push(`          ${hop.status} from ${hop.url}`);
		}
	}
	return lines.join("\n");
}

/** What happened, before the detail of what each one was. */
function summarize(requests: readonly NetworkRequest[]): string {
	const failed = requests.filter(
		(request) => request.state === "failed",
	).length;
	const cancelled = requests.filter(
		(request) => request.state === "cancelled",
	).length;
	const pending = requests.filter(
		(request) => request.state === "pending",
	).length;
	const errored = requests.filter(
		(request) =>
			request.status !== undefined && request.status >= FIRST_ERROR_STATUS,
	).length;
	const bytes = requests.reduce(
		(total, request) => total + (request.transferredBytes ?? 0),
		0,
	);

	const notes = [
		`${requests.length} request${requests.length === 1 ? "" : "s"}`,
		`${(bytes / BYTES_PER_KB).toFixed(1)} KB transferred`,
	];
	if (failed > 0) notes.push(`${failed} failed`);
	if (cancelled > 0) notes.push(`${cancelled} cancelled`);
	if (errored > 0) {
		notes.push(`${errored} error status${errored === 1 ? "" : "es"}`);
	}
	if (pending > 0) notes.push(`${pending} still in flight`);
	return `${notes.join(", ")}.`;
}

/** The status, or the reason there is not one. */
function statusOf(request: NetworkRequest): string {
	if (request.state === "failed" || request.state === "cancelled") {
		return request.failure ?? request.state;
	}
	if (request.status === undefined) return "pending";
	return String(request.status);
}

/** How long it took, and whether the network was involved at all. */
function timingOf(request: NetworkRequest): string {
	if (request.fromCache) return "cached";
	return request.durationMs === undefined ? "" : `${request.durationMs}ms`;
}
