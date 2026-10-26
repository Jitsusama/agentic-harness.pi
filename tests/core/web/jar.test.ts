import type { Cookie, CookieData } from "puppeteer-core";
import { describe, expect, it } from "vitest";
import { CookieJar, cookieData } from "../../../lib/core/web/jar.ts";

const NOW_MS = 1_800_000_000_000;
const LATER_S = NOW_MS / 1000 + 3600;

function cookie(
	name: string,
	value: string,
	extra: Partial<CookieData> = {},
): CookieData {
	return { name, value, domain: ".example.com", path: "/", ...extra };
}

describe("CookieJar", () => {
	it("starts a context with what an earlier one set", () => {
		const jar = new CookieJar();

		jar.absorb([], [cookie("clearance", "ok")]);

		expect(jar.contents(NOW_MS)).toEqual([cookie("clearance", "ok")]);
	});

	it("forgets a cookie a context removed", () => {
		const jar = new CookieJar();
		jar.absorb([], [cookie("a", "1")]);

		jar.absorb(jar.contents(NOW_MS), []);

		expect(jar.contents(NOW_MS)).toEqual([]);
	});

	it("keeps a change from one context when another ends with a stale copy", () => {
		const jar = new CookieJar();
		jar.absorb([], [cookie("a", "1")]);
		const seededA = jar.contents(NOW_MS);
		const seededB = jar.contents(NOW_MS);

		jar.absorb(seededB, [cookie("a", "2")]);
		jar.absorb(seededA, [cookie("a", "1")]);

		expect(jar.contents(NOW_MS)).toEqual([cookie("a", "2")]);
	});

	it("keeps same-named cookies apart by domain and path", () => {
		const jar = new CookieJar();

		jar.absorb(
			[],
			[
				cookie("id", "x"),
				cookie("id", "y", { domain: "other.org" }),
				cookie("id", "z", { path: "/deep" }),
			],
		);

		expect(jar.contents(NOW_MS)).toHaveLength(3);
	});

	it("drops a cookie once its expiry has passed", () => {
		const jar = new CookieJar();
		jar.absorb(
			[],
			[
				cookie("gone", "1", { expires: NOW_MS / 1000 - 1 }),
				cookie("kept", "1", { expires: LATER_S }),
			],
		);

		expect(jar.contents(NOW_MS).map((c) => c.name)).toEqual(["kept"]);
	});
});

describe("cookieData", () => {
	it("leaves a session cookie without an expiry, which -1 would expire", () => {
		const session = {
			...cookie("s", "1"),
			path: "/",
			expires: -1,
			size: 2,
			secure: false,
			session: true,
		} as Cookie;

		expect(cookieData(session).expires).toBeUndefined();
	});

	it("keeps a persistent cookie's expiry", () => {
		const persistent = {
			...cookie("p", "1"),
			path: "/",
			expires: LATER_S,
			size: 2,
			secure: true,
			session: false,
		} as Cookie;

		expect(cookieData(persistent).expires).toBe(LATER_S);
	});
});
