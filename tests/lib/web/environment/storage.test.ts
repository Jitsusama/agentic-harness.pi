/**
 * Reading back what a page has kept.
 */

import { describe, expect, it } from "vitest";
import { renderStorage } from "../../../../lib/web/environment/storage.js";

describe("renderStorage", () => {
	it("says nothing was asked for rather than printing blank sections", () => {
		expect(renderStorage({})).toBe("Nothing was asked for.");
	});

	it("tells an empty store from one that was never read", () => {
		expect(renderStorage({ local: [] })).toBe("local storage: empty");
	});

	it("lists what is stored", () => {
		const out = renderStorage({
			local: [
				["a", "1"],
				["b", "two"],
			],
		});
		expect(out).toContain("2 entries");
		expect(out).toContain("a = 1");
		expect(out).toContain("b = two");
	});

	it("counts one entry in the singular", () => {
		expect(renderStorage({ session: [["s", "sess"]] })).toContain("1 entry");
	});

	it("notes the flags that change what a cookie is for", () => {
		const out = renderStorage({
			cookies: [
				{
					name: "sid",
					value: "abc",
					httpOnly: true,
					secure: true,
					sameSite: "Lax",
				},
			],
		});
		expect(out).toContain("httpOnly");
		expect(out).toContain("secure");
		expect(out).toContain("sameSite=Lax");
	});

	it("calls a cookie with no expiry a session cookie", () => {
		// The protocol reports "no expiry" as -1 rather than by
		// leaving the field out.
		const out = renderStorage({
			cookies: [{ name: "sid", value: "abc", expires: -1 }],
		});
		expect(out).toContain("session");
	});

	it("cuts a long value and says it did", () => {
		const out = renderStorage({ local: [["big", "x".repeat(500)]] });
		expect(out).toContain("(500 chars)");
		expect(out.length).toBeLessThan(400);
	});

	it("distinguishes an empty clipboard from an unread one", () => {
		expect(renderStorage({ clipboard: "" })).toBe("clipboard: empty");
		expect(renderStorage({})).not.toContain("clipboard");
	});

	it("says why a store could not be read instead of showing it empty", () => {
		const out = renderStorage({
			unavailable: { clipboard: "Chrome refused the read." },
		});
		expect(out).toContain("could not be read");
		expect(out).toContain("Chrome refused the read.");
	});
});
