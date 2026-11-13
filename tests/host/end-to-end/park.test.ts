/**
 * A hosted conversation left idle parks as plain pi does, by the
 * harness's own park-workflow and the switch naming it, and gives its
 * memory back to the host, while the host keeps it held and its window
 * open. Each wake brings back the same conversation, in place: a key
 * typed in its window, losing none of what was typed while it woke; a
 * window opening on it, as Go To does; and a mesh sender's wake, written
 * where its marker says, as the mesh writes it for plain pi.
 *
 * This file waits out the park rule's two minutes for a session the
 * switch names, and its minute between looks, once for all three
 * conversations, which is why it is long.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import {
	askWake,
	NAMED_PARK_AFTER_MS,
	readParked,
} from "../../../lib/internal/session/park.ts";
import { type Folders, folders } from "./support/folders.ts";
import {
	HOST_PI_REQUIRED,
	hostPackageDir,
	hostPiMissing,
} from "./support/host-pi.ts";
import {
	type ScreenHost,
	startScreenHost,
	type Weight,
} from "./support/screen-host.ts";
import { type Seal, seal } from "./support/seal.ts";
import { attach, type Viewer } from "./support/viewer.ts";

const packageDir = hostPackageDir();
if (!packageDir && process.env[HOST_PI_REQUIRED])
	throw new Error(hostPiMissing());

/** How long a turn or a wake may take on a loaded machine. */
const TURN_MS = 20_000;
/** park-workflow's minute between looks, as LOOK_EVERY_MS sets it. */
const LOOK_MS = 60_000;
/** How long a named conversation may take to park: its idle time, a look, and room for load. */
const PARK_MS = NAMED_PARK_AFTER_MS + LOOK_MS + 30_000;
/** How long the parking case may take, parking included. */
const PARKING_CASE_MS = PARK_MS + 60_000;
/** How long a wake case may take. */
const CASE_MS = 60_000;
const ENTER = "\r";
const ROWS = 30;
const COLUMNS = 100;
/** What a parked conversation's window says. */
const PARKED = /Parked while idle, holding no memory/;

let sealed: Seal;
let host: ScreenHost;
let work: Folders;
let parkFolder: string;
const viewers: Viewer[] = [];
/** How each conversation is woken. */
const KINDS = ["byKey", "byWindow", "byMesh"] as const;
/** The conversations, by how each is woken. */
const woken = { byKey: "", byWindow: "", byMesh: "" };
/** A conversation parked and never woken, for a host restart to leave parked. */
let resting = "";
/** Every conversation the switch names. */
const named = () => [...Object.values(woken), resting];
let awake: Weight;
/** How long each wake took, in ms, said at the end for the record. */
const took: Record<string, number> = {};

/** The words of each user message in a conversation's log, in order. */
function said(file: string): string[] {
	const words: string[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line === "") continue;
		const entry: unknown = JSON.parse(line);
		if (!isRecord(entry) || entry.type !== "message") continue;
		const { message } = entry;
		if (!isRecord(message) || message.role !== "user") continue;
		const { content } = message;
		words.push(
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map((part) =>
								isRecord(part) && typeof part.text === "string"
									? part.text
									: "",
							)
							.join("")
					: "",
		);
	}
	return words;
}

/** Every entry id in a conversation's log, which one writer never repeats. */
function entryIds(file: string): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const entry: unknown = JSON.parse(line);
			return isRecord(entry) && typeof entry.id === "string" ? entry.id : "";
		})
		.filter((id) => id !== "");
}

/** The log the host keeps a conversation in. */
async function logOf(sessionId: string): Promise<string> {
	const held = (await host.list()).find((one) => one.sessionId === sessionId);
	if (!held) throw new Error(`the host doesn't hold ${sessionId}`);
	return held.file;
}

