/**
 * Parking a session: the switch, the marker and the wake.
 */

import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	askWake,
	clearEase,
	clearOutlivedParks,
	clearParked,
	EASE_LASTS_MS,
	EASE_SKEW_MS,
	easePath,
	heldDirectly,
	holderFiles,
	holderRecord,
	isEased,
	isParked,
	NAMED_PARK_AFTER_MS,
	noteWake,
	PARK_AFTER_MS,
	PARK_SAID_ENV,
	type Parked,
	parkAfterMs,
	parkedPath,
	parkSwitch,
	promptIn,
	readParked,
	type Stillness,
	sayParked,
	sweepWakes,
	switchOff,
	takeBackRestartPark,
	unsayParked,
	WAKES_KEPT_MS,
	wakesPath,
	whyNotPark,
	writeParked,
} from "../../../../lib/internal/session/park.ts";

let folder: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "park-"));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

const switchSays = (...lines: string[]) => {
	writeFileSync(parkSwitch(folder), `${lines.join("\n")}\n`);
	return parkSwitch(folder);
};

describe("the wakes kept", () => {
	it("sweeps away a session's wakes once it hasn't woken for a day, keeping the rest", async () => {
		const at = Date.now();
		mkdirSync(join(folder, "wakes"), { recursive: true });
		const kept = (session: string, ageMs: number) => {
			writeFileSync(wakesPath(session, folder), "[]\n");
			const when = (at - ageMs) / 1000;
			utimesSync(wakesPath(session, folder), when, when);
		};
		kept("day-old", WAKES_KEPT_MS);
		kept("younger", WAKES_KEPT_MS - 60_000);
		writeFileSync(join(folder, "wakes", "note.txt"), "");
		utimesSync(join(folder, "wakes", "note.txt"), 0, 0);
		await sweepWakes(folder, at);
		expect(existsSync(wakesPath("day-old", folder)), "a day old goes").toBe(
			false,
		);
		expect(existsSync(wakesPath("younger", folder)), "younger stays").toBe(
			true,
		);
		expect(
			existsSync(join(folder, "wakes", "note.txt")),
			"only wakes are swept",
		).toBe(true);
	});

	it("sweeps as a wake is noted", async () => {
		const at = Date.now();
		mkdirSync(join(folder, "wakes"), { recursive: true });
		writeFileSync(wakesPath("day-old", folder), "[]\n");
		const old = (at - WAKES_KEPT_MS) / 1000;
		utimesSync(wakesPath("day-old", folder), old, old);
		noteWake(
			"waking",
			{ parkedAt: new Date(at).toISOString() },
			folder,
			() => at,
		);
		await vi.waitFor(() =>
			expect(
				existsSync(wakesPath("day-old", folder)),
				"the wake swept the day-old file",
			).toBe(false),
		);
		expect(existsSync(wakesPath("waking", folder)), "its own stays").toBe(true);
	});

	// A run stepped off by its host is no park rule's churn.
	it("notes a wake that went on from a step off as such, and no other", () => {
		const at = Date.now();
		const parkedAt = new Date(at).toISOString();
		const stepped = noteWake("a", { parkedAt, goesOn: true }, folder, () => at);
		const rested = noteWake("b", { parkedAt }, folder, () => at);
		expect(
			{ stepped: stepped.goesOn, rested: rested.goesOn },
			"as each marker said",
		).toEqual({ stepped: true, rested: undefined });
	});

	it("sweeps nothing, and says nothing, where no wakes were ever kept", async () => {
		await expect(sweepWakes(folder)).resolves.toBeUndefined();
	});
});

