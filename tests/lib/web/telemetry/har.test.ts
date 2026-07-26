/**
 * HAR export. The spec's invariants are the interesting part:
 * entry.time must equal the sum of the timings that are not -1,
 * send, wait and receive are required and non-negative, and any
 * field we invent has to start with an underscore or a reader
 * is entitled to reject the file.
 */

import { describe, expect, it } from "vitest";
import { toHar } from "../../../../lib/web/telemetry/har.js";
import type { NetworkRequest } from "../../../../lib/web/telemetry/network.js";

const request = (over: Partial<NetworkRequest> = {}): NetworkRequest => ({
	id: "REQ1",
	url: "http://localhost:8731/index.html?a=1&b=two",
	method: "GET",
	resourceType: "Document",
	startedAt: 100,
	state: "complete",
	requestHeaders: { "User-Agent": "Chrome" },
	responseHeaders: { "content-type": "text/html" },
	redirects: [],
	status: 200,
	statusText: "OK",
	mimeType: "text/html",
	durationMs: 12,
	transferredBytes: 387,
	wallTimeSeconds: 1785025978.5,
	timing: {
		requestTime: 100.02,
		dnsStart: -1,
		dnsEnd: -1,
		connectStart: 0.5,
		connectEnd: 2,
		sslStart: -1,
		sslEnd: -1,
		sendStart: 2.5,
		sendEnd: 3,
		receiveHeadersEnd: 8,
	},
	...over,
});

