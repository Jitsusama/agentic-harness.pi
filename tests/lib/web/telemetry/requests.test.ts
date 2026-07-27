/**
 * Reading a run of requests back. The summary has to lead with
 * the bad news, since a list of forty successful requests
 * buries the one that failed.
 */

import { describe, expect, it } from "vitest";
import type { NetworkRequest } from "../../../../lib/web/telemetry/network.js";
import {
	anyUrlShortened,
	renderRequests,
	requestStatus,
} from "../../../../lib/web/telemetry/requests.js";

const request = (over: Partial<NetworkRequest> = {}): NetworkRequest => ({
	id: "REQ1",
	url: "http://localhost:8731/index.html",
	method: "GET",
	resourceType: "Document",
	startedAt: 100,
	state: "complete",
	requestHeaders: {},
	redirects: [],
	status: 200,
	durationMs: 12,
	transferredBytes: 387,
	...over,
});

describe("requestStatus", () => {
	it("names the state when a cancelled request carries no reason", () => {
		// Chrome usually cancels without saying why, and every reader
		// of the failure field has to survive that.
		const cancelled = request({
			state: "cancelled",
			status: undefined,
			failure: undefined,
		});

		expect(requestStatus(cancelled)).toBe("cancelled");
	});

	it("prefers the reason when there is one", () => {
		const failed = request({
			state: "failed",
			status: undefined,
			failure: "net::ERR_NAME_NOT_RESOLVED",
		});

		expect(requestStatus(failed)).toBe("net::ERR_NAME_NOT_RESOLVED");
	});

	it("says a request still in flight is pending", () => {
		const inFlight = request({ state: "pending", status: undefined });

		expect(requestStatus(inFlight)).toBe("pending");
	});
});

describe("renderRequests", () => {
	it("shortens a url that is mostly query string", () => {
		// A real bundler request was twelve hundred characters, all
		// but sixty of them a module list. Three of those filled an
		// eighth of the budget each and pushed whole requests out of
		// the answer, to preserve query strings nobody reads in a
		// listing and which the stored records still hold in full.
		const long = `https://en.wikipedia.org/w/load.php?lang=en&modules=${"a.b%2C".repeat(200)}&skin=vector`;

		const out = renderRequests([request({ url: long })]);

		expect(out).toContain("https://en.wikipedia.org/w/load.php");
		expect(out.length).toBeLessThan(long.length);
	});

	it("owns up when it shortened something", () => {
		// The listing cites its records when lines were cut. Cutting
		// the inside of a line is the same loss and did not count, so
		// a page with three requests and one enormous url fitted the
		// budget, cited nothing, and dropped the middle of that url
		// with no way to read it back.
		const long = `https://example.test/x?${"q=1&".repeat(80)}`;

		expect(anyUrlShortened([request({ url: long })])).toBe(true);
		expect(anyUrlShortened([request()])).toBe(false);
	});

	it("counts a redirect hop it had to shorten", () => {
		const long = `https://example.test/y?${"q=1&".repeat(80)}`;

		expect(
			anyUrlShortened([request({ redirects: [{ status: 302, url: long }] })]),
		).toBe(true);
	});

	it("leaves an ordinary url exactly as it was", () => {
		const out = renderRequests([
			request({ url: "https://example.test/a/b?c=1" }),
		]);

		expect(out).toContain("https://example.test/a/b?c=1");
	});

	it("tells an unmatched filter apart from a silent page", () => {
		// Asked for failures on a page that made eighty requests and
		// had none, the answer used to be "the page has not requested
		// anything", which reads as broken telemetry rather than as
		// good news.
		expect(renderRequests([], { filter: "failed", recorded: 80 })).toBe(
			"Nothing matched 'failed', out of 80 requests recorded.",
		);
	});

	it("still says the page was silent when it truly was", () => {
		expect(renderRequests([], { filter: "failed", recorded: 0 })).toBe(
			"The page has not requested anything.",
		);
	});

	it("says nothing was requested rather than printing an empty list", () => {
		expect(renderRequests([])).toBe("The page has not requested anything.");
	});

	it("leads with a tally of what happened", () => {
		const out = renderRequests([
			request({ id: "A" }),
			request({ id: "B", status: 404 }),
			request({ id: "C", state: "failed", failure: "net::ERR_FAILED" }),
		]);
		expect(out.split("\n")[0]).toContain("3 requests");
	});

	it("counts what was transferred, so the weight of a page is visible", () => {
		const out = renderRequests([
			request({ id: "A", transferredBytes: 1024 }),
			request({ id: "B", transferredBytes: 1024 }),
		]);
		expect(out).toContain("2.0 KB");
	});

	it("calls out a failure ahead of the list", () => {
		const out = renderRequests([
			request({ id: "A" }),
			request({
				id: "B",
				url: "http://localhost:8731/gone",
				state: "failed",
				failure: "net::ERR_CONNECTION_REFUSED",
			}),
		]);
		const summary = out.slice(0, out.indexOf("\n\n"));
		expect(summary).toContain("1 failed");
	});

	it("counts an error status separately from a broken request", () => {
		const out = renderRequests([
			request({ id: "A", status: 404 }),
			request({ id: "B", state: "failed", failure: "net::ERR_FAILED" }),
		]);
		expect(out).toContain("1 failed");
		expect(out).toContain("1 error status");
	});

	it("shows the method, status, timing and url of each request", () => {
		const out = renderRequests([
			request({ method: "POST", status: 201, durationMs: 45 }),
		]);
		expect(out).toContain("POST");
		expect(out).toContain("201");
		expect(out).toContain("45ms");
		expect(out).toContain("/index.html");
	});

	it("says pending rather than inventing a status for a request in flight", () => {
		const out = renderRequests([
			request({ state: "pending", status: undefined, durationMs: undefined }),
		]);
		expect(out).toContain("pending");
	});

	it("gives the failure reason where the status would be", () => {
		const out = renderRequests([
			request({
				state: "failed",
				status: undefined,
				failure: "net::ERR_CONNECTION_REFUSED",
			}),
		]);
		expect(out).toContain("net::ERR_CONNECTION_REFUSED");
	});

	it("shows a redirect chain, since a hop explains the url that arrived", () => {
		const out = renderRequests([
			request({
				url: "http://localhost:8731/index.html",
				redirects: [
					{
						url: "http://localhost:8731/old",
						status: 302,
						location: "/index.html",
					},
				],
			}),
		]);
		expect(out).toContain("302");
		expect(out).toContain("/old");
	});

	it("numbers each request, so a body can be asked for by name", () => {
		const out = renderRequests([
			request({ id: "LONGHEXID1" }),
			request({ id: "LONGHEXID2" }),
		]);
		expect(out).toContain("#1");
		expect(out).toContain("#2");
		// The protocol's own id is noise for a reader; the ordinal
		// is what they can actually type back.
		expect(out).not.toContain("LONGHEXID1");
	});

	it("notes a cached reply, which explains a suspiciously fast request", () => {
		const out = renderRequests([request({ fromCache: true })]);
		expect(out).toContain("cached");
	});
});
