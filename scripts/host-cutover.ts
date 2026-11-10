/**
 * Move every live pi on this machine into the realm's host, keeping its
 * session and address (host/cutover/cutover.ts): attended for sessions
 * Joel drives, background for builders and watchers. Each session ends
 * itself once it is free and the host adopts its log; busy ones follow
 * as they go quiet. Node runs it as it stands, stripping the types:
 *
 *   node scripts/host-cutover.ts [--dry-run] [--attended ADDR,...]
 *     [--background ADDR,...] [--deadline MINUTES] [--install FOLDER]
 *
 * --dry-run prints where each session would go and why, and moves
 * nothing. --attended and --background name sessions the log's rule
 * gets wrong. --deadline is how long to wait for busy sessions, 45
 * minutes unless said; run it again for those still held. --install
 * names the harness install a parked pi wakes on, when run from a tree;
 * without one, a parked pi moves only if its presence says it knows how.
 * Exits 0 when every session told to move was adopted, 1 otherwise.
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	carryOut,
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
		attended: { type: "string", default: "" },
		background: { type: "string", default: "" },
		deadline: { type: "string", default: String(DEFAULT_DEADLINE_MINUTES) },
		install: { type: "string" },
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

const version = current();
const places: CutoverPlaces = {
	...(version ? { current: version } : {}),
	realm: hostRealm(process.env),
	...(process.env.PI_SESSION_ID ? { self: process.env.PI_SESSION_ID } : {}),
};
const facts = machineFacts(places);
const steps = await planCutover(facts, {
	attended: named(values.attended),
	background: named(values.background),
});
facts.say(
	[
		`${steps.length} live pi${steps.length === 1 ? "" : "s"} on this machine:`,
		...steps.map(stepLine),
	].join("\n"),
);
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
		...report.refused.map((one) => `not adopted: ${one.address}, ${one.why}`),
		...report.places
			.filter((one) => !one.said.startsWith("kept"))
			.map((one) => `window not kept: ${one.address}, ${one.said}`),
	];
	facts.say(lines.join("\n"));
	process.exitCode =
		report.waiting.length === 0 && report.refused.length === 0 ? 0 : 1;
}