describe("whether a session parks, and after how long", () => {
	it("never parks with no switch and nothing in the environment", () => {
		expect(parkAfterMs("s-1", {}, parkSwitch(folder))).toBeUndefined();
	});

	it("parks every session after half an hour once the switch or the environment says on", () => {
		expect(parkAfterMs("s-1", {}, switchSays("on"))).toBe(PARK_AFTER_MS);
		expect(parkAfterMs("s-1", { PI_PARK: "on" }, parkSwitch(folder))).toBe(
			PARK_AFTER_MS,
		);
	});

	it("parks the session the switch names soon, and no other", () => {
		const path = switchSays("s-1");
		expect(parkAfterMs("s-1", {}, path)).toBe(NAMED_PARK_AFTER_MS);
		expect(parkAfterMs("s-2", {}, path)).toBeUndefined();
	});

	it("never parks where the environment keeps it out", () => {
		const path = switchSays("on", "s-1");
		expect(parkAfterMs("s-1", { PI_PARK: "off" }, path)).toBeUndefined();
	});

	// 22 November: the node eases a machine that reads over by asking its
	// idle sessions to park soon, without editing the switch every session
	// shares (KP0L6A [1b7b2cd5]).
	it("says a session its ease file names is asked to ease, beside the switch, and no other", () => {
		mkdirSync(join(folder, "ease"), { recursive: true });
		writeFileSync(
			easePath("s-1", folder),
			`${JSON.stringify({ at: "2026-11-22T07:00:00Z", why: "memory" })}\n`,
		);
		expect(isEased("s-1", folder)).toBe(true);
		expect(isEased("s-2", folder)).toBe(false);
		expect(isEased("", folder), "no session, no ask").toBe(false);
		// The ask is read by the watch beside the switch's rule, never folded
		// into it: an eased session the switch leaves out still reads as
		// left out here, so a plain pi or a viewed one keeps the switch's say.
		expect(
			parkAfterMs("s-1", {}, switchSays()),
			"the switch's rule stays the switch's",
		).toBeUndefined();
	});

	it("lets an ask nobody wrote again in half an hour lapse", () => {
		mkdirSync(join(folder, "ease"), { recursive: true });
		writeFileSync(easePath("s-1", folder), "{}\n");
		const written = Date.parse("2026-11-22T07:00:00Z");
		utimesSync(easePath("s-1", folder), written / 1000, written / 1000);
		expect(isEased("s-1", folder, written + EASE_LASTS_MS), "at its end").toBe(
			true,
		);
		expect(
			isEased("s-1", folder, written + EASE_LASTS_MS + 1),
			"past its end",
		).toBe(false);
	});

	// A clock stepped back, or a copy that kept its times, dates an ask
	// ahead of now; counted, it would never lapse (#1976 F46), and kept,
	// it would count once the clock caught up (F55).
	it("counts no ask dated ahead of now past a clock's skew, and takes it back", () => {
		mkdirSync(join(folder, "ease"), { recursive: true });
		writeFileSync(easePath("s-1", folder), "{}\n");
		const written = Date.parse("2026-11-22T07:00:00Z");
		utimesSync(easePath("s-1", folder), written / 1000, written / 1000);
		expect(
			isEased("s-1", folder, written - EASE_SKEW_MS),
			"within the skew",
		).toBe(true);
		expect(
			isEased("s-1", folder, written - EASE_SKEW_MS - 1),
			"past the skew",
		).toBe(false);
		expect(
			isEased("s-1", folder, written),
			"not once the clock catches up",
		).toBe(false);
		expect(existsSync(easePath("s-1", folder)), "taken back").toBe(false);
	});

	// A link to a file written all the time would never lapse (F71).
	it("takes only a regular file as an ask, no link or folder", () => {
		mkdirSync(join(folder, "ease"), { recursive: true });
		writeFileSync(join(folder, "fresh"), "{}\n");
		symlinkSync(join(folder, "fresh"), easePath("s-1", folder));
		mkdirSync(easePath("s-2", folder));
		linkSync(join(folder, "fresh"), easePath("s-3", folder));
		expect(isEased("s-1", folder), "a link").toBe(false);
		expect(isEased("s-2", folder), "a folder").toBe(false);
		expect(isEased("s-3", folder), "a hard link").toBe(false);
	});

	it("reads and clears only a file of the session's own in the ease folder", () => {
		mkdirSync(join(folder, "ease", "a"), { recursive: true });
		writeFileSync(join(folder, "elsewhere"), "{}\n");
		// A file a session `a/b` would reach, unguarded, below the folder.
		writeFileSync(join(folder, "ease", "a", "b"), "{}\n");
		for (const session of ["../elsewhere", "..", ".", "a/b", ""]) {
			expect(isEased(session, folder), session).toBe(false);
			clearEase(session, folder);
		}
		expect(existsSync(join(folder, "elsewhere")), "nothing outside").toBe(true);
		expect(
			existsSync(join(folder, "ease", "a", "b")),
			"nothing below another's name",
		).toBe(true);
		// Pinned by the cases above; removing a folder without `recursive`
		// is refused anyway, so this alone would pin no guard (F53, F57).
		expect(existsSync(join(folder, "ease")), "nor the folder").toBe(true);
	});

	it("says the switch is off only by a line of its own", () => {
		expect(switchOff(switchSays("off"))).toBe(true);
		expect(switchOff(switchSays("on", "off", "s-1"))).toBe(true);
		expect(switchOff(switchSays("on"))).toBe(false);
		expect(switchOff(switchSays("  off  ")), "padded").toBe(true);
		expect(
			switchOff(switchSays("# off for the night", "offline")),
			"off within a line",
		).toBe(false);
		expect(switchOff(switchSays())).toBe(false);
		expect(switchOff(join(folder, "none")), "no switch").toBe(false);
	});

	// The one kill switch for asks fails shut: a switch there that this
	// account can't read may say off (#1976 F49). One rewritten in place
	// reads empty for a moment, which no read can tell from empty.
	it("takes a switch that is there but can't be read as off", () => {
		const unreadable = join(folder, "a-folder");
		mkdirSync(unreadable);
		expect(switchOff(unreadable)).toBe(true);
	});

	it("stops easing a session once its ease file is cleared, and clears none twice", () => {
		mkdirSync(join(folder, "ease"), { recursive: true });
		writeFileSync(easePath("s-1", folder), "{}\n");
		clearEase("s-1", folder);
		expect(existsSync(easePath("s-1", folder))).toBe(false);
		expect(isEased("s-1", folder)).toBe(false);
		expect(() => clearEase("s-1", folder)).not.toThrow();
	});
});

