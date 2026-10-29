import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PLAN_MS,
	planFor,
	planLines,
	verdictOf,
	withPlan,
} from "../../../../lib/internal/priority/plan.ts";
import {
	type Job,
	kindOf,
	nextTurn,
	waitingInOrder,
	waitReasons,
} from "../../../../lib/internal/priority/queue.ts";

const NOW = Date.parse("2026-10-29T07:20:00Z");

/** `nix derivation show` of a NixOS test, its shape as Nix 2.34 prints it. */
const VM_TEST = JSON.stringify({
	derivations: {
		"abc-vm-test-run-disk-guard.drv": {
			builder: "/nix/store/x-bash/bin/bash",
			env: {
				name: "vm-test-run-disk-guard",
				requiredSystemFeatures: "kvm nixos-test",
			},
		},
		"def-etc.drv": { env: { name: "etc" } },
	},
	version: 4,
});

/** A disk image built in a VM, saying so only in structured attributes. */
const IN_A_VM = JSON.stringify({
	derivations: {
		"ghi-disk-image.drv": {
			env: {
				__json: JSON.stringify({
					requiredSystemFeatures: ["big-parallel", "kvm"],
				}),
			},
		},
	},
});

/** A check that runs no VM, as `formatting` printed. */
const NO_VM = JSON.stringify({
	derivations: {
		"jkl-treefmt-check.drv": { env: { name: "treefmt-check" } },
		"mno-big.drv": { env: { requiredSystemFeatures: "big-parallel" } },
	},
});

function job(over: Partial<Job> = {}): Job {
	return {
		id: "a",
		kind: "build",
		what: "nix build .#checks.x86_64-linux.disk-guard",
		owner: { session: "s", pid: 1 },
		since: new Date(NOW - 5_000).toISOString(),
		cappable: true,
		planning: true,
		...over,
	};
}

describe("which calls are planned", () => {
	it("plans one build of checks named in full, past its log and wrappers", () => {
		expect(
			planFor(
				"timeout 900 direnv exec . nix build --no-link -L --print-out-paths .#checks.x86_64-linux.vm-x > $L/x.log 2>&1",
			),
		).toEqual({ cds: [], args: "--no-link -L .#checks.x86_64-linux.vm-x" });
	});

	it("repeats the directory the call builds from, and leaves braces to the shell", () => {
		expect(
			planFor(
				"cd ~/src/core.nix && nix build .#checks.x86_64-linux.{formatting,vm-x}",
			),
		).toEqual({
			cds: ["~/src/core.nix"],
			args: ".#checks.x86_64-linux.{formatting,vm-x}",
		});
	});

	it("leaves to what was learned what its text can't say before it runs", () => {
		for (const command of [
			'for c in vm-a vm-b; do nix build ".#checks.x86_64-linux.$c"; done',
			"nix build --no-link $(for n in a b; do echo .#checks.x86_64-linux.$n; done)",
			"nix flake check --keep-going",
			"nix build .#checks.x86_64-linux.a && nix build .#checks.x86_64-linux.b",
			"git pull && nix build .#checks.x86_64-linux.a",
			"nix build .#nixosConfigurations.optimus.config.system.build.toplevel",
			"nix build --impure --expr 'import ./x.nix'",
			"nix build .#checks.x86_64-linux.a | tee log",
		]) {
			expect(planFor(command), command).toBeUndefined();
		}
	});
});

describe("what a plan says", () => {
	it("makes work that builds a NixOS test a VM check", () => {
		expect(verdictOf(VM_TEST)).toEqual({ kind: "vm-check" });
	});

	it("makes work that builds anything else in a VM one too, whatever its name", () => {
		expect(verdictOf(IN_A_VM)).toEqual({ kind: "vm-check" });
	});

	it("makes work that builds no VM, or nothing at all, a build", () => {
		expect(verdictOf(NO_VM)).toEqual({ kind: "build" });
		expect(verdictOf("cached\n")).toEqual({ kind: "build" });
	});

	it("says why when Nix couldn't, and nothing while it is still written", () => {
		expect(verdictOf("failed nix build --dry-run exited 1\n")).toEqual({
			failed: "nix build --dry-run exited 1",
		});
		expect(verdictOf("error: oops")).toEqual({ failed: "unreadable" });
		expect(verdictOf("")).toBeUndefined();
	});
});