/** How the host lists a conversation now, so a wake is proved from a park. */
async function standing(sessionId: string): Promise<string | undefined> {
	const held = (await host.list()).find((s) => s.sessionId === sessionId);
	return held?.state;
}

/** Say what a wait on the host waited for, with what the host said. */
function withHost(error: unknown): never {
	throw new Error(
		`${error instanceof Error ? error.message : String(error)}; the host said: ${host.errors()}`,
	);
}

describe.skipIf(!packageDir)(
	"a hosted conversation parked while idle (needs a pi with the host's patches: pnpm test:host)",
	() => {
		beforeAll(async () => {
			if (!packageDir) return;
			sealed = await seal();
			work = folders(sealed);
			parkFolder = join(
				sealed.env.XDG_STATE_HOME ?? "",
				"pi",
				"agentic-harness.pi",
				"park-workflow",
			);
			host = await startScreenHost(sealed, packageDir);
			for (const kind of KINDS) {
				const { sessionId } = await host.open(work.trusted(), `first ${kind}`);
				await host.idle(sessionId, TURN_MS).catch(withHost);
				woken[kind] = sessionId;
			}
			const rests = await host.open(work.trusted(), "first resting");
			await host.idle(rests.sessionId, TURN_MS).catch(withHost);
			resting = rests.sessionId;
			const onKey = await attach(host.path, woken.byKey, ROWS, COLUMNS);
			viewers.push(onKey);
			await onKey.shows("heard: first byKey", TURN_MS);
			awake = await host.weigh();
			// The switch naming each parks it after two minutes idle.
			await mkdir(parkFolder, { recursive: true });
			writeFileSync(join(parkFolder, "switch"), `${named().join("\n")}\n`);
		}, CASE_MS);
		afterAll(async () => {
			for (const viewer of viewers) await viewer.leave().catch(() => {});
			await host?.stop();
			await sealed?.dispose();
			// The record of this run, for its pull request and the parity table.
			process.stdout.write(`park proof: ${JSON.stringify(took)}\n`);
		}, CASE_MS);

		it(
			"parks each conversation the switch names, keeping its window, and lets its session go",
			async () => {
				for (const sessionId of named())
					await host.parked(sessionId, PARK_MS).catch(withHost);
				const [onKey] = viewers;
				await onKey?.shows(PARKED, TURN_MS);
				for (const sessionId of named())
					expect(
						readParked(sessionId, parkFolder),
						`${sessionId} left plain pi's marker, which the mesh wakes it by`,
					).toBeDefined();
				const parked = await host.weigh();
				// PSS is kept for the record only: it holds every page V8 hasn't
				// given back yet, and on 12 November it rose by 10 MB on a lender
				// as four sessions went. The heap is what letting them go lowers.
				took.awakeKb = awake.pss + awake.swapPss;
				took.parkedKb = parked.pss + parked.swapPss;
				took.awakeHeapKb = awake.heapKb;
				took.parkedHeapKb = parked.heapKb;
				expect(
					parked.sessions,
					"no parked conversation's session is still in the host's memory",
				).toEqual([]);
				expect(
					awake.sessions.length,
					"each conversation's session was in memory while it was awake",
				).toBeGreaterThanOrEqual(KINDS.length);
				expect(
					took.parkedHeapKb,
					`the host's heap is smaller parked (${took.parkedHeapKb} kB) than awake (${took.awakeHeapKb} kB)`,
				).toBeLessThan(took.awakeHeapKb);
			},
			PARKING_CASE_MS,
		);

		it(
			"wakes in its window at a key, losing none of what was typed as it woke",
			async () => {
				const [onKey] = viewers;
				if (!onKey) throw new Error("the parked conversation has no window");
				expect(await standing(woken.byKey), "it woke from a park").toBe(
					"parked",
				);
				const started = Date.now();
				// Typed in pieces: the first wakes it, the rest arrive as it wakes.
				for (const piece of ["typed ", "while ", "it ", "woke", ENTER])
					onKey.type(piece);
				await onKey.shows("heard: typed while it woke", TURN_MS);
				took.byKeyMs = Date.now() - started;
				const file = await logOf(woken.byKey);
				expect(
					said(file),
					"the woken conversation took the words once, after its first",
				).toEqual(["first byKey", "typed while it woke"]);
				const ids = entryIds(file);
				expect(
					new Set(ids).size,
					"one writer: no entry of its log was written twice",
				).toBe(ids.length);
				expect(
					readParked(woken.byKey, parkFolder),
					"its marker went as it woke",
				).toBeUndefined();
			},
			CASE_MS,
		);

		it(
			"wakes as a window opens on it, as Go To opens one",
			async () => {
				expect(await standing(woken.byWindow), "it woke from a park").toBe(
					"parked",
				);
				const started = Date.now();
				const onWindow = await attach(host.path, woken.byWindow, ROWS, COLUMNS);
				viewers.push(onWindow);
				await onWindow.shows("heard: first byWindow", TURN_MS);
				took.byWindowMs = Date.now() - started;
				onWindow.type(`after the window${ENTER}`);
				await onWindow.shows("heard: after the window", TURN_MS);
				expect(
					said(await logOf(woken.byWindow)),
					"the window opened on the same conversation",
				).toEqual(["first byWindow", "after the window"]);
			},
			CASE_MS,
		);

		it(
			"wakes when a mesh sender asks, as the mesh asks for plain pi",
			async () => {
				expect(await standing(woken.byMesh), "it woke from a park").toBe(
					"parked",
				);
				const started = Date.now();
				expect(
					askWake(woken.byMesh, "message-1", parkFolder),
					"the marker named where to wake it",
				).toBe(true);
				await host.idle(woken.byMesh, TURN_MS).catch(withHost);
				took.byMeshMs = Date.now() - started;
				const onMesh = await attach(host.path, woken.byMesh, ROWS, COLUMNS);
				viewers.push(onMesh);
				await onMesh.shows("heard: first byMesh", TURN_MS);
				expect(
					readParked(woken.byMesh, parkFolder),
					"its marker went as it woke",
				).toBeUndefined();
				const weighed = await host.weigh();
				expect(
					weighed.sessions,
					"each woken conversation's session is back in memory",
				).toEqual(expect.arrayContaining(Object.values(woken)));
			},
			CASE_MS,
		);

		it(
			"leaves one parked across a host restart, building nothing until a mesh sender wakes it",
			async () => {
				expect(await standing(resting), "it was parked").toBe("parked");
				expect(await host.restart(), "the host stops cleanly").toBe(0);
				if (!packageDir) throw new Error("the host's pi went missing");
				const started = Date.now();
				host = await startScreenHost(sealed, packageDir);
				took.restartedMs = Date.now() - started;
				expect(
					await standing(resting),
					"the restarted host still holds it parked",
				).toBe("parked");
				expect(
					(await host.weigh()).sessions,
					"the restart built no session for it",
				).not.toContain(resting);
				const waking = Date.now();
				expect(
					askWake(resting, "message-2", parkFolder),
					"its marker stood across the restart, naming where to wake it",
				).toBe(true);
				// Listed idle as it registers, before its session loads, so the
				// wake is done only once its session is in memory. No window is
				// attached, since attaching would wake it whatever the mesh did.
				await host.idle(resting, TURN_MS).catch(withHost);
				let sessions = (await host.weigh()).sessions;
				while (!sessions.includes(resting) && Date.now() - waking < TURN_MS)
					sessions = (await host.weigh()).sessions;
				took.restingWokenMs = Date.now() - waking;
				expect(sessions, "its session is back in memory").toContain(resting);
				expect(
					said(await logOf(resting)),
					"the same conversation woke",
				).toEqual(["first resting"]);
			},
			CASE_MS + CASE_MS,
		);
	},
);
