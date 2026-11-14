import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CarriedShellsOptions,
	carriedShells,
	KEPT_FILE,
	type KeptCall,
	STRAY_FOR_MS,
	STRAY_LOOK_MS,
} from "../../../host/engine/carried-shells.ts";
import type { ProcessTable } from "../../../host/engine/tool-children.ts";
import { HOST_RESTARTING_EVENT } from "../../../lib/core/session/host.ts";
import type { CarriedShell } from "../../../lib/internal/shell/carried.ts";
import { JOBS_CARRIED, type JobsCarried } from "../../../lib/jobs/host.ts";

const OWN = "/user.slice/user@1000.service/agents.slice/pi-host.service";
const OWN_CGROUP = `0::${OWN}\n`;
const JOBS_PROCS =
	"/sys/fs/cgroup/user.slice/user@1000.service/jobs.slice/jobs.service/cgroup.procs";
const SELF = 100;

interface Process {
	readonly cgroup: string;
	readonly environ: Record<string, string>;
}

function table(processes: Record<number, Process>): ProcessTable {
	return {
		self: SELF,
		pids: () => [SELF, ...Object.keys(processes).map(Number)],
		environ: async (pid) =>
			pid === SELF ? {} : (processes[pid]?.environ ?? undefined),
		group: () => undefined,
		cgroup: (pid) => (pid === SELF ? OWN : processes[pid]?.cgroup),
		started: () => undefined,
		kill: () => {},
	};
}

function shell(mark: string, extra: Partial<CarriedShell> = {}): CarriedShell {
	return {
		kind: "shell",
		keep: `/kept/${mark}`,
		pid: 200,
		mark,
		startedAt: 0,
		...extra,
	};
}

function bus() {
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	return {
		on(channel: string, listener: (data: unknown) => void) {
			listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((each) => each !== listener),
				);
			};
		},
		emit(channel: string, data: unknown) {
			for (const listener of listeners.get(channel) ?? []) listener(data);
		},
	};
}

function carriedOn(session: string, work: CarriedShell): JobsCarried {
	return {
		session,
		jobs: [{ id: "j1", kind: "shell", label: "make test", work }],
	};
}

