/**
 * A build's plan, read before its turn: what Nix will build for it, and
 * whether any of that runs a VM.
 *
 * The queue judges work by its text, and learns from earlier runs what
 * text hides. On 28 October that wasn't enough: loops and builds the
 * queue took for builds started VMs through the daemon with no VM turn,
 * up to 13 qemu against a limit of 4, while 21 VM jobs waited. Once a
 * daemon has started a qemu, nothing can make it wait: it runs in the
 * daemon's cgroup, and Nix runs a pre-build hook on the one thread that
 * serves its client, so a hook that waited would stall every build of
 * that client. So the shell asks Nix before the turn instead: a dry run
 * lists what will be built, leaving out what the store or a cache
 * already has, and a derivation that runs a VM says so in its
 * `requiredSystemFeatures` (`kvm`, and `nixos-test` for NixOS tests),
 * whatever its name.
 *
 * Only one `nix build` of checks, written out in full, is planned. A
 * loop over `$c` or anything assigned in the call can't be planned from
 * its text, and `nix flake check` would evaluate every check to learn
 * what is already known, that a flake's checks run VMs. Those keep the
 * kind the queue learned.
 */

import { heavySteps, type Job, stepsOf } from "./queue.ts";

/** How long the shell's dry run may take. */
export const DRY_RUN_S = 45;

/** How long reading the derivations it lists may take. */
export const SHOW_S = 15;

/**
 * How long past its asking a job may plan before it waits on what the
 * queue learned: past the shell's own limits, so a plan that ran goes in,
 * and a shell that never planned holds nobody back for long.
 */
export const PLAN_MS = 90_000;

/** A heavy step that is `nix build`, past `timeout` and `direnv exec`. */
const NIX_BUILD =
	/^(?:timeout\s+\d+[smh]?\s+)?(?:direnv\s+exec\s+\S+\s+)?nix\s+build\s+(.+)$/;

/** A redirection, which the dry run's own output replaces. */
const REDIRECTION = /\s*(?:\d|&)?>>?\s*(?:&\d|\S+)/g;

/**
 * What the shell would read differently before the call than in it:
 * variables (`$T` may be set by the call itself), command substitution,
 * globs, quotes and pipes, which the plan line would have to repeat
 * exactly.
 */
const UNPLANNABLE = /[$`()*?<>'"\\|&;]/;

/** A step that only changes directory, which the plan repeats. */
const CD = /^cd\s+([^\s$`;&|()'"\\]+)$/;

/** Flags a dry run can't take with it. */
const OUTPUT_FLAGS = /(?:^|\s)--print-out-paths(?=\s|$)/g;

/** What to plan for a call: where it builds from, and its build's arguments. */
export interface Planned {
	/** The directories its `cd` steps go to first, in order. */
	readonly cds: readonly string[];
	/** The arguments of its `nix build`, past the redirections. */
	readonly args: string;
}

/**
 * The plan to ask Nix for before `command` gets its turn, or nothing
 * when it can't be planned from its text: its one heavy step must be a
 * `nix build` naming checks in full, after nothing but `cd`s.
 */
export function planFor(command: string): Planned | undefined {
	const heavy = heavySteps(command);
	const only = heavy[0]?.step;
	if (heavy.length !== 1 || only === undefined) return undefined;
	const steps = stepsOf(command);
	const at = steps.indexOf(only);
	if (at < 0) return undefined;
	const cds: string[] = [];
	for (const step of steps.slice(0, at)) {
		const cd = CD.exec(step);
		if (!cd?.[1]) return undefined;
		cds.push(cd[1]);
	}
	const build = NIX_BUILD.exec(only.replace(REDIRECTION, "").trim());
	const args = build?.[1]?.replace(OUTPUT_FLAGS, "").trim();
	if (!args || UNPLANNABLE.test(args) || !/#checks\./.test(args)) {
		return undefined;
	}
	return { cds, args };
}

/**
 * The shell lines that plan a job, written into the queue's folder as
 * `<id>.plan`: `cached` when nothing is to be built, `failed <why>` when
 * Nix couldn't say, else what `nix derivation show` said of what will be
 * built. They run in the job's own shell, in jobs, before it waits, and
 * never fail the call.
 */
export function planLines(planned: Planned): string[] {
	const into = planned.cds.map((dir) => `cd ${dir} && `).join("");
	return [
		`__plan="$__queue/$__job.plan"`,
		`if __drvs=$( ( ${into}timeout ${DRY_RUN_S} nix build --dry-run ${planned.args} ) 2>&1 >/dev/null ); then`,
		`  __drvs=$(printf '%s\\n' "$__drvs" | grep -o '/nix/store/[^ ]*\\.drv')`,
		`  if [ -z "$__drvs" ]; then printf 'cached\\n' > "$__plan.planning"`,
		`  elif ! timeout ${SHOW_S} nix derivation show $__drvs > "$__plan.planning" 2>/dev/null; then printf 'failed nix derivation show\\n' > "$__plan.planning"; fi`,
		`else printf 'failed nix build --dry-run exited %s\\n' "$?" > "$__plan.planning"; fi 2>/dev/null`,
		`mv -f "$__plan.planning" "$__plan" 2>/dev/null || :`,
		"unset __plan __drvs",
	];
}

/** What a plan said: the kind it makes the job, or why it said nothing. */
export type Verdict =
	| { readonly kind: "vm-check" | "build" }
	| { readonly failed: string };

/** A derivation's system features, as a string or a structured list. */
const FEATURES =
	/requiredSystemFeatures\\?"\s*:\s*(\[[^\]]*\]|\\?"(?:[^"\\]|\\[^"])*)/g;

/** The features that mean a derivation runs a VM. */
const RUNS_A_VM = /\b(?:kvm|nixos-test)\b/;

/** What `<id>.plan` says, or nothing while it is still being written. */
export function verdictOf(text: string): Verdict | undefined {
	const said = text.trim();
	if (said === "") return undefined;
	if (said === "cached") return { kind: "build" };
	if (said.startsWith("failed")) {
		return { failed: said.slice("failed".length).trim() || "unsaid" };
	}
	if (!said.startsWith("{")) return { failed: "unreadable" };
	for (const match of said.matchAll(FEATURES)) {
		if (RUNS_A_VM.test(match[1] ?? "")) return { kind: "vm-check" };
	}
	return { kind: "build" };
}

/**
 * A planning job as its plan leaves it, by what `<id>.plan` says now: the
 * kind the plan found, or the kind it was learned as when the plan said
 * nothing, or when none came within {@link PLAN_MS}. The same job while
 * the plan is still coming.
 */
export function withPlan(job: Job, plan: string, now: number): Job {
	if (!job.planning || job.started !== undefined) return job;
	const verdict = verdictOf(plan);
	const late = now - Date.parse(job.since) >= PLAN_MS;
	if (!verdict && !late) return job;
	const { planning: _, ...rest } = job;
	if (verdict && "kind" in verdict) {
		return { ...rest, kind: verdict.kind, planned: verdict.kind };
	}
	return {
		...rest,
		planned: "failed",
		planFailed: verdict?.failed ?? `no plan in ${PLAN_MS / 1000} s`,
	};
}
