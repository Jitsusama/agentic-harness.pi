/**
 * Move every live pi on this machine into the realm's host, keeping its
 * session and address (host/cutover/cutover.ts): attended for sessions
 * Joel drives, background for builders and watchers. Each session ends
 * itself once it is free and the host adopts its log; busy ones follow
 * as they go quiet. Node runs it as it stands, stripping the types:
 *
 *   node scripts/host-cutover.ts [--dry-run] [--only ADDR,...]
 *     [--attended ADDR,...] [--background ADDR,...] [--deadline MINUTES]
 *     [--install FOLDER] [--quiet-mycelium PATH,...] [--while-away]
 *
 * --dry-run prints where each session would go and why, and moves
 * nothing. --only moves just the sessions it names, by address or
 * session id, as a drill wants. --attended and --background name
 * sessions the log's rule
 * gets wrong. --deadline is how long to wait for busy sessions, 45
 * minutes unless said; run it again for those still held. --install
 * names the harness install a parked pi wakes on, when run from a tree;
 * without one, a parked pi moves only if its presence says it knows how.
 * --quiet-mycelium vouches for mycelium executables that carry #121, as
 * the system's does once a switch brings core's pin; any other holder's
 * move says its window may show a Parked line for a moment.
 *
 * A session whose window is on the workspace Joel has focused, or can't
 * be placed, is left, as planned and again just before it is told.
 * --while-away lets one on his workspace move while
 * $XDG_RUNTIME_DIR/someone-at-the-machine, the mark swayidle-away keeps
 * while he is there, is absent, read at the plan and before each tell;
 * the move keeps its window in place.
 * Exits 0 when every session told to move was adopted and every name
 * --only gave goes by a live pi, 1 otherwise, a session left untold
 * included.
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	carryOut,
	goesBy,
	type MoveStep,
	planCutover,
	stepLine,
} from "../host/cutover/cutover.ts";
import { type CutoverPlaces, machineFacts } from "../host/cutover/machine.ts";
import { hostRealm } from "../host/service/address.ts";
import { installOfVersion } from "../lib/internal/reload/loaded.ts";

const DEFAULT_DEADLINE_MINUTES = 45;
const MINUTE_MS = 60_000;

const { values } = parseArgs({
	options: {
		"dry-run": { type: "boolean", default: false },
		only: { type: "string" },
		attended: { type: "string", default: "" },
		background: { type: "string", default: "" },
		deadline: { type: "string", default: String(DEFAULT_DEADLINE_MINUTES) },
		install: { type: "string" },
		"quiet-mycelium": { type: "string", default: "" },
		"while-away": { type: "boolean", default: false },
	},
});

const named = (list: string) =>
	new Set(
		list
			.split(",")
			.map((one) => one.trim().toUpperCase())
			.filter((one) => one !== ""),
	);

/** The install's current version, when this runs from one or is told it. */
function current(): string | undefined {
	const folder =
		values.install ??
		installOfVersion(
			realpathSync(fileURLToPath(new URL("..", import.meta.url))),
		);
	return folder ? realpathSync(join(folder, "current")) : undefined;
}

/** Where swayidle-away keeps its mark while Joel is at the machine. */
function presenceMark(): string {
	const runtime = process.env.XDG_RUNTIME_DIR;
	if (runtime === undefined)
		throw new Error(
			"--while-away reads $XDG_RUNTIME_DIR/someone-at-the-machine, and XDG_RUNTIME_DIR isn't set",
		);
	return join(runtime, "someone-at-the-machine");
}

const version = current();
const places: CutoverPlaces = {
	...(version ? { current: version } : {}),
	realm: hostRealm(process.env),
	...(process.env.PI_SESSION_ID ? { self: process.env.PI_SESSION_ID } : {}),
	claimer: process.pid,
	quietMycelium: values["quiet-mycelium"]
		.split(",")
		.map((one) => one.trim())
		.filter((one) => one !== ""),
	...(values["while-away"] ? { presenceMark: presenceMark() } : {}),
};
const facts = machineFacts(places);
const only = values.only === undefined ? undefined : named(values.only);
const steps = await planCutover(
	facts,
	{
		attended: named(values.attended),
		background: named(values.background),
	},
	only,
);
const present = await facts.present();
const unknown = [...(only ?? [])].filter(
	(name) => !present.some((one) => goesBy(one, new Set([name]))),
);
facts.say(
	[
		`${steps.length} live pi${steps.length === 1 ? "" : "s"} on this machine:`,
		...steps.map(stepLine),
		...unknown.map((name) => `no live pi goes by ${name}`),
	].join("\n"),
);
if (unknown.length > 0) process.exitCode = 1;
const moves = steps.filter((step): step is MoveStep => step.kind === "move");
if (values["dry-run"]) {
	facts.say(`Dry run: ${moves.length} would move; nothing was told.`);
} else {
	const minutes = Number(values.deadline);
	const deadline =
		Date.now() +
		(Number.isFinite(minutes) && minutes > 0
			? minutes
			: DEFAULT_DEADLINE_MINUTES) *
			MINUTE_MS;
	const report = await carryOut(moves, facts, deadline);
	const lines = [
		`${report.moved.length} moved.`,
		...report.waiting.map(
			(one) =>
				`still waiting: ${one.address}${one.holds ? `, ${one.holds}` : ""}`,
		),
		...report.spared.map((one) => `left untold: ${one.address}, ${one.why}`),
		...report.refused.map((one) => `not adopted: ${one.address}, ${one.why}`),
		...report.takenBack.map(
			(address) => `taken back in its own window: ${address}`,
		),
		...report.places
			.filter((one) => !one.said.startsWith("kept"))
			.map((one) => `window not kept: ${one.address}, ${one.said}`),
	];
	facts.say(lines.join("\n"));
	process.exitCode =
		report.waiting.length === 0 &&
		report.refused.length === 0 &&
		report.spared.length === 0 &&
		unknown.length === 0
			? 0
			: 1;
}