describe("a parked session's marker and wake", () => {
	const marker = (wake: string): Parked => ({
		session: "s-1",
		sessionFile: "/logs/s-1.jsonl",
		cwd: "/src",
		addresses: ["85PKB2"],
		parkedAt: "2026-11-06T16:00:00.000Z",
		pid: 4242,
		wake,
	});

	it("says it is parked until it clears its marker on starting", () => {
		expect(isParked("s-1", folder), "s-1 is not parked before its marker").toBe(
			false,
		);
		writeParked(marker(join(folder, "s-1.wake")), folder);
		expect(
			isParked("s-1", folder),
			"s-1 is parked once its marker is written",
		).toBe(true);
		expect(readParked("s-1", folder)?.sessionFile).toBe("/logs/s-1.jsonl");
		clearParked("s-1", folder);
		expect(
			isParked("s-1", folder),
			"s-1 is not parked once its marker is cleared",
		).toBe(false);
	});

	it("wakes it by writing to the file its holder watches", () => {
		const wake = join(folder, "s-1.wake");
		writeParked(marker(wake), folder);
		expect(
			askWake("s-1", "2-80ECO2-1-aaaa", folder),
			"waking the parked s-1 says it asked",
		).toBe(true);
		expect(JSON.parse(readFileSync(wake, "utf8"))).toMatchObject({
			session: "s-1",
			messageId: "2-80ECO2-1-aaaa",
		});
	});

	it("wakes nothing for a session not parked", () => {
		expect(
			askWake("s-1", "2-80ECO2-1-aaaa", folder),
			"waking s-1, which is not parked, asks nothing",
		).toBe(false);
	});
});

describe("the record its holder keeps beside the wake file", () => {
	const wake = () => join(folder, "held.wake");
	const record = (text: string) =>
		writeFileSync(join(folder, "held.json"), text);

	it("reads it, saying whether the holder runs this very process", () => {
		record(JSON.stringify({ pid: 4242, windows: [] }));

		expect(holderRecord(wake()), "what the holder says").toEqual({
			pid: 4242,
			windows: [],
		});
		expect(heldDirectly(wake(), 4242), "held directly").toBe(true);
		expect(heldDirectly(wake(), 1), "held through a shell").toBe(false);
	});

	it("reads none missing, half written or not a record", () => {
		expect(holderRecord(wake()), "missing").toBeUndefined();
		record('{"pid": 42');
		expect(holderRecord(wake()), "half written").toBeUndefined();
		record("[42]");
		expect(holderRecord(wake()), "not a record").toBeUndefined();
		expect(heldDirectly(wake(), 42), "so not held directly").toBe(false);
	});

	it("names the files a pi it runs itself writes next, and none for another", () => {
		record(JSON.stringify({ pid: 4242 }));
		const again = join(folder, "held.again");
		const env = { MYCELIUM_WAKE: wake(), MYCELIUM_AGAIN: again };

		expect(holderFiles(env, 4242)).toEqual({ wake: wake(), again });
		expect(holderFiles(env, 1), "held through a shell").toBeUndefined();
		expect(
			holderFiles({ MYCELIUM_WAKE: wake() }, 4242),
			"a holder taking no next command",
		).toBeUndefined();
	});
});

