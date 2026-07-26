/**
 * Folding the protocol's per-request events into one record.
 *
 * Event shapes are copied from a live CDP session. The two that
 * drove the design: a redirect reuses the request id and
 * arrives as a second requestWillBeSent carrying the previous
 * response, and a 404 is a perfectly successful transaction
 * rather than a loadingFailed.
 */

import { describe, expect, it } from "vitest";
import { createNetworkRecorder } from "../../../../lib/web/telemetry/network.js";

const sent = (over: Record<string, unknown> = {}) => ({
	requestId: "REQ1",
	timestamp: 100,
	wallTime: 1785025978,
	type: "Document",
	request: {
		url: "http://localhost:8731/index.html",
		method: "GET",
		headers: { "User-Agent": "Chrome" },
	},
	initiator: { type: "other" },
	...over,
});

const received = (over: Record<string, unknown> = {}) => ({
	requestId: "REQ1",
	timestamp: 100.5,
	type: "Document",
	response: {
		url: "http://localhost:8731/index.html",
		status: 200,
		statusText: "OK",
		headers: { "content-type": "text/html", "Content-Length": "238" },
		mimeType: "text/html",
		remoteIPAddress: "[::1]",
		remotePort: 8731,
		fromDiskCache: false,
		encodedDataLength: 149,
		timing: { requestTime: 100.02, sendStart: 1, receiveHeadersEnd: 8 },
	},
	...over,
});

describe("createNetworkRecorder", () => {
	it("has nothing to report before anything is sent", () => {
		expect(createNetworkRecorder().all()).toEqual([]);
	});

	it("records a request the moment it is sent, before any reply", () => {
		const log = createNetworkRecorder();
		log.apply({ kind: "sent", event: sent() });
		const [request] = log.all();
		expect(request?.url).toBe("http://localhost:8731/index.html");
		expect(request?.method).toBe("GET");
		expect(request?.resourceType).toBe("Document");
		expect(request?.status).toBeUndefined();
		expect(request?.state).toBe("pending");
	});

	it("fills in the reply when it arrives", () => {
		const log = createNetworkRecorder();
		log.apply({ kind: "sent", event: sent() });
		log.apply({ kind: "received", event: received() });
		const [request] = log.all();
		expect(request?.status).toBe(200);
		expect(request?.statusText).toBe("OK");
		expect(request?.mimeType).toBe("text/html");
		expect(request?.responseHeaders?.["content-type"]).toBe("text/html");
	});

	it("treats a 404 as a completed transaction, not a failure", () => {
		const log = createNetworkRecorder();
		log.apply({ kind: "sent", event: sent() });
		log.apply({
			kind: "received",
			event: received({
				response: {
					...received().response,
					status: 404,
					statusText: "Not Found",
				},
			}),
		});
		log.apply({
			kind: "finished",
			event: { requestId: "REQ1", timestamp: 101, encodedDataLength: 387 },
		});
		const [request] = log.all();
		expect(request?.state).toBe("complete");
		expect(request?.status).toBe(404);
		expect(request?.failure).toBeUndefined();
	});

	it("measures how long it took, in milliseconds", () => {
		const log = createNetworkRecorder();
		log.apply({ kind: "sent", event: sent({ timestamp: 100 }) });
		log.apply({
			kind: "finished",
			event: { requestId: "REQ1", timestamp: 100.25, encodedDataLength: 387 },
		});
		expect(log.all()[0]?.durationMs).toBe(250);
	});

	it("reports what was actually transferred", () => {
		const log = createNetworkRecorder();
		log.apply({ kind: "sent", event: sent() });
		log.apply({
			kind: "finished",
			event: { requestId: "REQ1", timestamp: 101, encodedDataLength: 387 },
		});
		expect(log.all()[0]?.transferredBytes).toBe(387);
	});

	it("records why a request failed, and says so", () => {
		const log = createNetworkRecorder();
		log.apply({ kind: "sent", event: sent() });
		log.apply({
			kind: "failed",
			event: {
				requestId: "REQ1",
				timestamp: 101,
				errorText: "net::ERR_CONNECTION_REFUSED",
				canceled: false,
			},
		});
		const [request] = log.all();
		expect(request?.state).toBe("failed");
		expect(request?.failure).toBe("net::ERR_CONNECTION_REFUSED");
	});

	it("distinguishes a cancellation from a failure, since one is a choice", () => {
		const log = createNetworkRecorder();
		log.apply({ kind: "sent", event: sent() });
		log.apply({
			kind: "failed",
			event: {
				requestId: "REQ1",
				timestamp: 101,
				errorText: "net::ERR_ABORTED",
				canceled: true,
			},
		});
		expect(log.all()[0]?.state).toBe("cancelled");
	});

	it("keeps a redirect hop instead of overwriting the request it came from", () => {
		const log = createNetworkRecorder();
		log.apply({
			kind: "sent",
			event: sent({
				request: { ...sent().request, url: "http://localhost:8731/old" },
			}),
		});
		log.apply({
			kind: "sent",
			event: sent({
				request: { ...sent().request, url: "http://localhost:8731/index.html" },
				redirectResponse: {
					url: "http://localhost:8731/old",
					status: 302,
					statusText: "Found",
					headers: { location: "/index.html" },
				},
			}),
		});
		const all = log.all();
		expect(all).toHaveLength(1);
		expect(all[0]?.url).toBe("http://localhost:8731/index.html");
		expect(all[0]?.redirects).toEqual([
			{
				url: "http://localhost:8731/old",
				status: 302,
				location: "/index.html",
			},
		]);
	});

	it("keeps what was posted, so a request can be understood", () => {
		const log = createNetworkRecorder();
		log.apply({
			kind: "sent",
			event: sent({
				request: {
					url: "http://localhost:8731/api/echo",
					method: "POST",
					headers: { "content-type": "application/json" },
					postData: '{"hello":"world"}',
					hasPostData: true,
				},
			}),
		});
		expect(log.all()[0]?.postData).toBe('{"hello":"world"}');
	});

	it("notes a reply served from cache rather than the network", () => {
		const log = createNetworkRecorder();
		log.apply({ kind: "sent", event: sent() });
		log.apply({
			kind: "received",
			event: received({
				response: { ...received().response, fromDiskCache: true },
			}),
		});
		expect(log.all()[0]?.fromCache).toBe(true);
	});

	it("ignores a reply for a request it never saw start", () => {
		const log = createNetworkRecorder();
		log.apply({ kind: "received", event: received() });
		expect(log.all()).toEqual([]);
	});

	it("keeps the wall clock apart from the monotonic one", () => {
		const log = createNetworkRecorder();
		log.apply({
			kind: "sent",
			event: sent({ timestamp: 579968.68, wallTime: 1785025978.64 }),
		});
		const [record] = log.all();
		// The monotonic clock measures spans and means nothing as a
		// date; the wall clock is the only one that can say when.
		expect(record?.startedAt).toBe(579968.68);
		expect(record?.wallTimeSeconds).toBe(1785025978.64);
	});

	it("keeps requests in the order they were sent", () => {
		const log = createNetworkRecorder();
		log.apply({ kind: "sent", event: sent({ requestId: "A" }) });
		log.apply({ kind: "sent", event: sent({ requestId: "B" }) });
		log.apply({ kind: "sent", event: sent({ requestId: "C" }) });
		expect(log.all().map((request) => request.id)).toEqual(["A", "B", "C"]);
	});
});
