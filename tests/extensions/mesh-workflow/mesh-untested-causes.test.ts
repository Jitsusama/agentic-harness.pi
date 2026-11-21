/**
 * A mesh message stating why something happened as settled fact, with
 * no test behind it, is refused once with how to say it instead, and
 * goes when sent again unchanged. With no classifier to judge it, every
 * message goes as written.
 */

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forgetRedirects } from "../../../lib/guardian/apply.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import { fixture, peer, send, startSession } from "./support/mesh.ts";

const CAUSE =
	"The builder failed because its disk filled up with old store paths.";

/**
 * A model registry whose classifier is sure a part naming a disk states
 * an untested cause, and answers any other question with nothing.
 */
function sureOfTheDisk(fails = false) {
	return {
		modelRegistry: {
			getAvailableOfType: async () => [
				{ provider: "typesafe", id: "jev-latest" },
			],
			classify: async (
				_model: unknown,
				context: { state: { message?: unknown }; questions: object },
			) => {
				if (!("cause" in context.questions)) {
					return { stopReason: "stop", answers: {} };
				}
				if (fails) throw new Error("the network has gone");
				const untested = String(context.state.message).includes("disk")
					? 0.97
					: 0.02;
				return {
					stopReason: "stop",
					answers: {
						cause: {
							type: "choice",
							choice: untested > 0.5 ? "untested_cause" : "no_cause",
							probabilities: { untested_cause: untested },
						},
					},
				};
			},
		},
	};
}

/** How many messages the mesh holds. */
function written(): number {
	return folderTransport(join(fixture.paths.mesh, "messages")).ids().length;
}

describe("an untested cause on the mesh", () => {
	afterEach(() => {
		forgetRedirects();
	});

	it("is refused before it is written, quoting the cause and how to word it", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession({}, sureOfTheDisk());

		const answer = await send(tools, "p9r1ki", "finding", CAUSE);

		expect(answer).toContain("Not sent: This states why something happened");
		expect(answer).toContain(`> ${CAUSE}`);
		expect(answer).toContain('"on trial"');
		expect(written()).toBe(0);
	});

	it("goes when sent again unchanged", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession({}, sureOfTheDisk());

		await send(tools, "p9r1ki", "finding", CAUSE);
		const again = await send(tools, "p9r1ki", "finding", CAUSE);

		expect(again).toContain("Sent as");
		expect(written()).toBe(1);
	});

	it("is refused again once reworded but still stated as settled", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession({}, sureOfTheDisk());

		await send(tools, "p9r1ki", "finding", CAUSE);
		const reworded = await send(
			tools,
			"p9r1ki",
			"finding",
			`${CAUSE} That is all.`,
		);

		expect(reworded).toContain("Not sent:");
		expect(written()).toBe(0);
	});

	it("lets a status line go the first time", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession({}, sureOfTheDisk());

		const answer = await send(
			tools,
			"p9r1ki",
			"fyi",
			"Merged #12 at 4f2a, and the 40 tests it touches pass.",
		);

		expect(answer).toContain("Sent as");
		expect(written()).toBe(1);
	});

	it("lets every message go when the classifier fails or there is none", async () => {
		peer("session-p", ["P9R1KI"], []);
		const failing = await startSession({}, sureOfTheDisk(true));
		expect(await send(failing.tools, "p9r1ki", "finding", CAUSE)).toContain(
			"Sent as",
		);
		const none = await startSession();
		expect(await send(none.tools, "p9r1ki", "finding", CAUSE)).toContain(
			"Sent as",
		);
		expect(written()).toBe(2);
	});
});
