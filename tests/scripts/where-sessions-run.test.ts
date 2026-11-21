import { describe, expect, it } from "vitest";
import type { SessionIdentity } from "../../host/service/protocol.ts";
import {
	describeWhere,
	whereSessionsRun,
} from "../../scripts/where-sessions-run.ts";

const KEY = "work-attended";
const ONE = "01a1cf4a-a681-7237-bce7-2ce6dbc70547";
const TWO = "01a1ccd0-1fc8-7057-8e8c-4577817aa50d";

function listed(sessionId: string, state: SessionIdentity["state"]) {
	return {
		sessionId,
		file: `/home/j/.pi/agent/sessions/${sessionId}.jsonl`,
		cwd: "/home/j/src/core.nix",
		state,
		since: "2026-11-21T03:16:36.192Z",
	};
}

describe("where sessions run", () => {
	it("says a conversation runs in a process of its own while its child's unit runs", () => {
		const rows = whereSessionsRun(
			[listed(ONE, "busy"), listed(TWO, "idle")],
			[`pi-conversation-${KEY}@${ONE}.service`],
			KEY,
		);

		expect(rows.map(({ sessionId, own }) => [sessionId, own])).toEqual([
			[ONE, true],
			[TWO, false],
		]);
	});

	it("counts no other host's child as this host's", () => {
		const rows = whereSessionsRun(
			[listed(ONE, "busy")],
			[`pi-conversation-work-background@${ONE}.service`],
			KEY,
		);

		expect(rows[0]?.own, "another host's unit").toBe(false);
	});

	it("says how many run in their own process, then each and where", () => {
		const lines = describeWhere(
			"attended",
			whereSessionsRun(
				[listed(ONE, "busy"), listed(TWO, "parked")],
				[`pi-conversation-${KEY}@${ONE}.service`],
				KEY,
			),
		);

		expect(lines).toEqual([
			"attended: 1 of 2 conversations run in a process of their own",
			`  own process   busy    ${ONE}  /home/j/src/core.nix`,
			`  host's thread parked  ${TWO}  /home/j/src/core.nix`,
		]);
	});

	it("says a host with nothing listed holds no conversation", () => {
		expect(describeWhere("background", [])).toEqual([
			"background: no conversations",
		]);
	});
});
