/**
 * The session recap. Its job is to make invisible accumulated
 * state visible, so the tests are mostly about what it refuses
 * to leave out.
 */

import { describe, expect, it } from "vitest";
import {
	renderStatus,
	type SessionStatus,
} from "../../../../lib/web/environment/status.js";

const status = (over: Partial<SessionStatus> = {}): SessionStatus => ({
	name: "default",
	url: "http://localhost:8731/index.html",
	title: "Net",
	emulation: {},
	rules: [],
	dialogPolicy: { accept: false },
	dialogsSeen: 0,
	logs: { count: 0, cursor: 0 },
	announcements: { count: 0, cursor: 0 },
	requests: { count: 0, failed: 0 },
	history: [],
	artifacts: [],
	...over,
});

describe("renderStatus", () => {
	it("names the session and where it is", () => {
		const out = renderStatus(status());
		expect(out).toContain("'default'");
		expect(out).toContain("http://localhost:8731/index.html");
	});

	it("admits a session that has not gone anywhere", () => {
		expect(renderStatus(status({ url: "", title: "" }))).toContain(
			"nowhere yet",
		);
	});

	it("gives each buffer's count and cursor, so a reader can resume", () => {
		const out = renderStatus(
			status({
				logs: { count: 21, cursor: 21 },
				announcements: { count: 3, cursor: 3 },
			}),
		);
		expect(out).toContain("21 log entries, cursor 21");
		expect(out).toContain("3 announcements, cursor 3");
	});

	it("mentions failures only when there are some", () => {
		expect(
			renderStatus(status({ requests: { count: 5, failed: 0 } })),
		).not.toContain("failed");
		expect(
			renderStatus(status({ requests: { count: 5, failed: 2 } })),
		).toContain("2 failed");
	});

	it("says what the session is pretending to be", () => {
		const out = renderStatus(
			status({
				emulation: {
					device: "iPhone 15 Pro",
					colorScheme: "dark",
					reducedMotion: true,
					vision: "deuteranopia",
				},
			}),
		);
		expect(out).toContain("iPhone 15 Pro");
		expect(out).toContain("dark mode");
		expect(out).toContain("reduced motion");
		expect(out).toContain("deuteranopia");
	});

	it("stays quiet about emulation when there is none", () => {
		expect(renderStatus(status())).not.toContain("pretending");
	});

	it("reports interception, which silently changes every reading", () => {
		const out = renderStatus(
			status({ rules: [{ pattern: "*/api/*", action: "mock", status: 503 }] }),
		);
		expect(out).toContain("intercepting");
		expect(out).toContain("mock */api/*");
	});

	it("says the network is offline, which explains everything else", () => {
		const out = renderStatus(
			status({
				throttle: { offline: true, download: 0, upload: 0, latency: 0 },
			}),
		);
		expect(out).toContain("offline");
	});

	it("surfaces a crash without being asked for the history", () => {
		const out = renderStatus(
			status({
				history: [
					{ kind: "navigated", url: "http://a/" },
					{ kind: "crashed" },
					{ kind: "recovered" },
				],
			}),
		);
		expect(out).toContain("crashed once");
	});

	it("counts repeated crashes", () => {
		const out = renderStatus(
			status({ history: [{ kind: "crashed" }, { kind: "crashed" }] }),
		);
		expect(out).toContain("2 times");
	});

	it("keeps the recent history short", () => {
		const out = renderStatus(
			status({
				history: Array.from({ length: 20 }, (_, index) => ({
					kind: "navigated" as const,
					url: `http://a/${index}`,
				})),
			}),
		);
		expect(out).toContain("http://a/19");
		expect(out).not.toContain("http://a/5");
	});

	it("lists what was written to disk, which is otherwise unfindable", () => {
		const out = renderStatus(status({ artifacts: ["/tmp/r-x/shot-01.png"] }));
		expect(out).toContain("/tmp/r-x/shot-01.png");
	});

	it("states the dialog policy, since it decides what the page did", () => {
		expect(renderStatus(status())).toContain("dismissed");
		expect(
			renderStatus(status({ dialogPolicy: { accept: true }, dialogsSeen: 2 })),
		).toContain("accepted, 2 so far");
	});
});
