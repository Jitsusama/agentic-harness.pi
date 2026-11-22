/**
 * A mesh message stating why something happened as settled fact, with
 * no test behind it, is refused once with how to say it instead, and
 * goes when sent again unchanged. With no classifier to judge it, every
 * message goes as written.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNJUDGED } from "../../../extensions/mesh-workflow/delivery.ts";
import { forgetRedirects } from "../../../lib/guardian/apply.ts";
import {
	restoreSessionModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import {
	type GuardReport,
	setGuardReportSink,
} from "../../../lib/guardian/report.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import {
	fixture,
	fromElsewhere,
	peer,
	send,
	startSession,
} from "./support/mesh.ts";
import { closeNodes, node } from "./support/node.ts";

const CAUSE =
	"The builder failed because its disk filled up with old store paths.";

/**
 * A model registry whose classifier is sure a part naming a disk states
 * an untested cause, unsure of one saying tests pass, and answers any
 * other question with nothing. Once `changesAfter` parts have been
 * judged, it is sure of a part naming a cache too, as a classifier
 * asked twice can quote other parts the second time. `judged` says how
 * many parts it was asked about.
 */
function sureOfTheDisk(fails = false, changesAfter = Number.POSITIVE_INFINITY) {
	let judged = 0;
	return {
		judged: () => judged,
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
				judged += 1;
				const part = String(context.state.message);
				const untested =
					part.includes("disk") ||
					(judged > changesAfter && part.includes("cache"))
						? 0.97
						: part.includes("pass")
							? 0.6
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
	afterEach(async () => {
		await closeNodes();
		forgetRedirects();
		restoreSessionModes({});
		setGuardReportSink(undefined);
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

	it("goes when sent again unchanged, and the person is shown it was let through", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession({}, sureOfTheDisk());
		const reports: GuardReport[] = [];
		setGuardReportSink((report) => reports.push(report));

		await send(tools, "p9r1ki", "finding", CAUSE);
		expect(reports).toEqual([]);
		const again = await send(tools, "p9r1ki", "finding", CAUSE);

		expect(again).toContain("Sent as");
		expect(written()).toBe(1);
		expect(reports).toMatchObject([
			{ guard: "untested-cause", kind: "overridden" },
		]);
	});

	it("goes when sent again unchanged, though the classifier quotes other parts the second time", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession({}, sureOfTheDisk(false, 2));
		const text = `${CAUSE}\n\nThe cache missed because the store was cold.`;

		const first = await send(tools, "p9r1ki", "finding", text);
		const again = await send(tools, "p9r1ki", "finding", text);

		expect(first).not.toContain("The cache missed");
		expect(again).toContain("Sent as");
		expect(written()).toBe(1);
	});

	it("is refused again when sent unchanged with another intent", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession({}, sureOfTheDisk());

		await send(tools, "p9r1ki", "finding", CAUSE);
		const asked = await send(tools, "p9r1ki", "question", CAUSE);

		expect(asked).toContain("Not sent: This states why");
		expect(written()).toBe(0);
	});

	it("leaves a hold, and its holder's end of it by answer or replacement, unjudged", async () => {
		peer("session-p", ["P9R1KI"], []);
		const judge = sureOfTheDisk();
		const { tools } = await startSession({}, judge);
		const idOf = (said: string) => /\[([0-9a-f]{8})\]/.exec(said)?.[1];
		const mesh = tools.get("mesh_send");

		const held = await send(tools, "p9r1ki", "hold", CAUSE);
		const answered =
			(
				await mesh?.execute("call-1", {
					intent: "fyi",
					text: CAUSE,
					re: idOf(held),
					endsHold: true,
				})
			)?.content[0]?.text ?? "";
		const again = await send(tools, "p9r1ki", "hold", "rebooting again");
		const replaced =
			(
				await mesh?.execute("call-2", {
					intent: "fyi",
					text: CAUSE,
					supersedes: idOf(again),
				})
			)?.content[0]?.text ?? "";

		expect(held).toContain("Sent as");
		expect(answered).toContain("this peer's own hold");
		expect(replaced).toContain("Sent as");
		expect(judge.judged()).toBe(0);
	});

	it("leaves an end of another peer's hold unjudged once the person may confirm it", async () => {
		setSessionMode("mesh-end-hold", "redirect");
		const judge = sureOfTheDisk();
		const { tools } = await startSession({}, judge);
		const hold = fromElsewhere({ intent: "hold", text: "rebooting" });

		const ended =
			(
				await tools.get("mesh_send")?.execute("call-1", {
					intent: "fyi",
					text: CAUSE,
					re: hold.id,
					endsHold: true,
				})
			)?.content[0]?.text ?? "";

		expect(ended).toContain("ends [");
		expect(judge.judged()).toBe(0);
	});

	it("is refused again when sent unchanged as a replacement that reaches others too", async () => {
		peer("session-p", ["P9R1KI"], []);
		peer("session-q", ["Q4W2E3"], []);
		const { tools } = await startSession({}, sureOfTheDisk());
		const first = await send(tools, "q4w2e3", "fyi", "Looking at the builder.");
		const id = /\[([0-9a-f]{8})\]/.exec(first)?.[1];

		await send(tools, "p9r1ki", "finding", CAUSE);
		const replacing =
			(
				await tools.get("mesh_send")?.execute("call-1", {
					to: "p9r1ki",
					intent: "finding",
					text: CAUSE,
					supersedes: id,
				})
			)?.content[0]?.text ?? "";

		expect(id).toMatch(/^[0-9a-f]{8}$/);
		expect(replacing).toContain("Not sent: This states why");
		expect(written()).toBe(1);
	});

	it("stays a redirect when send is set to block", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession({}, sureOfTheDisk());
		setSessionMode("send", "block");

		const first = await send(tools, "p9r1ki", "finding", CAUSE);
		const again = await send(tools, "p9r1ki", "finding", CAUSE);

		expect(first).toContain("Not sent: This states why");
		expect(again).toContain("Sent as");
	});

	it("lets a cause go the first time while off, showing the person what it would have refused", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession({}, sureOfTheDisk());
		const reports: GuardReport[] = [];
		setGuardReportSink((report) => reports.push(report));
		setSessionMode("untested-cause", "off");

		const answer = await send(tools, "p9r1ki", "finding", CAUSE);

		expect(answer).toContain("Sent as");
		expect(reports).toMatchObject([{ guard: "untested-cause", kind: "waved" }]);
	});

	it("asks no classifier about a send while the mesh's classifier is switched off", async () => {
		peer("session-p", ["P9R1KI"], []);
		const judge = sureOfTheDisk();
		const { tools } = await startSession({ PI_MESH_CLASSIFIER: "off" }, judge);

		const answer = await send(tools, "p9r1ki", "finding", CAUSE);

		expect(answer).toContain("Sent as");
		expect(judge.judged()).toBe(0);
	});

	it("is refused again when sent unchanged somewhere else", async () => {
		peer("session-p", ["P9R1KI"], []);
		peer("session-q", ["Q4W2E3"], []);
		const { tools } = await startSession({}, sureOfTheDisk());

		await send(tools, "p9r1ki", "finding", CAUSE);
		const elsewhere = await send(tools, "q4w2e3", "finding", CAUSE);

		expect(elsewhere).toContain("Not sent: This states why");
		expect(written()).toBe(0);
	});

	it("leaves a send nobody would hear to the refusal that says so, judging nothing", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession({}, sureOfTheDisk());

		const unheard = await send(tools, "zz9zz9", "finding", CAUSE);
		const heard = await send(tools, "p9r1ki", "finding", CAUSE);

		expect(unheard).toContain("Not sent:");
		expect(unheard).not.toContain("This states why");
		expect(heard).toContain("Not sent: This states why");
		expect(written()).toBe(0);
	});

	it("goes when sent again unchanged, though routing picks another group the second time", async () => {
		peer("session-p", ["P9R1KI"], ["#alpha"]);
		peer("session-q", ["Q4W2E3"], ["#beta"]);
		let routed = 0;
		const routesElsewhere = {
			modelRegistry: {
				getAvailableOfType: async () => [
					{ provider: "typesafe", id: "jev-latest" },
				],
				classify: async (_model: unknown, context: { questions: object }) => {
					if ("to" in context.questions) {
						routed += 1;
						const choice = routed === 1 ? "g1" : "g2";
						return {
							stopReason: "stop",
							answers: {
								to: {
									type: "choice",
									choice,
									probabilities: { [choice]: 0.99 },
								},
							},
						};
					}
					return {
						stopReason: "stop",
						answers:
							"cause" in context.questions
								? { cause: { probabilities: { untested_cause: 0.97 } } }
								: {},
					};
				},
			},
		};
		const { tools } = await startSession({}, routesElsewhere);
		const unaddressed = async () =>
			(
				await tools
					.get("mesh_send")
					?.execute("call-1", { intent: "finding", text: CAUSE })
			)?.content[0]?.text ?? "";

		const first = await unaddressed();
		const again = await unaddressed();

		expect(first).toContain("Not sent: This states why");
		expect(routed, "routing chose twice").toBe(2);
		expect(again).toContain("Sent as");
		expect(again).toContain("#beta");
	});

	it("routes by rule when routing's classifier never answers", async () => {
		peer("session-p", ["P9R1KI"], ["#alpha"]);
		peer("session-q", ["Q4W2E3"], ["#beta"]);
		let asked = 0;
		const neverRoutes = {
			modelRegistry: {
				getAvailableOfType: async () => [
					{ provider: "typesafe", id: "jev-latest" },
				],
				// Deaf to the signal it is handed, as a classifier may be.
				classify: (_model: unknown, context: { questions: object }) => {
					if (!("to" in context.questions))
						return Promise.resolve({ stopReason: "stop", answers: {} });
					asked += 1;
					return new Promise<never>(() => undefined);
				},
			},
		};
		const { tools } = await startSession({}, neverRoutes);

		const said =
			(
				await tools
					.get("mesh_send")
					?.execute("call-1", { intent: "finding", text: "Tests pass." })
			)?.content[0]?.text ?? "";

		expect(asked, "routing asked the classifier").toBe(1);
		// The rule sends what nobody addressed to #machine, which takes holds alone.
		expect(said).toContain("#machine takes only holds");
	}, 60_000);

	it("judges nothing and routes by rule when finding the classifier never ends", async () => {
		peer("session-p", ["P9R1KI"], ["#alpha"]);
		peer("session-q", ["Q4W2E3"], ["#beta"]);
		const neverFound = {
			modelRegistry: {
				getAvailableOfType: () => new Promise<never>(() => undefined),
				classify: async () => ({ stopReason: "stop", answers: {} }),
			},
		};
		const { tools } = await startSession({}, neverFound);

		const said =
			(
				await tools
					.get("mesh_send")
					?.execute("call-1", { intent: "finding", text: CAUSE })
			)?.content[0]?.text ?? "";

		expect(said).not.toContain("This states why");
		expect(said).toContain("#machine takes only holds");
	}, 60_000);

	it("asks the classifier nothing about a send nobody would hear", async () => {
		const judge = sureOfTheDisk();
		const { tools } = await startSession({}, judge);

		await send(tools, "zz9zz9", "finding", CAUSE);

		expect(judge.judged()).toBe(0);
	});

	it("keeps a need it refused after routing once, when it goes again unchanged", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[
				{ key: "cell:7M6JKG", title: "A Web, Not a Funnel" },
				{ key: "cell:5HJZ8Z", title: "Carry a Session", repo: "mycelium" },
			],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env, sureOfTheDisk());
		const toNeed = async () =>
			(
				await tools.get("mesh_send")?.execute("call-1", {
					to: "need",
					intent: "finding",
					text: CAUSE,
					about: "carry",
				})
			)?.content[0]?.text ?? "";

		const first = await toNeed();
		const again = await toNeed();

		expect(first).toContain("Not sent: This states why");
		expect(again).toContain("Sent as");
		const needs = join(fixture.paths.mesh, "needs");
		const kept = readdirSync(needs).flatMap((day) =>
			readFileSync(join(needs, day), "utf8").trim().split("\n"),
		);
		expect(kept, "one need, kept as it went").toHaveLength(1);
	});

	it("says once in the log why it judged nothing, however many sends", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { tools, entries } = await startSession({}, sureOfTheDisk(true));

		await send(tools, "p9r1ki", "fyi", CAUSE);
		await send(tools, "p9r1ki", "fyi", `${CAUSE} Again.`);

		const said = entries.filter((entry) => entry.type === UNJUDGED);
		expect(said).toEqual([
			{
				type: UNJUDGED,
				data: {
					why: "a part went unjudged: the classifier failed: the network has gone",
				},
			},
		]);
	});

	it("is refused again once reworded but still stated as settled", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession({}, sureOfTheDisk());

		await send(tools, "p9r1ki", "finding", CAUSE);
		// The added paragraph is judged below the floor, so the refusal's
		// reason is the same as the first one's: only the text tells the
		// two apart.
		const reworded = await send(
			tools,
			"p9r1ki",
			"finding",
			`${CAUSE}\n\nMerged #12 at 4f2a, and its tests pass.`,
		);

		expect(reworded).toContain("Not sent: This states why");
		expect(written()).toBe(0);
	});

	it("lets a part the classifier is unsure of go the first time", async () => {
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