describe("a planning job in the queue", () => {
	it("takes the kind its plan found", () => {
		const vm = withPlan(job(), VM_TEST, NOW);
		expect(vm).toMatchObject({ kind: "vm-check", planned: "vm-check" });
		expect(vm.planning).toBeUndefined();

		expect(withPlan(job({ kind: "vm-check" }), "cached", NOW)).toMatchObject({
			kind: "build",
			planned: "build",
		});
	});

	it("keeps the kind it was learned as when its plan failed, saying why", () => {
		expect(
			withPlan(job({ kind: "vm-check" }), "failed nix derivation show", NOW),
		).toMatchObject({
			kind: "vm-check",
			planned: "failed",
			planFailed: "nix derivation show",
		});
	});

	it("waits for its plan, but not past the time a plan may take", () => {
		const waiting = job();
		expect(withPlan(waiting, "", NOW)).toBe(waiting);

		const late = withPlan(waiting, "", Date.parse(waiting.since) + PLAN_MS);
		expect(late).toMatchObject({
			kind: "build",
			planned: "failed",
			planFailed: "no plan in 90 s",
		});
		expect(late.planning).toBeUndefined();
	});

	it("has no place in line and no turn while it plans, and says so", () => {
		const planning = job({
			id: "planning",
			since: new Date(NOW - 60_000).toISOString(),
		});
		const later = job({ id: "later", planning: undefined });
		const room = {
			availableGib: 40,
			memoryPressure: 0,
			vms: 0,
			cpuPressure: 1,
		};

		expect(waitingInOrder([planning, later]).map((one) => one.id)).toEqual([
			"later",
		]);
		expect(nextTurn([planning, later], room, NOW)?.id).toBe("later");
		expect(waitReasons([planning, later], room, NOW).get("planning")).toBe(
			"planning",
		);
	});
});

describe("the shell's plan", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "plan-"));
		mkdirSync(join(root, "bin"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	/** Runs the plan lines with `nix` standing in as `script`, answering the plan file. */
	function plan(script: string): { plan: string; code: number | null } {
		const nix = join(root, "bin", "nix");
		writeFileSync(nix, `#!/usr/bin/env bash\n${script}\n`);
		chmodSync(nix, 0o755);
		const lines = planLines({ cds: [], args: ".#checks.x86_64-linux.a" });
		const ran = spawnSync(
			"bash",
			["-c", [`__queue='${root}' __job='a'`, ...lines, "exit 0"].join("\n")],
			{
				env: {
					...process.env,
					PATH: `${join(root, "bin")}:${process.env.PATH}`,
				},
			},
		);
		let said = "";
		try {
			said = readFileSync(join(root, "a.plan"), "utf8");
		} catch {
			// No plan written, which the test then says.
		}
		return { plan: said, code: ran.status };
	}

	it("writes what will be built, for a plan that builds", () => {
		const { plan: said } = plan(
			[
				'if [ "$2" = --dry-run ]; then',
				"  printf 'these 2 derivations will be built:\\n  /nix/store/abc-vm-test-run-disk-guard.drv\\n  /nix/store/def-etc.drv\\n' >&2",
				"else",
				`  [ "$1 $2 $3 $4" = "derivation show /nix/store/abc-vm-test-run-disk-guard.drv /nix/store/def-etc.drv" ] && printf '%s\\n' '${VM_TEST}'`,
				"fi",
			].join("\n"),
		);
		expect(verdictOf(said)).toEqual({ kind: "vm-check" });
	});

	it("says cached when everything comes from the store or a cache", () => {
		const { plan: said } = plan(
			"printf 'these 3 paths will be fetched (1.2 MiB download):\\n  /nix/store/abc-vm-test-run-disk-guard\\n' >&2",
		);
		expect(said).toBe("cached\n");
	});

	it("says it failed when Nix does, and lets the call go on", () => {
		const { plan: said, code } = plan(
			"echo 'error: flake has no such check' >&2; exit 1",
		);
		expect(said).toBe("failed nix build --dry-run exited 1\n");
		expect(code).toBe(0);
	});
});

describe("a dry run's kind", () => {
	it("is a build, never a VM check, since it only evaluates", () => {
		expect(
			kindOf("nix build --dry-run .#checks.x86_64-linux.vm-disk-guard"),
		).toBe("build");
	});
});