describe("carried shells", () => {
	let stateDir: string;
	let moved: [string, number][];
	let said: string[];
	let reported: unknown[];
	let stopped: CarriedShell[];
	let now: number;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "carried-shells-"));
		moved = [];
		said = [];
		reported = [];
		stopped = [];
		now = 1_000_000;
	});
	afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

	function make(
		overrides: Partial<CarriedShellsOptions> = {},
	): ReturnType<typeof carriedShells> {
		return carriedShells({
			stateDir,
			jobs: "jobs.slice/jobs.service",
			ownCgroup: () => OWN_CGROUP,
			table: table({}),
			move: async (procs, pid) => {
				moved.push([procs, pid]);
			},
			running: () => true,
			stop: (work) => stopped.push(work),
			say: (line) => said.push(line),
			report: (error) => reported.push(error),
			now: () => now,
			...overrides,
		});
	}

	function kept(): KeptCall[] {
		return JSON.parse(readFileSync(join(stateDir, KEPT_FILE), "utf8"));
	}

	it("keeps nothing where there is no jobs cgroup", () => {
		expect(make({ jobs: "" }).keeps).toBe(false);
		expect(make().keeps).toBe(true);
	});

	it("moves only the processes in its own cgroup that carry the call's mark", async () => {
		const shells = make({
			table: table({
				201: { cgroup: OWN, environ: { PI_BASH_CALL: "m1" } },
				202: { cgroup: OWN, environ: { PI_BASH_CALL: "m2" } },
				203: {
					cgroup: "/user.slice/user@1000.service/jobs.slice/jobs.service",
					environ: { PI_BASH_CALL: "m1" },
				},
				204: { cgroup: OWN, environ: { PATH: "/bin" } },
			}),
		});
		const conversation = bus();
		shells.heard(conversation);
		conversation.emit(HOST_RESTARTING_EVENT, { session: "s1" });
		conversation.emit(JOBS_CARRIED, carriedOn("s1", shell("m1")));

		expect(await shells.keep()).toEqual([201]);
		expect(moved).toEqual([[JOBS_PROCS, 201]]);
		expect(kept()).toEqual([
			expect.objectContaining({ session: "s1", job: "j1", at: now }),
		]);
	});

	it("keeps nothing a conversation carried away when no restart was said to it", async () => {
		const shells = make({
			table: table({ 201: { cgroup: OWN, environ: { PI_BASH_CALL: "m1" } } }),
		});
		const conversation = bus();
		shells.heard(conversation);
		conversation.emit(JOBS_CARRIED, carriedOn("s1", shell("m1")));

		expect(await shells.keep()).toEqual([]);
		expect(moved).toEqual([]);
	});

	it("goes on past a process that ended as it was moved", async () => {
		const shells = make({
			table: table({ 201: { cgroup: OWN, environ: { PI_BASH_CALL: "m1" } } }),
			move: async () => {
				throw Object.assign(new Error("gone"), { code: "ESRCH" });
			},
		});
		const conversation = bus();
		shells.heard(conversation);
		conversation.emit(HOST_RESTARTING_EVENT, { session: "s1" });
		conversation.emit(JOBS_CARRIED, carriedOn("s1", shell("m1")));

		expect(await shells.keep()).toEqual([]);
		expect(reported).toEqual([]);
		expect(kept()).toHaveLength(1);
	});

	describe("watching what an earlier restart kept", () => {
		function keptEarlier(...calls: KeptCall[]): void {
			writeFileSync(join(stateDir, KEPT_FILE), JSON.stringify(calls));
		}

		function watched(
			holds: (session: string) => boolean,
			overrides: Partial<CarriedShellsOptions> = {},
		): () => void {
			let look: (() => void) | undefined;
			make({
				every: (ms, run) => {
					expect(ms).toBe(STRAY_LOOK_MS);
					look = run;
					return () => {};
				},
				...overrides,
			}).watch(holds);
			return () => look?.();
		}

		const call = (work: CarriedShell): KeptCall => ({
			session: "s1",
			job: "j1",
			label: "make test",
			at: 1_000_000,
			work,
		});

		it("leaves a call that isn't due yet", () => {
			keptEarlier(call(shell("m1")));
			const look = watched(() => false);
			now += STRAY_FOR_MS - 1;
			look();
			expect(stopped).toEqual([]);
			expect(kept()).toHaveLength(1);
		});

		it("stops a call nobody took up a day after the restart, saying so", () => {
			keptEarlier(call(shell("m1")));
			const look = watched(() => false);
			now += STRAY_FOR_MS;
			look();
			expect(stopped).toEqual([shell("m1")]);
			expect(said).toEqual([
				expect.stringMatching(/make test.*j1 of s1.*a day passed/),
			]);
			expect(kept()).toEqual([]);
		});

		it("stops one sooner once its time limit passes", () => {
			keptEarlier(call(shell("m1", { deadline: 1_000_000 + 60_000 })));
			const look = watched(() => false);
			now += 60_000;
			look();
			expect(stopped).toHaveLength(1);
			expect(said).toEqual([expect.stringMatching(/its time limit passed/)]);
		});

		it("lets go of a call a conversation here holds, or that ended", () => {
			keptEarlier(
				call(shell("m1")),
				{ ...call(shell("m2")), session: "s2" },
				{ ...call(shell("m3")), session: "s3" },
			);
			const look = watched((session) => session === "s1", {
				running: (work) => work.mark !== "m2",
			});
			look();
			expect(stopped).toEqual([]);
			expect(kept().map((each) => each.session)).toEqual(["s3"]);
		});
	});
});
