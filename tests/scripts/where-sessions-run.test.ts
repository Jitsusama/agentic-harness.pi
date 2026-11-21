import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { slotOf, writeSlot } from "../../host/service/child-units.ts";
import type { SessionIdentity } from "../../host/service/protocol.ts";
import {
	childSlotsListed,
	conversationsInChildren,
	describeWhere,
	whereSessionsRun,
} from "../../scripts/where-sessions-run.ts";

const KEY = "work-attended";
const ONE = "01a1cf4a-a681-7237-bce7-2ce6dbc70547";
const TWO = "01a1ccd0-1fc8-7057-8e8c-4577817aa50d";
const FRESH = "01a1f00d-0000-7000-8000-000000000001";

function listed(sessionId: string, state: SessionIdentity["state"]) {
	return {
		sessionId,
		file: `/home/j/.pi/agent/sessions/${sessionId}.jsonl`,
		cwd: "/home/j/src/core.nix",
		state,
		since: "2026-11-21T03:16:36.192Z",
	};
}

function entry(sessionId: string) {
	return {
		sessionId,
		file: `/home/j/.pi/agent/sessions/${sessionId}.jsonl`,
		cwd: "/home/j/src/core.nix",
		attended: true,
		since: "2026-11-21T03:16:36.192Z",
	};
}

describe("where sessions run", () => {
	let folder: string;

	beforeEach(async () => {
		folder = await mkdtemp(join(tmpdir(), "where-"));
	});

	afterEach(async () => {
		await rm(folder, { recursive: true, force: true });
	});

	it("reads this host's child slots from systemctl's listing, and no other host's", () => {
		const listing = [
			`pi-conversation-${KEY}@${ONE}.service loaded active running Pi conversation`,
			`pi-conversation-work-background@${TWO}.service loaded active running Pi conversation`,
			`pi-conversation-${KEY}@not-a-slot.service loaded active running Pi conversation`,
			"",
		].join("\n");

		expect(childSlotsListed(listing, KEY)).toEqual([ONE]);
	});

	it("says an opened conversation runs in its child, whose slot is named by a fresh id", async () => {
		const slot = slotOf(folder, KEY, FRESH);
		await writeSlot(slot, entry(ONE));

		const running = await conversationsInChildren(folder, KEY, [FRESH]);
		const rows = whereSessionsRun(
			[listed(ONE, "busy"), listed(TWO, "idle")],
			running,
		);

		expect(rows.map(({ sessionId, own }) => [sessionId, own])).toEqual([
			[ONE, true],
			[TWO, false],
		]);
	});

	it("counts a slot whose file names nothing as the conversation of its own name", async () => {
		const running = await conversationsInChildren(folder, KEY, [ONE]);

		expect([...running]).toEqual([ONE]);
	});

	it("matches a conversation whatever the case of its id", () => {
		const rows = whereSessionsRun(
			[listed(ONE.toUpperCase(), "busy")],
			new Set([ONE]),
		);

		expect(rows[0]?.own, "an id listed in capitals").toBe(true);
	});

	it("says how many run in their own process, then each and where", () => {
		const lines = describeWhere(
			"attended",
			whereSessionsRun(
				[listed(ONE, "busy"), listed(TWO, "parked")],
				new Set([ONE]),
			),
		);

		expect(lines).toEqual([
			"attended: 1 of 2 conversations run in a process of their own",
			`  own process   busy    ${ONE}  /home/j/src/core.nix`,
			`  host's thread parked  ${TWO}  /home/j/src/core.nix`,
		]);
	});

	it("prints no control character a folder's name holds", () => {
		const [, line] = describeWhere("attended", [
			{ sessionId: ONE, state: "idle", cwd: "/x\u001b[2Jy", own: false },
		]);

		expect(line).toContain("/x?[2Jy");
	});

	it("says a host with nothing listed holds no conversation", () => {
		expect(describeWhere("background", [])).toEqual([
			"background: no conversations",
		]);
	});
});
