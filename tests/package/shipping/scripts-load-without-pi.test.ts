/**
 * The scripts, and the modules the library starts as children of their
 * own, load no pi package and no other optional peer, however far their
 * imports reach.
 *
 * A user service, the launcher and mycelium run these under plain node
 * from the harness's production install, which carries none of pi's
 * packages, since pi is only an optional peer. So a runtime import of
 * one anywhere a script's imports lead fails the script before it does
 * anything: on 11 November a restart's variables, imported from the
 * spawner, took pi with them into the session records, and every script
 * that reads those failed each minute. A type-only import is erased
 * before it runs, so it may stay.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPTS = join(ROOT, "scripts");

/** The scripts that bind pi themselves before they load what imports it. */
const BINDS_PI: Record<string, string> = {
	"pi-host.ts":
		"binds every pi import to the host's own install before loading the host",
};

/**
 * The scripts plain node runs, but for those that bind pi themselves,
 * each as an import never called. vitest's `--changed` follows a
 * literal `import()` without running it, so an edit anywhere these
 * reach runs this file under `pnpm check`. A walk by path alone is
 * never chosen, which is how the supervisor's reach of pi-tui got past
 * the gate on 25 November.
 */
const SCRIPT_MODULES: Record<string, () => Promise<unknown>> = {
	"scripts/convention-recurrence.ts": () =>
		import("../../../scripts/convention-recurrence.ts"),
	"scripts/declared-called.ts": () =>
		import("../../../scripts/declared-called.ts"),
	"scripts/fail-to-pass.ts": () => import("../../../scripts/fail-to-pass.ts"),
	"scripts/fence-preflight.ts": () =>
		import("../../../scripts/fence-preflight.ts"),
	"scripts/fence-stage.ts": () => import("../../../scripts/fence-stage.ts"),
	"scripts/host-cutover.ts": () => import("../../../scripts/host-cutover.ts"),
	"scripts/host-drain.ts": () => import("../../../scripts/host-drain.ts"),
	"scripts/host-join.ts": () => import("../../../scripts/host-join.ts"),
	"scripts/host-memory.ts": () => import("../../../scripts/host-memory.ts"),
	"scripts/host-prove.ts": () => import("../../../scripts/host-prove.ts"),
	"scripts/host-release.ts": () => import("../../../scripts/host-release.ts"),
	"scripts/host-take-up.ts": () => import("../../../scripts/host-take-up.ts"),
	"scripts/learning-sensor.ts": () =>
		import("../../../scripts/learning-sensor.ts"),
	"scripts/lint.ts": () => import("../../../scripts/lint.ts"),
	"scripts/load-check.ts": () => import("../../../scripts/load-check.ts"),
	"scripts/measure.ts": () => import("../../../scripts/measure.ts"),
	"scripts/one-call.ts": () => import("../../../scripts/one-call.ts"),
	"scripts/park-windows.ts": () => import("../../../scripts/park-windows.ts"),
	"scripts/pi-carry.ts": () => import("../../../scripts/pi-carry.ts"),
	"scripts/pi-fence.ts": () => import("../../../scripts/pi-fence.ts"),
	"scripts/pi-sweep.ts": () => import("../../../scripts/pi-sweep.ts"),
	"scripts/pi-verbs.ts": () => import("../../../scripts/pi-verbs.ts"),
	"scripts/redraw-tally.ts": () => import("../../../scripts/redraw-tally.ts"),
	"scripts/restore-file.ts": () => import("../../../scripts/restore-file.ts"),
	"scripts/spawn-decide.ts": () => import("../../../scripts/spawn-decide.ts"),
	"scripts/stamp-quest-realms.ts": () =>
		import("../../../scripts/stamp-quest-realms.ts"),
	"scripts/ts-import-specifiers.ts": () =>
		import("../../../scripts/ts-import-specifiers.ts"),
	"scripts/void-cost.ts": () => import("../../../scripts/void-cost.ts"),
	"scripts/void-owner.ts": () => import("../../../scripts/void-owner.ts"),
	"scripts/where-sessions-run.ts": () =>
		import("../../../scripts/where-sessions-run.ts"),
	"scripts/windows-elsewhere.ts": () =>
		import("../../../scripts/windows-elsewhere.ts"),
};

/**
 * The modules the library starts as children of their own, which plain
 * node runs, each as an import never called, as `SCRIPT_MODULES` are.
 */
const STARTED_MODULES: Record<string, () => Promise<unknown>> = {
	"lib/core/internal/keyring/secret-service-call.mjs": () =>
		import("../../../lib/core/internal/keyring/secret-service-call.mjs"),
	"lib/internal/priority/fetched-git.mjs": () =>
		import("../../../lib/internal/priority/fetched-git.mjs"),
	"lib/internal/priority/push-hooks.mjs": () =>
		import("../../../lib/internal/priority/push-hooks.mjs"),
	"lib/internal/quest/discovery/tree-read.mjs": () =>
		import("../../../lib/internal/quest/discovery/tree-read.mjs"),
	"lib/subagent/runpi/supervisor.mjs": () =>
		import("../../../lib/subagent/runpi/supervisor.mjs"),
	"scripts/host-join.ts": () => import("../../../scripts/host-join.ts"),
};

