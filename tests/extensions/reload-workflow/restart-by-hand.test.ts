/**
 * `/harness restart`: its person asks a session to start again in place,
 * at a moment they chose, which is how an orchestrator they always
 * watch takes a new install once the extension links have moved.
 */

import { describe, expect, it } from "vitest";
import {
	RESTARTING_NOW,
	restartByHand,
} from "../../../extensions/reload-workflow/transitions.ts";
import {
	isRestartAsk,
	RESTART_ASK,
	type RestartAsk,
} from "../../../lib/internal/session/park.ts";

/** A bus whose park watch answers the restart ask as `answer` says. */
function bus(answer: (ask: RestartAsk) => void) {
	const heard: RestartAsk[] = [];
	return {
		heard,
		emit(channel: string, data: unknown) {
			if (channel !== RESTART_ASK || !isRestartAsk(data)) return;
			heard.push({ ...data });
			answer(data);
		},
	};
}

describe("/harness restart", () => {
	it("asks the park watch for a restart its person asked for, on its own log", () => {
		const events = bus((ask) => {
			ask.restarting = true;
		});

		const answer = restartByHand(events, "session-a", "/logs/a.jsonl");

		expect(events.heard, "the ask says its person asked").toEqual([
			{ session: "session-a", sessionFile: "/logs/a.jsonl", asked: true },
		]);
		expect(answer, "it says it is starting again").toEqual({
			restarting: true,
			said: RESTARTING_NOW,
		});
	});

	it("says why it can't, as the park watch said", () => {
		const events = bus((ask) => {
			ask.why = "it is in a turn";
		});

		const answer = restartByHand(events, "session-a", "/logs/a.jsonl");

		expect(answer, "the watch's reason comes back").toEqual({
			restarting: false,
			said: "Can't start again: it is in a turn.",
		});
	});

	it("says so when nothing answers, or it has no log", () => {
		const silent = bus(() => undefined);

		expect(
			restartByHand(silent, "session-a", "/logs/a.jsonl").said,
			"no park watch answered",
		).toContain("nothing here starts it again");
		expect(
			restartByHand(silent, "session-a", undefined).said,
			"a session with no log",
		).toBe("Can't start again: it has no log.");
		expect(silent.heard, "with no log, nothing is asked").toHaveLength(1);
	});
});
