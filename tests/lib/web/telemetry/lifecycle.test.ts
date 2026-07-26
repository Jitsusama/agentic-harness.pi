/**
 * Lifecycle. Event shapes are from a live session, including
 * the one that constrains what can honestly be said: pushState
 * and replaceState both arrive as navigationType "historyApi",
 * so the record cannot claim to know which was called.
 */

import { describe, expect, it } from "vitest";
import {
	createLifecycleRecorder,
	renderLifecycle,
} from "../../../../lib/web/telemetry/lifecycle.js";

const MAIN = "5E6572D6AA7F772EBC72974EA62B0A0B";

describe("createLifecycleRecorder", () => {
	it("starts with nothing to report", () => {
		expect(createLifecycleRecorder(MAIN).all()).toEqual([]);
	});

	it("records a full document navigation", () => {
		const log = createLifecycleRecorder(MAIN);
		log.apply({
			kind: "navigated",
			frameId: MAIN,
			url: "http://localhost:8731/spa.html",
		});
		expect(log.all()).toEqual([
			{ kind: "navigated", url: "http://localhost:8731/spa.html" },
		]);
	});

	it("ignores a subframe, which is not where the session is", () => {
		const log = createLifecycleRecorder(MAIN);
		log.apply({
			kind: "navigated",
			frameId: "SOMEIFRAME",
			url: "http://ads.example/frame.html",
		});
		expect(log.all()).toEqual([]);
	});

	it("tells an in-page route change from a real navigation", () => {
		const log = createLifecycleRecorder(MAIN);
		log.apply({
			kind: "within",
			frameId: MAIN,
			url: "http://localhost:8731/spa.html?view=details",
			navigationType: "historyApi",
		});
		const [event] = log.all();
		expect(event?.kind).toBe("routeChanged");
		expect(event?.via).toBe("historyApi");
	});

	it("keeps a fragment change apart from a history call", () => {
		const log = createLifecycleRecorder(MAIN);
		log.apply({
			kind: "within",
			frameId: MAIN,
			url: "http://localhost:8731/spa.html#section",
			navigationType: "fragment",
		});
		expect(log.all()[0]?.via).toBe("fragment");
	});

	it("attributes a navigation to the reason Chrome gave for it", () => {
		const log = createLifecycleRecorder(MAIN);
		log.apply({ kind: "requested", frameId: MAIN, reason: "reload" });
		log.apply({
			kind: "navigated",
			frameId: MAIN,
			url: "http://localhost:8731/spa.html",
		});
		expect(log.all()[0]?.reason).toBe("reload");
	});

	it("spends the reason on one navigation only", () => {
		const log = createLifecycleRecorder(MAIN);
		log.apply({ kind: "requested", frameId: MAIN, reason: "reload" });
		log.apply({ kind: "navigated", frameId: MAIN, url: "http://a/" });
		log.apply({ kind: "navigated", frameId: MAIN, url: "http://b/" });
		expect(log.all()[0]?.reason).toBe("reload");
		expect(log.all()[1]?.reason).toBeUndefined();
	});

	it("records a crash and the recovery that followed", () => {
		const log = createLifecycleRecorder(MAIN);
		log.apply({ kind: "crashed" });
		log.apply({ kind: "recovered", url: "http://localhost:8731/spa.html" });
		expect(log.all().map((event) => event.kind)).toEqual([
			"crashed",
			"recovered",
		]);
	});

	it("follows the main frame when a recovery gives the session a new one", () => {
		const log = createLifecycleRecorder(MAIN);
		log.adoptFrame("A-NEW-FRAME-ID");
		log.apply({
			kind: "navigated",
			frameId: "A-NEW-FRAME-ID",
			url: "http://a/",
		});
		expect(log.all()).toHaveLength(1);
	});
});

describe("renderLifecycle", () => {
	it("says nothing has happened rather than printing an empty list", () => {
		expect(renderLifecycle([])).toBe("The page has not navigated.");
	});

	it("reads each event in the order it happened", () => {
		const out = renderLifecycle([
			{ kind: "navigated", url: "http://a/" },
			{ kind: "routeChanged", url: "http://a/?x=1", via: "historyApi" },
		]);
		expect(out).toContain("navigated to http://a/");
		expect(out).toContain("http://a/?x=1");
	});

	it("names the history api without guessing which call was used", () => {
		const out = renderLifecycle([
			{ kind: "routeChanged", url: "http://a/?x=1", via: "historyApi" },
		]);
		// Chrome reports pushState and replaceState identically, so
		// naming either one would be an invention.
		expect(out).not.toContain("pushState");
		expect(out).not.toContain("replaceState");
	});

	it("says a crash plainly, since everything after it is suspect", () => {
		const out = renderLifecycle([
			{ kind: "crashed" },
			{ kind: "recovered", url: "http://a/" },
		]);
		expect(out).toContain("crashed");
		expect(out).toContain("recovered");
	});
});
