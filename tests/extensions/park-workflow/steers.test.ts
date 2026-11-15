/**
 * Telling a session's holder, as it parks, where its steers land and
 * which wake it, so the holder wakes it as one lands.
 */

import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Parkable,
	watch,
} from "../../../extensions/park-workflow/watch.ts";
import {
	type HolderSteers,
	isParking,
	NAMED_PARK_AFTER_MS,
	PARKED_EXIT,
	PARKING,
	parkSwitch,
} from "../../../lib/internal/session/park.ts";
import { installTestHost } from "../../support/session-host.ts";

const SESSION = "01a1af3c-26bc-7b80-990f-37848859ff67";
/** The process the holder's record says it runs. */
const HELD_PID = 4242;

const STEERS: HolderSteers = {
	inboxes: ["/state/steer/85PKB2", "/state/steer/8859FF67"],
	wakes: { acts: ["close"], talk: true, resumeWithWords: true },
};

let folder: string;
let events: EventBus;
let clock: number;
let exits: number[];

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "park-steers-"));
	events = createEventBus();
	clock = 0;
	exits = [];
	writeFileSync(parkSwitch(folder), `${SESSION}\n`);
	writeFileSync(join(folder, "held.json"), JSON.stringify({ pid: HELD_PID }));
	writeFileSync(logOf(), "");
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

/** The session's log, written as pi writes it at its first answer. */
const logOf = () => join(folder, "session.jsonl");

const steersFile = () => join(folder, "held.steers");

const session = (): Parkable => ({
	hasUI: true,
	cwd: "/src/agentic-harness.pi",
	isIdle: () => true,
	hasPendingMessages: () => false,
	shutdown: () => undefined,
	ui: { getEditorText: () => "" },
	sessionManager: {
		getSessionId: () => SESSION,
		getSessionFile: () => logOf(),
	} as unknown as Parkable["sessionManager"],
});

const holder = (): NodeJS.ProcessEnv => ({
	MYCELIUM_WAKE: join(folder, "held.wake"),
	MYCELIUM_AGAIN: join(folder, "held.again"),
});

const watchingSteers = (): NodeJS.ProcessEnv => ({
	...holder(),
	MYCELIUM_STEERS: steersFile(),
});

const watching = (env: NodeJS.ProcessEnv) =>
	watch(session(), events, {
		env,
		args: [],
		pid: HELD_PID,
		switchPath: parkSwitch(folder),
		folder,
		now: () => clock,
		exitWith: (code) => exits.push(code),
		clock: false,
	});

/** The mesh filling in the parking, as mesh-workflow does. */
const meshSays = (steers: HolderSteers | undefined) =>
	events.on(PARKING, (data) => {
		if (!isParking(data)) return;
		data.addresses = ["85PKB2", "8859FF67"];
		if (steers) data.steers = steers;
	});

// 14 November: a talk to a parked session waited up to a minute for a
// running peer's look; its holder watches the inboxes it is told of.
describe("telling its holder where its steers land", () => {
	it("writes the inboxes the mesh names, and which steers wake it, as it parks", () => {
		meshSays(STEERS);
		const watched = watching(watchingSteers());
		clock = NAMED_PARK_AFTER_MS;

		expect(watched.look()).toBeUndefined();
		expect(JSON.parse(readFileSync(steersFile(), "utf8"))).toEqual(STEERS);
		expect(exits).toEqual([PARKED_EXIT]);
	});

	it("writes nothing for a holder that asks for no steers", () => {
		meshSays(STEERS);
		const watched = watching(holder());
		clock = NAMED_PARK_AFTER_MS;

		expect(watched.look()).toBeUndefined();
		expect(readdirSync(folder)).not.toContain("held.steers");
	});

	it("clears what an earlier park wrote when the mesh names no inboxes", () => {
		writeFileSync(steersFile(), JSON.stringify(STEERS));
		meshSays(undefined);
		const watched = watching(watchingSteers());
		clock = NAMED_PARK_AFTER_MS;

		expect(watched.look()).toBeUndefined();
		expect(readdirSync(folder)).not.toContain("held.steers");
	});

	it("writes nothing in a host, which watches its conversations' inboxes itself", () => {
		const host = installTestHost();
		host.host.park = () => undefined;
		meshSays(STEERS);
		try {
			const watched = watching({
				MYCELIUM_WAKE: join(folder, "conversation.wake"),
				MYCELIUM_STEERS: steersFile(),
			});
			clock = NAMED_PARK_AFTER_MS;

			expect(watched.look()).toBeUndefined();
			expect(readdirSync(folder)).not.toContain("held.steers");
		} finally {
			host.dispose();
		}
	});
});
