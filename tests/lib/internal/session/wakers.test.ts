import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
	askWakers,
	isWakersAsk,
	WAKERS_ASK,
} from "../../../../lib/internal/session/wakers.ts";

describe("asking what will wake a session", () => {
	it("gathers what each listener holds for it, after what the asker knows", () => {
		const bus = new EventEmitter();
		bus.on(WAKERS_ASK, (data: unknown) => {
			if (isWakersAsk(data) && data.session === "s-a") {
				data.wakers.push("a question [1] awaiting B");
			}
		});

		expect(askWakers(bus, "s-a", ["1 background job"])).toEqual([
			"1 background job",
			"a question [1] awaiting B",
		]);
		expect(askWakers(bus, "s-b")).toEqual([]);
	});

	it("reads only a payload naming a session and a list", () => {
		expect(isWakersAsk({ session: "s", wakers: [] }), "a whole ask").toBe(true);
		expect(isWakersAsk({ session: "s" }), "an ask with no list").toBe(false);
		expect(isWakersAsk(undefined), "no payload").toBe(false);
	});
});
