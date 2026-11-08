/**
 * The sandbox's GitHub tokens come from the broker at most once every few
 * minutes, and a machine whose broker gives none hands commands none.
 */

import { describe, expect, it } from "vitest";
import {
	ASK_EVERY_MS,
	brokerTokens,
} from "../../../lib/internal/github-broker.ts";

const TOKEN = "ghs_0123456789abcdefghijABCDEFGHIJ";

/** A broker answering `answers` in turn, counting how often it's asked. */
function broker(...answers: Array<string | Error>) {
	const asked = { count: 0 };
	const ask = () => {
		const answer = answers[Math.min(asked.count, answers.length - 1)];
		asked.count += 1;
		if (answer instanceof Error) throw answer;
		return answer ?? "";
	};
	return { ask, asked };
}

describe("the broker's tokens", () => {
	it("are the broker's answer, asked for once while it's fresh", () => {
		const { ask, asked } = broker(`${TOKEN}\n`);
		let now = 0;
		const tokens = brokerTokens(ask, () => now);
		expect(tokens()).toBe(TOKEN);
		now = ASK_EVERY_MS - 1;
		expect(tokens()).toBe(TOKEN);
		expect(asked.count).toBe(1);
	});

	it("are asked for again once the answer is a few minutes old", () => {
		const { ask, asked } = broker(TOKEN, "ghs_ANOTHERtoken0123456789");
		let now = 0;
		const tokens = brokerTokens(ask, () => now);
		tokens();
		now = ASK_EVERY_MS;
		expect(tokens()).toBe("ghs_ANOTHERtoken0123456789");
		expect(asked.count).toBe(2);
	});

	it("are none where the broker gives none, and it isn't asked again at once", () => {
		const { ask, asked } = broker(new Error("spawnSync github-broker ENOENT"));
		const tokens = brokerTokens(ask, () => 0);
		expect(tokens()).toBeUndefined();
		expect(tokens()).toBeUndefined();
		expect(asked.count).toBe(1);
	});

	it("are none when the broker answers with something other than a token", () => {
		for (const answer of [
			"",
			"ghs_short",
			`${TOKEN} extra`,
			"ghs_$(rm -rf ~)xxxxxxxxxxxxxx",
		]) {
			expect(brokerTokens(broker(answer).ask, () => 0)()).toBeUndefined();
		}
	});
});