describe("toHar", () => {
	it("declares itself a HAR 1.2 log", () => {
		const har = toHar([]);
		expect(har.log.version).toBe("1.2");
		expect(har.log.creator.name).toBeTruthy();
		expect(har.log.entries).toEqual([]);
	});

	it("writes one entry per request", () => {
		expect(
			toHar([request({ id: "A" }), request({ id: "B" })]).log.entries,
		).toHaveLength(2);
	});

	it("keeps entry.time equal to the sum of its timings, as the spec demands", () => {
		// Named fields, not a reduce over the object. Recomputing
		// with the same filter the implementation uses is an
		// identity: it held while ssl was being counted twice, and
		// would hold for any arithmetic the code chose.
		const [entry] = toHar([request()]).log.entries;
		const timings = entry?.timings;
		if (!entry || !timings) throw new Error("expected an entry");
		const positive = (value: number | undefined) =>
			value !== undefined && value >= 0 ? value : 0;

		expect(entry.time).toBeCloseTo(
			positive(timings.blocked) +
				positive(timings.dns) +
				positive(timings.connect) +
				positive(timings.send) +
				positive(timings.wait) +
				positive(timings.receive),
			5,
		);
	});

	it("does not count the TLS handshake twice", () => {
		// HAR 1.2: when ssl is present its time is also included in
		// connect, so it is excluded from the entry.time sum. The
		// fixtures elsewhere pin ssl at -1, which is why nothing
		// exercised this.
		const secure = request({
			timing: {
				requestTime: 100,
				dnsStart: 0,
				dnsEnd: 10,
				connectStart: 10,
				connectEnd: 60,
				sslStart: 20,
				sslEnd: 60,
				sendStart: 60,
				sendEnd: 62,
				receiveHeadersEnd: 90,
			},
		});
		const [entry] = toHar([secure]).log.entries;
		if (!entry) throw new Error("expected an entry");

		// connect is 50 and holds the 40 of ssl inside it, so a sum
		// that added both would overstate this entry by 40.
		expect(entry.timings.ssl).toBe(40);
		expect(entry.timings.connect).toBe(50);
		expect(entry.time).toBeLessThan(
			(entry.timings.ssl ?? 0) +
				(entry.timings.connect ?? 0) +
				(entry.timings.dns ?? 0) +
				(entry.timings.send ?? 0) +
				(entry.timings.wait ?? 0) +
				(entry.timings.receive ?? 0),
		);
	});

	it("never emits a negative send, wait or receive", () => {
		const [entry] = toHar([request()]).log.entries;
		expect(entry?.timings.send).toBeGreaterThanOrEqual(0);
		expect(entry?.timings.wait).toBeGreaterThanOrEqual(0);
		expect(entry?.timings.receive).toBeGreaterThanOrEqual(0);
	});

	it("holds the invariant for a request that failed before any timing", () => {
		const [entry] = toHar([
			request({
				state: "failed",
				status: undefined,
				timing: undefined,
				durationMs: 30,
				failure: "net::ERR_CONNECTION_REFUSED",
			}),
		]).log.entries;
		const timings = entry?.timings;
		if (!entry || !timings) throw new Error("expected an entry");
		const sum = Object.values(timings)
			.filter((value): value is number => typeof value === "number")
			.filter((value) => value >= 0)
			.reduce((total, value) => total + value, 0);
		expect(entry.time).toBeCloseTo(sum, 5);
		expect(entry.timings.send).toBeGreaterThanOrEqual(0);
	});

	it("turns headers into the name and value pairs a reader expects", () => {
		const [entry] = toHar([request()]).log.entries;
		expect(entry?.request.headers).toContainEqual({
			name: "User-Agent",
			value: "Chrome",
		});
		expect(entry?.response.headers).toContainEqual({
			name: "content-type",
			value: "text/html",
		});
	});

	it("splits the query out of the url", () => {
		const [entry] = toHar([request()]).log.entries;
		expect(entry?.request.queryString).toContainEqual({
			name: "a",
			value: "1",
		});
		expect(entry?.request.queryString).toContainEqual({
			name: "b",
			value: "two",
		});
	});

	it("stamps the start as an ISO 8601 instant", () => {
		const [entry] = toHar([request()]).log.entries;
		expect(entry?.startedDateTime).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
		);
	});

	it("carries what was posted", () => {
		const [entry] = toHar([
			request({
				method: "POST",
				postData: '{"hello":"world"}',
				requestHeaders: { "content-type": "application/json" },
			}),
		]).log.entries;
		expect(entry?.request.postData?.text).toBe('{"hello":"world"}');
		expect(entry?.request.postData?.mimeType).toBe("application/json");
	});

	it("names the redirect target, which is what redirectURL is for", () => {
		const [entry] = toHar([
			request({
				responseHeaders: { location: "/elsewhere" },
			}),
		]).log.entries;
		expect(entry?.response.redirectURL).toBe("/elsewhere");
	});

	it("leaves redirectURL empty rather than absent when there was none", () => {
		const [entry] = toHar([request()]).log.entries;
		expect(entry?.response.redirectURL).toBe("");
	});

	it("includes a body when one was captured for it", () => {
		const [entry] = toHar([request()], {
			bodies: new Map([
				["REQ1", { body: "<html></html>", base64Encoded: false }],
			]),
		}).log.entries;
		expect(entry?.response.content.text).toBe("<html></html>");
		expect(entry?.response.content.encoding).toBeUndefined();
	});

	it("declares base64 encoding when the body is binary", () => {
		const [entry] = toHar([request()], {
			bodies: new Map([["REQ1", { body: "iVBORw==", base64Encoded: true }]]),
		}).log.entries;
		expect(entry?.response.content.encoding).toBe("base64");
	});

	it("prefixes anything the spec does not define with an underscore", () => {
		const [entry] = toHar([request()]).log.entries;
		if (!entry) throw new Error("expected an entry");
		const known = new Set([
			"pageref",
			"startedDateTime",
			"time",
			"request",
			"response",
			"cache",
			"timings",
			"serverIPAddress",
			"connection",
			"comment",
		]);
		for (const key of Object.keys(entry)) {
			if (!known.has(key)) expect(key.startsWith("_")).toBe(true);
		}
	});

	it("records the server it actually reached", () => {
		const [entry] = toHar([request({ remoteAddress: "[::1]:8731" })]).log
			.entries;
		expect(entry?.serverIPAddress).toBe("[::1]:8731");
	});
});