describe("saying a run parked", () => {
	const held = () => {
		writeFileSync(join(folder, "held.json"), JSON.stringify({ pid: 4242 }));
		return { MYCELIUM_WAKE: join(folder, "held.wake") };
	};
	const parked = () => join(folder, "held.parked");

	it("writes the file its holder named, run by that holder itself", () => {
		sayParked({ ...held(), MYCELIUM_PARKED: parked() }, 4242);

		expect(readFileSync(parked(), "utf8")).toBe("");
	});

	// A subagent inherits its parent's variables, and parks nothing.
	it("writes nothing for a process its holder doesn't run itself", () => {
		sayParked({ ...held(), MYCELIUM_PARKED: parked() }, 4243);

		expect(existsSync(parked())).toBe(false);
	});

	it("writes nothing where its holder names no file, and never throws", () => {
		const env = held();
		const before = readdirSync(folder);

		expect(() => sayParked(env, 4242), "none named").not.toThrow();
		expect(readdirSync(folder), "none named, none written").toEqual(before);

		mkdirSync(parked());
		expect(
			() => sayParked({ ...env, MYCELIUM_PARKED: parked() }, 4242),
			"a folder where the file should be",
		).not.toThrow();
	});

	it("takes it back for a run that stays up, quiet where nothing is there", () => {
		const env = { ...held(), MYCELIUM_PARKED: parked() };
		sayParked(env, 4242);

		unsayParked(env, 4242);

		expect(existsSync(parked()), "up, it hasn't parked").toBe(false);
		expect(() => unsayParked(env, 4242), "already gone").not.toThrow();
		expect(() => unsayParked({}, 4242), "none named").not.toThrow();
	});

	// A park that fails part-way says what it left; a restart's take-back
	// has nobody to say it to.
	it("says where its word can't be taken back, while a restart's take-back stays quiet", () => {
		const env = { ...held(), MYCELIUM_PARKED: parked() };
		mkdirSync(join(parked(), "in-the-way"), { recursive: true });

		expect(() => unsayParked(env, 4242)).toThrow();

		const restarted: NodeJS.ProcessEnv = { ...env, [PARK_SAID_ENV]: "4242" };
		expect(() => takeBackRestartPark(restarted, 4242)).not.toThrow();
		expect(restarted[PARK_SAID_ENV], "forgotten all the same").toBe(undefined);
	});

	// A subagent inherits its parent's variables: taking back the parent's
	// real mark would lose the parent's park if its exit then hung.
	it("takes back nothing for a process its holder doesn't run itself", () => {
		const env = { ...held(), MYCELIUM_PARKED: parked() };
		sayParked(env, 4242);

		unsayParked(env, 4243);

		expect(readFileSync(parked(), "utf8"), "the parent's mark stands").toBe("");
	});

	it("takes back the park a restart of this same process said, once, forgetting the restart", () => {
		const env: NodeJS.ProcessEnv = {
			...held(),
			MYCELIUM_PARKED: parked(),
			[PARK_SAID_ENV]: "4242",
		};
		sayParked(env, 4242);

		takeBackRestartPark(env, 4242);

		expect(existsSync(parked()), "up again, it hasn't parked").toBe(false);
		expect(env[PARK_SAID_ENV], "forgotten, so no later start acts on it").toBe(
			undefined,
		);
	});

	// One-writer's hand-over says a park as a session starts (F14, #1951):
	// only a restart of this process may take a mark back.
	it("keeps a park anything but a restart of this process said", () => {
		const said = { ...held(), MYCELIUM_PARKED: parked() };
		sayParked(said, 4242);

		takeBackRestartPark({ ...said }, 4242);
		expect(readFileSync(parked(), "utf8"), "no restart said it").toBe("");

		// A subagent inherits the variable from a parent that restarted.
		const inherited: NodeJS.ProcessEnv = { ...said, [PARK_SAID_ENV]: "4242" };
		takeBackRestartPark(inherited, 4243);
		expect(readFileSync(parked(), "utf8"), "another process's restart").toBe(
			"",
		);
		expect(inherited[PARK_SAID_ENV], "forgotten all the same").toBe(undefined);
	});

	// Its holder runs this process, so only the pid it names keeps the
	// mark: a holder that started it afresh after another's restart.
	it("keeps a park another pid's restart said, in a process its holder runs", () => {
		const said = { ...held(), MYCELIUM_PARKED: parked() };
		sayParked(said, 4242);

		takeBackRestartPark({ ...said, [PARK_SAID_ENV]: "4241" }, 4242);

		expect(readFileSync(parked(), "utf8"), "another pid's restart").toBe("");
	});
});

