/**
 * Which commands start more agents: pi itself, a host of conversations
 * or a carried session; systemctl starting a host's unit; a script that
 * starts a host or moves conversations into one; `pi-packages update`;
 * or a mycelium verb that starts a session. A stop on a quest, a realm or
 * everything holds these, so a session it parks can't start more agents
 * to carry on for it. Kept apart from the other writes, since what counts
 * as a start changes with the programs that start agents, not with git.
 */

import type { WriteCall } from "./writes.ts";

/**
 * systemctl's verbs that start a unit or make it start. Stopping, killing
 * or disabling one only takes agents away, which a stop never holds back.
 */
const START_VERBS = new Set([
	"start",
	"restart",
	"try-restart",
	"reload-or-restart",
	"try-reload-or-restart",
	"enable",
	"reenable",
]);

/** systemctl's options that take a value, so it isn't read as the verb. */
const SYSTEMCTL_VALUED = new Set([
	"-H",
	"--host",
	"-M",
	"--machine",
	"-p",
	"--property",
	"-t",
	"--type",
	"--state",
	"-s",
	"--signal",
	"--kill-whom",
	"-n",
	"--lines",
	"-o",
	"--output",
	"--root",
	"--job-mode",
]);

/** The units a pi host or a hosted conversation runs as, globs included. */
const HOST_UNIT = /^(?:pi-host|pi-conversation|mycelium-pi)[-*@]|^pi-\*/;

/** The harness's scripts that start a host or move conversations into one. */
const HOST_SCRIPT =
	/(?:^|\/)(?:host-(?:cutover|drain|release|take-up|join)|pi-host|pi-carry)\.ts$/;

/** Programs that start pi, a host of conversations, or a carried session. */
const PI_PROGRAMS = new Set(["pi", "pi-host", "pi-carry"]);

/** What a pi program is asked that starts nothing. */
const PI_ASKS = new Set(["--version", "-v", "--help", "-h"]);

/** Programs that run a script named after their options. */
const RUNNERS = new Set(["node", "tsx", "bun", "deno"]);

/**
 * mycelium's verbs that start a session: carrying a quest's sessions to
 * another machine, starting a program held there, or sprouting one.
 */
const MYCELIUM_STARTS = new Set(["carry", "start", "sprout"]);

/**
 * A command that starts agents: pi itself, a host or a carried session;
 * systemctl starting or restarting a host's unit; a script that starts a
 * host or moves conversations, run as the program; or `pi-packages
 * update`, which restarts every host onto the install it moves; or a
 * mycelium verb that starts a session. A script only named, as `cat` or
 * `git diff` name one, starts nothing.
 */
export function startIn(name: string, args: string[]): WriteCall | undefined {
	if (name === "systemctl") return unitStart(args);
	if (name === "mycelium") return myceliumStart(args);
	if (name === "pi-packages" && args.includes("update")) {
		return { action: "pi-packages update", kind: "start" };
	}
	if (PI_PROGRAMS.has(name)) {
		if (args.length > 0 && args.every((word) => PI_ASKS.has(word))) {
			return undefined;
		}
		return { action: name, kind: "start" };
	}
	const script = RUNNERS.has(name) ? scriptRun(args) : name;
	if (script === undefined || !HOST_SCRIPT.test(script)) return undefined;
	const moves = script.split("/").at(-1)?.replace(/\.ts$/, "") ?? script;
	return { action: `pi ${moves}`, kind: "start" };
}

/**
 * The script a runner runs: its first word named as a script, so an
 * option's value (`--env-file x`) isn't taken for it.
 */
function scriptRun(args: string[]): string | undefined {
	return args.find(
		(word) => !word.startsWith("-") && /\.[cm]?[jt]s$/.test(word),
	);
}

/** `mycelium [--realm name] <verb>` starting a session somewhere. */
function myceliumStart(args: string[]): WriteCall | undefined {
	const words = args.filter(
		(word, at) => !word.startsWith("-") && args[at - 1] !== "--realm",
	);
	const verb = words[0];
	if (verb === undefined || !MYCELIUM_STARTS.has(verb)) return undefined;
	return { action: `mycelium ${verb}`, kind: "start" };
}

/** `systemctl [options] <verb> <unit...>` starting a host's unit. */
function unitStart(args: string[]): WriteCall | undefined {
	const found: string[] = [];
	for (let at = 0; at < args.length; at += 1) {
		const word = args[at] ?? "";
		if (SYSTEMCTL_VALUED.has(word)) at += 1;
		else if (!word.startsWith("-")) found.push(word);
	}
	const [verb, ...units] = found;
	if (verb === undefined || !START_VERBS.has(verb)) return undefined;
	if (!units.some((unit) => HOST_UNIT.test(unit))) return undefined;
	return { action: `pi host ${verb}`, kind: "start" };
}
