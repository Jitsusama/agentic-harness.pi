/**
 * Asking who wrote a change over the bus, the way the mesh asks the
 * review integration before a look goes on the person's list.
 */

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	answerAuthored,
	askAuthored,
} from "../../../../lib/internal/session/authored.ts";

const URL = "https://github.com/o/r/pull/1";

describe("asking who wrote a change", () => {
	it("hears what the answerer says of the URL", async () => {
		const bus = createEventBus();
		answerAuthored(bus, async (url) =>
			url === URL
				? { by: "signed-in", author: "me" }
				: { by: "other", author: "x" },
		);

		await expect(askAuthored(bus, URL)).resolves.toEqual({
			by: "signed-in",
			author: "me",
		});
	});

	it("reads unanswered when nothing answers in time", async () => {
		const bus = createEventBus();

		await expect(askAuthored(bus, URL, 10)).resolves.toEqual({
			by: "unanswered",
		});
	});

	it("reads unknown, saying why, when the answerer fails", async () => {
		const bus = createEventBus();
		answerAuthored(bus, () => Promise.reject(new Error("host down")));

		await expect(askAuthored(bus, URL)).resolves.toEqual({
			by: "unknown",
			why: "host down",
		});
	});

	it("keeps the first answer when two answer", async () => {
		const bus = createEventBus();
		answerAuthored(bus, async () => ({ by: "no-change" }));
		answerAuthored(bus, async () => ({ by: "signed-in", author: "me" }));

		await expect(askAuthored(bus, URL)).resolves.toEqual({ by: "no-change" });
	});

	it("stops answering once disposed", async () => {
		const bus = createEventBus();
		const dispose = answerAuthored(bus, async () => ({ by: "no-change" }));
		dispose();

		await expect(askAuthored(bus, URL, 10)).resolves.toEqual({
			by: "unanswered",
		});
	});
});
