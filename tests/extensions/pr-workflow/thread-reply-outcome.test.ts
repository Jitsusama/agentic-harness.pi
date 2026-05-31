import { describe, expect, it } from "vitest";
import { describeReplyOutcome } from "../../../extensions/pr-workflow/thread-reply-outcome.js";

const REPLY = { threadIndex: 2, url: "https://example/c1", body: "Done." };

describe("describeReplyOutcome", () => {
	it("reports a reply-only post when no resolve was attempted", () => {
		const out = describeReplyOutcome(REPLY, undefined);
		expect(out.text).toContain("[T2]");
		expect(out.text).toContain(REPLY.url);
		expect(out.text).not.toMatch(/resolv/i);
		expect(out.details).toMatchObject({
			ok: true,
			url: REPLY.url,
			threadIndex: 2,
			body: "Done.",
		});
		expect(out.details.resolved).toBeUndefined();
	});

	it("reports reply and resolve together when both succeed", () => {
		const out = describeReplyOutcome(REPLY, { ok: true, isResolved: true });
		expect(out.text).toMatch(/resolved/i);
		expect(out.text).toContain("[T2]");
		expect(out.details).toMatchObject({ ok: true, resolved: true });
	});

	it("keeps the reply but surfaces the resolve failure when resolve fails", () => {
		// The reply landed remotely; reporting the whole thing as a
		// failure would be a lie. ok stays true, the error is named.
		const out = describeReplyOutcome(REPLY, {
			ok: false,
			error: "GraphQL: thread already resolved",
		});
		expect(out.text).toContain(REPLY.url);
		expect(out.text).toMatch(/but resolving failed/i);
		expect(out.text).toContain("thread already resolved");
		expect(out.details).toMatchObject({
			ok: true,
			resolved: false,
			resolveError: "GraphQL: thread already resolved",
		});
	});

	it("distinguishes the three outcomes in their text", () => {
		const replyOnly = describeReplyOutcome(REPLY, undefined).text;
		const both = describeReplyOutcome(REPLY, {
			ok: true,
			isResolved: true,
		}).text;
		const partial = describeReplyOutcome(REPLY, {
			ok: false,
			error: "boom",
		}).text;
		expect(new Set([replyOnly, both, partial]).size).toBe(3);
	});
});