/** Each import's specifier, and whether the whole statement is a type's. */
const STATIC =
	/(?:^|\n)\s*(?:import|export)(\s+type)?\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
const BARE = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']/g;

/**
 * Whether `specifier` names one of the package's optional peers, which
 * its production install leaves out: pi's packages and typebox.
 */
function isOptionalPeer(specifier: string): boolean {
	return (
		specifier.startsWith("@earendil-works/") ||
		specifier === "typebox" ||
		specifier.startsWith("typebox/")
	);
}

/** The specifiers `source` loads when it runs. */
function loaded(source: string): string[] {
	return [
		...[...source.matchAll(STATIC)]
			.filter(([, typeOnly]) => typeOnly === undefined)
			.map(([, , specifier]) => specifier ?? ""),
		...[...source.matchAll(BARE)].map(([, specifier]) => specifier ?? ""),
		...[...source.matchAll(DYNAMIC)].map(([, specifier]) => specifier ?? ""),
	];
}

/**
 * Each pi package a script loads, as `file specifier (by way of ...)`,
 * following its relative imports through every file they reach.
 */
function piReached(script: string): string[] {
	const found: string[] = [];
	const cameFrom = new Map<string, string | undefined>([[script, undefined]]);
	const todo = [script];
	const way = (file: string): string => {
		const steps: string[] = [];
		for (let at: string | undefined = file; at; at = cameFrom.get(at)) {
			steps.unshift(relative(ROOT, at));
		}
		return steps.join(" -> ");
	};
	for (let file = todo.pop(); file !== undefined; file = todo.pop()) {
		for (const specifier of loaded(readFileSync(file, "utf8"))) {
			if (isOptionalPeer(specifier)) {
				found.push(`${relative(ROOT, file)} ${specifier} (${way(file)})`);
			} else if (specifier.startsWith(".")) {
				const next = join(dirname(file), specifier);
				if (!existsSync(next)) {
					// A walk that passed over what it can't find would call a
					// module clean that it never read.
					found.push(
						`${relative(ROOT, file)} ${specifier} names no file (${way(file)})`,
					);
				} else if (!cameFrom.has(next)) {
					cameFrom.set(next, file);
					todo.push(next);
				}
			}
		}
	}
	return found;
}

it("reaches no runtime import of an optional peer from any script", () => {
	const scripts = readdirSync(SCRIPTS)
		.filter((name) => /\.(?:ts|mjs)$/.test(name) && !(name in BINDS_PI))
		.map((name) => `scripts/${name}`);
	expect(
		scripts,
		"each script is in SCRIPT_MODULES, so a change it reaches runs this file",
	).toEqual(Object.keys(SCRIPT_MODULES).sort());
	expect(scripts.flatMap((path) => piReached(join(ROOT, path)))).toEqual([]);
});

/** A module the library starts on its own, named beside the one starting it. */
const STARTED =
	/\bnew URL\(\s*["'](\.{1,2}\/[^"']+\.(?:mjs|ts))["'],\s*import\.meta\.url/g;

/** The library's sources, every `.ts` and `.mjs` under `lib/`. */
function librarySources(dir = join(ROOT, "lib")): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return librarySources(path);
		return /\.(?:ts|mjs)$/.test(entry.name) ? [path] : [];
	});
}

// 25 November: every council's reviewers failed to start, since their
// supervisor, which plain node runs, reached pi-tui through the quit
// asker the session's owner imports.
it("reaches no runtime import of an optional peer from a module the library starts on its own", () => {
	const started = [
		...new Set(
			librarySources().flatMap((file) =>
				[...readFileSync(file, "utf8").matchAll(STARTED)].map(([, specifier]) =>
					relative(ROOT, join(dirname(file), specifier ?? "")),
				),
			),
		),
	].sort();
	expect(
		started,
		"each started module is in STARTED_MODULES, so a change it reaches runs this file",
	).toEqual(Object.keys(STARTED_MODULES).sort());
	expect(started.flatMap((path) => piReached(join(ROOT, path)))).toEqual([]);
});

it("tells what a module loads from what it only names for types", () => {
	const source = [
		'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
		'import { type Model } from "./model.ts";',
		'export type { Text } from "@earendil-works/pi-tui";',
		'import "./side-effect.ts";',
		'export { later } from "../later.ts";',
		'const tui = () => import("@earendil-works/pi-tui");',
	].join("\n");
	expect(loaded(source)).toEqual([
		"./model.ts",
		"../later.ts",
		"./side-effect.ts",
		"@earendil-works/pi-tui",
	]);
});
