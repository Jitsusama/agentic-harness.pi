/**
 * Delta's token for the fence comes from mint at most once a quarter
 * hour, is minted fresh when it has under two hours left, and is never
 * handed on spent, malformed or missing.
 */

import { describe, expect, it } from "vitest";
import {
	ASK_EVERY_MS,
	DELTA_HOST,
	deltaTokens,
	deltaVariables,
	expiresAt,
	FRESH_BELOW_MS,
	type MintAsk,
	mintEnvironment,
} from "../../../../lib/internal/sandbox/delta-token.ts";

const HOUR = 60 * 60_000;

/** A JWT whose claims are `claims`, its signature made up. */
function jwt(claims: unknown): string {
	const part = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "RS256" })}.${part(claims)}.c2lnbmF0dXJl`;
}

/** A token expiring `at` milliseconds after the epoch. */
function expiring(at: number): string {
	return jwt({ exp: at / 1000, sub: "the person" });
}

/** A mint answering `answers` in turn, saying whether each ask was fresh. */
function mint(...answers: Array<string | Error>) {
	const asked: boolean[] = [];
	const ask: MintAsk = (fresh) => {
		const answer = answers[Math.min(asked.length, answers.length - 1)];
		asked.push(fresh);
		if (answer instanceof Error) throw answer;
		return answer ?? "";
	};
	return { ask, asked };
}

describe("Delta's tokens from mint", () => {
	it("are mint's cached answer, asked for once a quarter hour", () => {
		const token = expiring(24 * HOUR);
		const { ask, asked } = mint(`${token}\n`);
		let now = 0;
		const tokens = deltaTokens(ask, () => now);
		expect(tokens()).toBe(token);
		now = ASK_EVERY_MS - 1;
		expect(tokens()).toBe(token);
		expect(asked).toEqual([false]);
		now = ASK_EVERY_MS;
		tokens();
		expect(asked).toEqual([false, false]);
	});

	it("are minted fresh when mint's cached one has under two hours left", () => {
		const nearlySpent = expiring(FRESH_BELOW_MS - 1);
		const fresh = expiring(24 * HOUR);
		const { ask, asked } = mint(nearlySpent, fresh);
		expect(deltaTokens(ask, () => 0)()).toBe(fresh);
		expect(asked).toEqual([false, true]);
	});

	it("are asked again before the quarter hour once the one held runs low", () => {
		const { ask, asked } = mint(
			expiring(FRESH_BELOW_MS + 60_000),
			expiring(24 * HOUR),
		);
		let now = 0;
		const tokens = deltaTokens(ask, () => now);
		tokens();
		now = 2 * 60_000;
		tokens();
		expect(asked.length).toBe(2);
	});

	it("still hand on a short-lived one when no fresh one comes, but never a spent one", () => {
		const short = expiring(HOUR);
		expect(deltaTokens(mint(short, new Error("no")).ask, () => 0)()).toBe(
			short,
		);
		const spent = expiring(HOUR);
		expect(deltaTokens(mint(spent, spent).ask, () => HOUR)()).toBeUndefined();
	});

	it("keep a short-lived one until the quarter hour when no fresh one comes, not asking on every command", () => {
		const short = expiring(HOUR);
		const { ask, asked } = mint(short, new Error("no"));
		let now = 0;
		const tokens = deltaTokens(ask, () => now);
		expect(tokens()).toBe(short);
		now = ASK_EVERY_MS - 1;
		expect(tokens()).toBe(short);
		expect(asked).toEqual([false, true]);
		now = ASK_EVERY_MS;
		tokens();
		expect(asked).toEqual([false, true, false, true]);
	});

	it("ask again once a short-lived one runs out, even before the quarter hour", () => {
		const soon = expiring(60_000);
		const { ask, asked } = mint(soon, new Error("no"));
		let now = 0;
		const tokens = deltaTokens(ask, () => now);
		expect(tokens()).toBe(soon);
		now = 60_000;
		expect(tokens()).toBeUndefined();
		expect(asked).toEqual([false, true, false, true]);
	});

	it("are none where mint gives none, and it isn't asked again at once", () => {
		const { ask, asked } = mint(new Error("spawnSync mint ENOENT"));
		const tokens = deltaTokens(ask, () => 0);
		expect(tokens()).toBeUndefined();
		expect(tokens()).toBeUndefined();
		expect(asked).toEqual([false, true]);
	});

	it("are none when mint answers with something other than a token", () => {
		for (const answer of [
			"",
			"not a token",
			"a.b",
			`${expiring(24 * HOUR)} extra`,
			"$(rm -rf ~).e30.x",
			jwt({ sub: "no expiry" }),
			jwt({ exp: "tomorrow" }),
			"bm90IGpzb24.bm90IGpzb24.bm90IGpzb24",
			jwt({ exp: 24 * 3600, pad: "x".repeat(9000) }),
		]) {
			expect(deltaTokens(mint(answer).ask, () => 0)(), answer).toBeUndefined();
		}
	});
});

describe("what mint runs with", () => {
	it("is who it runs as and where its broker listens, with a PATH of the system's folders alone", () => {
		const env = mintEnvironment(
			{
				HOME: "/home/p",
				USER: "p",
				LOGNAME: "p",
				XDG_RUNTIME_DIR: "/run/user/1000",
				PATH: "/home/p/src/repo/.direnv/bin:/usr/bin",
				WGH_TOKEN: "the person's",
				LD_PRELOAD: "/tmp/planted.so",
			},
			["/etc/profiles/per-user/p/bin", "/run/current-system/sw/bin"],
		);
		expect(env).toEqual({
			HOME: "/home/p",
			USER: "p",
			LOGNAME: "p",
			XDG_RUNTIME_DIR: "/run/user/1000",
			PATH: "/etc/profiles/per-user/p/bin:/run/current-system/sw/bin",
		});
	});
});

describe("a token's expiry", () => {
	it("is its exp claim, in milliseconds", () => {
		expect(expiresAt(jwt({ exp: 1795440000 }))).toBe(1795440000_000);
	});
});

describe("what a fenced command is handed for Delta", () => {
	it("is the token and Delta's host, or nothing", () => {
		expect(deltaVariables("t.o.k")).toEqual({
			WGH_TOKEN: "t.o.k",
			WGH_HOST: DELTA_HOST,
		});
		expect(deltaVariables(undefined)).toEqual({});
	});
});