describe("a park the machine's boot outlived", () => {
	// 11-07 19:15: optimus rebooted, and all 11 markers still stood, each
	// naming a wake file whose holder the boot took.
	const parkedAt = new Date("2026-11-07T22:37:54.000Z");
	const booted = () => Date.parse("2026-11-08T00:15:37.000Z");
	const marker = (session: string): Parked => ({
		session,
		sessionFile: `/logs/${session}.jsonl`,
		cwd: "/src",
		addresses: ["5L7BXF"],
		parkedAt: parkedAt.toISOString(),
		pid: 7532,
		wake: join(folder, `${session}.wake`),
	});
	const parkBefore = (session: string) => {
		writeParked(marker(session), folder);
		utimesSync(parkedPath(session, folder), parkedAt, parkedAt);
	};

	it("is no park, so nothing writes to a wake no holder watches", () => {
		parkBefore("s-old");

		expect(
			isParked("s-old", folder, booted),
			"a park written before the boot is no park",
		).toBe(false);
		expect(readParked("s-old", folder, booted)).toBeUndefined();
		expect(
			askWake("s-old", "2-80ECO2-1-aaaa", folder, new Date(), booted),
			"waking a park the boot outlived asks nothing",
		).toBe(false);
		const wake = join(folder, "s-old.wake");
		expect(existsSync(wake), `${wake} is never written`).toBe(false);
	});

	it("still counts a park written since the boot", () => {
		writeParked(marker("s-new"), folder);

		expect(
			isParked("s-new", folder, booted),
			"a park written since the boot counts",
		).toBe(true);
	});

	it("is cleared, and only the parks the boot outlived are", () => {
		parkBefore("s-old");
		writeParked(marker("s-new"), folder);

		expect(clearOutlivedParks(folder, booted)).toEqual(["s-old"]);
		const outlived = parkedPath("s-old", folder);
		const since = parkedPath("s-new", folder);
		expect(
			existsSync(outlived),
			`${outlived}, which the boot outlived, goes`,
		).toBe(false);
		expect(existsSync(since), `${since}, written since the boot, stays`).toBe(
			true,
		);
	});

	it("is judged by nothing where the machine won't say when it booted", () => {
		parkBefore("s-old");

		expect(
			isParked("s-old", folder, () => undefined),
			"an old park counts when the boot time is unknown",
		).toBe(true);
		expect(clearOutlivedParks(folder, () => undefined)).toEqual([]);
	});
});

describe("why a session may not park now", () => {
	const still: Stillness = {
		idleMs: PARK_AFTER_MS,
		afterMs: PARK_AFTER_MS,
		agentIdle: true,
		pendingMessages: false,
		jobs: 0,
		prompting: false,
		typed: false,
		refusals: [],
	};

	it("lets a session idle past its time, with nothing out, park", () => {
		expect(whyNotPark(still)).toBeUndefined();
	});

	it("keeps it for each thing it still has out", () => {
		expect(whyNotPark({ ...still, afterMs: undefined })).toBe("parking is off");
		expect(whyNotPark({ ...still, idleMs: PARK_AFTER_MS - 1 })).toBe(
			"not idle long enough",
		);
		expect(whyNotPark({ ...still, agentIdle: false })).toBe(
			"a run is under way",
		);
		expect(whyNotPark({ ...still, pendingMessages: true })).toBe(
			"messages wait for it",
		);
		expect(whyNotPark({ ...still, jobs: 1 })).toBe("background jobs are out");
		expect(whyNotPark({ ...still, prompting: true })).toBe("a prompt is open");
		expect(whyNotPark({ ...still, typed: true })).toBe(
			"text is typed and unsent",
		);
		expect(
			whyNotPark({ ...still, refusals: ["peers wait on a hold it sent"] }),
		).toBe("peers wait on a hold it sent");
	});
});

describe("whether pi's arguments give it a prompt", () => {
	it("is words that are no flag's value, or anything after --", () => {
		expect(promptIn(["--session", "/logs/a.jsonl", "hello"]), "words").toBe(
			true,
		);
		expect(promptIn(["--", "-hello"]), "after --").toBe(true);
		expect(promptIn(["-"]), "a lone -, which reads stdin").toBe(true);
	});

	it("is not a session's or a carried flag's value, nor a lone --", () => {
		expect(
			promptIn(["--session", "/logs/a.jsonl", "--model", "opus"]),
			"flags and their values",
		).toBe(false);
		expect(
			promptIn(["--session-id", "01a1", "--thinking", "high"]),
			"a session id and a carried flag's word",
		).toBe(false);
		expect(
			promptIn(["--session=/logs/a.jsonl", "--offline"]),
			"an inline value and a bare flag",
		).toBe(false);
		expect(promptIn(["--session", "/logs/a.jsonl", "--"]), "a lone --").toBe(
			false,
		);
	});
});
