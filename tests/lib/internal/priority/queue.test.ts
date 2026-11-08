import { describe, expect, it } from "vitest";
import { NOBODY } from "../../../../lib/internal/priority/awaited.ts";
import {
	CAPS_BUILDS_FROM_CPU_PRESSURE,
	CHANGED_CHECKS_GIB,
	EVAL_TESTS_GIB,
	EVALUATION_GIB,
	EVERY_CHECK_GIB,
	JOINS_FOR_MS,
	type Job,
	KEEPS_LINE_FOR_MS,
	kindOf,
	LENDING_WAIT_MS,
	leastGibOfCommand,
	MOST_CPU_PRESSURE_BESIDE_VMS,
	MOST_CPU_PRESSURE_FOR_BUILDS,
	MOST_FLOORS_CPU_PRESSURE,
	MOST_FLOORS_PRESSURE,
	MOST_IO_PRESSURE_FOR_BUILDS,
	MOST_MEMORY_PRESSURE,
	MOST_VMS,
	needsGibOf,
	needsGibOfCommand,
	nextTurn,
	PASS_AFTER_MS,
	QUICK_OUTRUN_MS,
	RAMP_MS,
	RULES,
	roomLeft,
	roomSaid,
	SPREAD_MS,
	skipsWorldPushHooks,
	VM_SETTLE_MS,
	VM_SPREAD_MS,
	VM_STEADY_MS,
	WALKS_AT_ONCE,
	waitingInOrder,
	waitReasons,
	waitsWithRoom,
	walkOf,
	whatOf,
} from "../../../../lib/internal/priority/queue.ts";

const NOW = Date.parse("2026-10-22T16:00:00Z");
const ROOMY = { availableGib: 40, memoryPressure: 0, vms: 0, cpuPressure: 0 };
const BUSY = { ...ROOMY, cpuPressure: MOST_CPU_PRESSURE_BESIDE_VMS };

function job(id: string, over: Partial<Job> = {}): Job {
	return {
		id,
		kind: "build",
		what: "nix build",
		owner: { session: "s", pid: 1 },
		since: new Date(NOW - 60_000).toISOString(),
		cappable: true,
		...over,
	};
}

const startedAgo = (ms: number) => new Date(NOW - ms).toISOString();

describe("why each job waits", () => {
	const long = startedAgo(RAMP_MS + 60_000);
	const older = (id: string, ms: number, over: Partial<Job> = {}) =>
		job(id, { since: startedAgo(ms), ...over });

	it("says memory when the memory a job needs isn't free, and order behind it", () => {
		const jobs = [older("big", 9_000), older("next", 8_000)];
		const tight = { ...ROOMY, availableGib: 1 };
		expect(nextTurn(jobs, tight, NOW)).toBeUndefined();
		expect(Object.fromEntries(waitReasons(jobs, tight, NOW))).toEqual({
			big: "memory",
			next: "order",
		});
	});

	it("says memory for everyone while the machine is short of it", () => {
		const jobs = [older("a", 9_000)];
		const pressed = { ...ROOMY, memoryPressure: MOST_MEMORY_PRESSURE };
		expect(waitReasons(jobs, pressed, NOW).get("a")).toBe("memory");
	});

	it("says vms when the VMs allowed at once are running", () => {
		const running = Array.from({ length: MOST_VMS }, (_, at) =>
			job(`vm${at}`, { kind: "vm-test", started: long }),
		);
		const jobs = [...running, older("vm", 9_000, { kind: "vm-test" })];
		expect(waitReasons(jobs, ROOMY, NOW).get("vm")).toBe("vms");
	});

	it("starts no VM here while the person's programs wait on memory, even the first", () => {
		// 13:53 on 29 October: app.slice stalled 5%, and VMs below the count
		// kept starting, so nothing waited and no builder was lent.
		const jobs = [older("vm", 9_000, { kind: "vm-test" })];
		const calm = { ...ROOMY, floorsPressure: 0 };
		const waiting = { ...ROOMY, floorsPressure: MOST_FLOORS_PRESSURE + 0.5 };

		expect(nextTurn(jobs, calm, NOW)?.id).toBe("vm");
		expect(nextTurn(jobs, waiting, NOW)).toBeUndefined();
		expect(waitReasons(jobs, waiting, NOW).get("vm")).toBe("vms");
		expect(roomLeft([], waiting, NOW).vms).toBe(0);
		// Where no floor is read there is nobody's memory to guard.
		expect(nextTurn(jobs, ROOMY, NOW)?.id).toBe("vm");
	});

	it("starts no VM here while CPU pressure is past its line, and a build a builder takes still goes", () => {
		const vm = older("vm", 9_000, { kind: "vm-test" });
		const lent = { ...BUSY, offload: { builds: 1, vms: 0 } };
		expect(nextTurn([vm], lent, NOW)).toBeUndefined();
		expect(waitReasons([vm], lent, NOW).get("vm")).toBe("vms");
		expect(nextTurn([vm, older("build", 8_000)], lent, NOW)?.id).toBe("build");
	});

	it("lets a queue-first quest's short job past the CPU and IO hold, and no other", () => {
		// 8 November: a deploy lane's 13-second cargo test waited 1,524 s,
		// 671 of them held here (L3V9AA, with 5FWIUS's rule).
		const lane = (id: string, lastRanS: number) =>
			older(id, 9_000, {
				what: "cargo test --lib wipe",
				quest: "QEST-DEPLOY",
				lastRanS,
			});
		const first = new Set(["QEST-DEPLOY"]);
		const stuck = { ...ROOMY, ioPressure: MOST_IO_PRESSURE_FOR_BUILDS + 10 };
		expect(
			nextTurn([lane("short", 13)], stuck, NOW, RULES, NOBODY, first)?.id,
		).toBe("short");
		expect(
			nextTurn([lane("long", 600)], stuck, NOW, RULES, NOBODY, first),
		).toBeUndefined();
		expect(nextTurn([lane("other", 13)], stuck, NOW)).toBeUndefined();
		// Joel's own programs waiting still hold it.
		const felt = { ...stuck, floorsCpuPressure: MOST_FLOORS_CPU_PRESSURE + 1 };
		expect(
			nextTurn([lane("short", 13)], felt, NOW, RULES, NOBODY, first),
		).toBeUndefined();
	});

	it("holds builds that run here while the machine is past its CPU line", () => {
		// 21:09 on 7 November: cargo, clippy and vitest from several
		// sessions all started with the machine at load 66 (80ECO2).
		const cargo = older("cargo", 9_000, { what: "cargo clippy" });
		const nix = older("nix", 8_000);
		const lent = { ...BUSY, offload: { builds: 1, vms: 0 } };
		expect(nextTurn([cargo], BUSY, NOW)).toBeUndefined();
		expect(waitReasons([cargo], BUSY, NOW).get("cargo")).toBe("busy");
		expect(nextTurn([cargo, nix], lent, NOW)?.id).toBe("nix");
		const under = { ...ROOMY, cpuPressure: MOST_CPU_PRESSURE_FOR_BUILDS - 1 };
		expect(nextTurn([cargo], under, NOW)?.id).toBe("cargo");
		const quick = older("quick", 9_000, { what: "cargo test", quick: true });
		expect(nextTurn([quick], BUSY, NOW)?.id).toBe("quick");
		// 00:12 on 8 November: a changed-checks sent whole to a builder
		// waited 46 minutes here, evaluating nothing here (5FWIUS).
		const sent = older("sent", 9_000, { what: "changed-checks", sent: true });
		expect(nextTurn([sent], BUSY, NOW)?.id).toBe("sent");
		// 01:20 on 8 November: avg10 dipped and a held cargo test started
		// at 79.9%; the minute's figure holds it through a dip.
		const dipped = { ...ROOMY, cpuPressure: 60, cpuPressureMinute: 75 };
		expect(nextTurn([cargo], dipped, NOW)).toBeUndefined();
		// 01:30: 48 links in D state at IO pressure 96% (P9R1KI).
		const stuck = { ...ROOMY, ioPressure: MOST_IO_PRESSURE_FOR_BUILDS };
		expect(waitReasons([cargo], stuck, NOW).get("cargo")).toBe("busy");
		// Busy but under the line, a build goes capped, cargo's jobs with it.
		const warm = { ...ROOMY, cpuPressure: CAPS_BUILDS_FROM_CPU_PRESSURE };
		expect(nextTurn([cargo], warm, NOW)).toEqual({ ...cargo, capped: true });
		expect(nextTurn([cargo], ROOMY, NOW)).toEqual(cargo);
		// While the person's own programs wait, even it waits.
		const felt = { ...ROOMY, floorsCpuPressure: MOST_FLOORS_CPU_PRESSURE + 1 };
		expect(nextTurn([sent], felt, NOW)).toBeUndefined();
	});

	it("starts nothing while the person's own programs wait on CPU", () => {
		// 21:27 on 7 November: the machine read 63% while app.slice read
		// 0.3%, so only what the person feels holds everything.
		const jobs = [older("vm", 9_000, { kind: "vm-test" }), older("b", 8_000)];
		const felt = {
			...ROOMY,
			floorsCpuPressure: MOST_FLOORS_CPU_PRESSURE + 1,
		};
		expect(nextTurn(jobs, felt, NOW)).toBeUndefined();
		expect(Object.fromEntries(waitReasons(jobs, felt, NOW))).toEqual({
			vm: "busy",
			b: "busy",
		});
		expect(roomLeft(jobs, felt, NOW)).toEqual({ vms: 0, builds: 0 });
		expect(
			waitsWithRoom(jobs, felt),
			"a wait the person's own programs cause is not wasted",
		).toBe(false);
		const calm = { ...ROOMY, cpuPressure: 63, floorsCpuPressure: 0.3 };
		expect(nextTurn(jobs, calm, NOW)?.id).toBe("vm");
	});

	it("gives a VM check held here a builder's VM slot", () => {
		const vm = older("vm", 9_000, { kind: "vm-check" });
		const stalled = { ...ROOMY, floorsPressure: MOST_FLOORS_PRESSURE + 4 };
		const lent = { ...stalled, offload: { builds: 32, vms: 32 } };
		expect(nextTurn([vm], stalled, NOW)).toBeUndefined();
		expect(nextTurn([vm], lent, NOW)?.id).toBe("vm");
	});

	it("says behind when builds beside a VM check are at their limit", () => {
		const jobs = [
			job("check", { kind: "vm-check", started: long }),
			job("beside", { started: long, capped: true }),
			older("build", 9_000),
			older("after", 8_000),
		];
		expect(nextTurn(jobs, ROOMY, NOW)).toBeUndefined();
		expect(Object.fromEntries(waitReasons(jobs, ROOMY, NOW))).toEqual({
			build: "behind",
			after: "order",
		});
	});

	it("puts a deploy's stamp first, with only the capped build beside it", () => {
		const build = older("build", 9_000);
		const stamp = older("stamp", 8_000, { kind: "stamp" });
		expect(nextTurn([build, stamp], ROOMY, NOW)?.id).toBe("stamp");

		const stamping = job("stamping", { kind: "stamp", started: long });
		expect(nextTurn([stamping, build], ROOMY, NOW)).toEqual({
			...build,
			capped: true,
		});
		const beside = job("beside", { started: long, capped: true });
		expect(nextTurn([stamping, beside, build], ROOMY, NOW)).toBeUndefined();
		expect(
			waitReasons([stamping, beside, build], ROOMY, NOW).get("build"),
		).toBe("behind");
	});

	it("says order for the job given the next turn and those after it", () => {
		const jobs = [older("a", 9_000), older("b", 8_000)];
		expect(nextTurn(jobs, ROOMY, NOW)?.id).toBe("a");
		expect(Object.fromEntries(waitReasons(jobs, ROOMY, NOW))).toEqual({
			a: "order",
			b: "order",
		});
	});
});

describe("the kind of heavy work a command runs", () => {
	it("reads each kind from the command", () => {
		expect(kindOf("./result/bin/nixos-test-driver")).toBe("vm-test");
		expect(kindOf("qemu-system-x86_64 -m 2G disk.img")).toBe("vm-test");
		expect(kindOf("nix build .#checks.x86_64-linux.vm-desktop-works")).toBe(
			"vm-check",
		);
		expect(
			kindOf("nix build .#checks.x86_64-linux.vm-desktop-works.driver"),
		).toBe("build");
		expect(kindOf("cargo bench")).toBe("benchmark");
		expect(kindOf("hyperfine 'make'")).toBe("benchmark");
		expect(kindOf("cd x && cargo clippy --all")).toBe("build");
		expect(kindOf("nix flake check")).toBe("build");
		expect(kindOf("sudo nixos-rebuild switch")).toBe("build");
	});

	it("reads a test suite of vitest's, and the pnpm scripts that run one, as a build", () => {
		// 21:09 on 7 November: several 4- to 8-worker vitest runs took no
		// turn beside cargo and clippy (80ECO2).
		// One test file alone is the focused run left to the machine itself.
		expect(
			kindOf(
				"timeout 120 pnpm exec vitest run tests/lib/mesh/looks.test.ts --testTimeout=60000 > $TMPDIR/l.log 2>&1",
			),
		).toBeUndefined();
		expect(kindOf("pnpm exec vitest run tests/a.test.ts tests/b.test.ts")).toBe(
			"build",
		);
		expect(kindOf("pnpm exec vitest run tests/lib --testTimeout=60000")).toBe(
			"build",
		);
		expect(kindOf("npx vitest")).toBe("build");
		expect(kindOf("cd $T && timeout 2400 pnpm check; echo done")).toBe("build");
		expect(kindOf("pnpm test:unit")).toBe("build");
		expect(kindOf("pnpm run test")).toBe("build");
		// Looking at it, a file named for it, and other scripts are not.
		expect(kindOf("grep vitest package.json")).toBeUndefined();
		expect(kindOf("code vitest.config.ts")).toBeUndefined();
		expect(kindOf("pnpm lint")).toBeUndefined();
		expect(kindOf("pnpm checkout-thing")).toBeUndefined();
		// npm's test is Acceluary's deploy stamp, timed work of its own.
		expect(kindOf("npm test")).toBeUndefined();
	});

	it("reads a deploy's stamp as one, by its suite or by npm's test in Acceluary", () => {
		// 7 November: train 8's stamp took 13 minutes beside ten builds,
		// against 3 to 5 with few, and its owner ruled it goes first.
		const home = "/home/joel";
		expect(kindOf("node deploy/suite.mjs")).toBe("stamp");
		expect(kindOf("cd $T && node estero/suite.mjs 2>&1 | tee out")).toBe(
			"stamp",
		);
		expect(kindOf("npm test", { home, cwd: `${home}/src/acceluary` })).toBe(
			"stamp",
		);
		expect(
			kindOf(
				"cd ~/.local/state/pi/work/trees/worktree-local-acceluary-estero && npm test",
				{
					home,
				},
			),
		).toBe("stamp");
		// Elsewhere npm's test is somebody's tests, and a look is no run.
		expect(
			kindOf("npm test", { home, cwd: `${home}/src/other` }),
		).toBeUndefined();
		expect(kindOf("cat deploy/suite.mjs")).toBeUndefined();
		expect(kindOf("node deploy/suite.mjs.bak")).toBeUndefined();
	});

	it("reads an evaluation of a whole machine as a build, and one attribute's not", () => {
		// 01:15 on 8 November: a nixosSystem evaluated through --expr ran
		// beside two of every check, with a deploy's tests failing (P9R1KI).
		expect(
			kindOf(
				`nix eval --impure --raw --expr 'let f = builtins.getFlake "path:/t"; c = f.inputs.nixpkgs.lib.nixosSystem { system = "x86_64-linux"; }; in c.config.system.build.toplevel.drvPath'`,
			),
		).toBe("build");
		expect(
			kindOf(
				"nix eval --raw .#nixosConfigurations.optimus.config.system.build.toplevel",
			),
		).toBe("build");
		expect(
			kindOf(
				"nix-instantiate -A nixosConfigurations.x.config.system.build.toplevel",
			),
		).toBe("build");
		expect(
			kindOf("nix eval --raw .#packages.x86_64-linux.hello.version"),
		).toBeUndefined();
	});

	it("reads a search of a whole World checkout as a build, and one of a zone not", () => {
		const home = "/home/joel";
		const root = `${home}/world/trees/root/src`;
		expect(kindOf("rg -n 'foo bar'", { home, cwd: root })).toBe("build");
		expect(kindOf("git grep -n needle", { home, cwd: root })).toBe("build");
		expect(kindOf(`cd ${root} && rg -l -t ts needle .`, { home })).toBe(
			"build",
		);
		expect(kindOf(`git -C ${root} grep needle`, { home })).toBe("build");
		// A zone, a path named, another repository: a look, as before.
		expect(kindOf("rg needle areas/core", { home, cwd: root })).toBeUndefined();
		expect(
			kindOf("rg needle", { home, cwd: `${root}/areas/core` }),
		).toBeUndefined();
		expect(
			kindOf("git grep needle -- areas", { home, cwd: root }),
		).toBeUndefined();
		expect(
			kindOf("rg needle", { home, cwd: `${home}/src/core.nix` }),
		).toBeUndefined();
	});

	it("reads changed-checks and an evaluation of every check as heavy", () => {
		// Seen 24 October: two `changed-checks --build --no-vm` runs held
		// about 20 GiB each with no turn, beside a flake check given one.
		expect(kindOf("changed-checks")).toBe("build");
		expect(kindOf("cd ~/src/core.nix && changed-checks --build --no-vm")).toBe(
			"build",
		);
		expect(kindOf("direnv exec . changed-checks --build")).toBe("vm-check");
		// core #1394: `there` builds nothing here unless told `--here`.
		expect(
			kindOf("nix-offload there -L . checks.x86_64-linux.vm-a"),
		).toBeUndefined();
		expect(
			kindOf("nix-offload there --here -L . checks.x86_64-linux.vm-a"),
		).toBe("vm-check");
		expect(
			kindOf("nix-offload there --here . checks.x86_64-linux.formatting"),
		).toBe("build");
		expect(kindOf("nix eval --json .#checks.x86_64-linux --apply 'x: 1'")).toBe(
			"build",
		);
		expect(kindOf('nix eval --json "path:$W#checks"')).toBe("build");
		// A pin's spaces sit inside its `$(...)`: still one word, still work.
		expect(
			kindOf(
				'nix build --no-link "git+file://$C?rev=$(git rev-parse HEAD)#checks.x86_64-linux.vm-a"',
			),
		).toBe("vm-check");
		// One check's evaluation, or a file the tool is named for, is not.
		expect(
			kindOf("nix eval --raw .#checks.x86_64-linux.foo.drvPath"),
		).toBeUndefined();
		expect(kindOf("cat tests/changed-checks.py")).toBeUndefined();
		expect(kindOf("nvim changed-checks.nix")).toBeUndefined();
		// Run from where it was built, as Y9XISP ran its Rust port on 24
		// October and was held to a build's 4 GiB, using 11.8.
		const built = "$out/bin/changed-checks --build --no-vm > $TMPDIR/cc.out";
		expect(kindOf(built)).toBe("build");
		expect(needsGibOf(job("built", { what: built }))).toBe(CHANGED_CHECKS_GIB);
		// Its crate's folder is not the tool.
		expect(kindOf("cd tests/changed-checks && ls")).toBeUndefined();
		expect(
			needsGibOf(
				job("crate", { what: "cd tests/changed-checks && cargo test" }),
			),
		).toBe(4);
	});

	it("reads the common forms of heavy work it missed", () => {
		// 7SU7HB's audit replayed these through kindOf on 23 October and
		// each ran with no turn, a VM's driver among them.
		for (const build of [
			"cargo +nightly build",
			"cargo --locked build --release",
			"cargo b",
			"cargo t -p walgit",
			"cargo c",
			"cargo r --bin x",
			"cargo doc --no-deps",
			"cargo llvm-cov nextest",
			"cargo miri test",
			"cargo insta test",
			"home-manager switch --flake .",
			"darwin-rebuild switch --flake .",
			"nix-fast-build --no-nom",
			"make -j16",
			"make -j 8 all",
			"cmake --build build",
			"go test ./...",
			"go build ./cmd/x",
		]) {
			expect(kindOf(build), build).toBe("build");
		}
		expect(kindOf("cargo +nightly bench")).toBe("benchmark");
		expect(
			kindOf(
				"timeout 3000 nice -n 10 nix develop .#x -c run-subtests vm-desktop",
			),
		).toBe("vm-test");
		expect(needsGibOf(job("fast", { what: "nix-fast-build" }))).toBe(
			EVALUATION_GIB,
		);
		// Watchers hold a turn for as long as they watch, and a one-attribute
		// evaluation or a plain make is too often trivial to wait behind a build.
		for (const light of [
			"cargo watch -x test",
			"bacon",
			"cargo fmt",
			"cargo rm serde",
			"make",
			"make install",
			"go fmt ./...",
			"home-manager news",
			"cat run-subtests.py",
		]) {
			expect(kindOf(light), light).toBeUndefined();
		}
	});

	it("reads a quoted word as the argument it is", () => {
		expect(
			kindOf(
				'nix build -L "path:$W/tmp/$job#checks.x86_64-linux.vm-desktop-works"',
			),
		).toBe("vm-check");
		expect(kindOf('echo "nix build is slow"')).toBeUndefined();
	});

	it("finds none where the work is only named, or there is none", () => {
		expect(kindOf("git log --oneline")).toBeUndefined();
		expect(kindOf("rg 'nix build' docs")).toBeUndefined();
		expect(
			kindOf("git commit -F - <<'EOF'\ncargo build is faster\nEOF"),
		).toBeUndefined();
		expect(kindOf("nix flake show")).toBeUndefined();
		expect(kindOf("cargo fmt")).toBeUndefined();
		// Past the heredoc, it still runs.
		expect(kindOf("cat <<EOF > x\nhi\nEOF\nnix build")).toBe("build");
	});

	it("finds none in a step that only looks for the work", () => {
		for (const looking of [
			"rm -f x; pgrep -x qemu-system-x86 | xargs -r ps -o pid,user -p",
			'pkill -f "qemu-system-x86_64"',
			"pidof qemu-system-x86_64",
			"ps -C qemu-system-x86",
			"sudo systemctl status qemu-system-x86",
			"ls /proc | grep -c qemu-kvm",
		]) {
			expect(kindOf(looking)).toBeUndefined();
		}
		expect(kindOf("pgrep -x qemu-kvm || nix build .#a")).toBe("build");
		// A pipe inside one quoted word is the pattern's, not the shell's:
		// on 24 October this waited for a turn, read as changed-checks.
		expect(
			kindOf("pgrep -af 'run-subtests|changed-checks' | cut -c1-160"),
		).toBeUndefined();
		expect(kindOf('pgrep -f "nix-build;cargo"')).toBeUndefined();
	});

	it("finds none in a git command that only reads the history", () => {
		// On 24 October this waited 51 s for a turn, read as changed-checks
		// and held to the 24 GiB an evaluation of every check needs.
		for (const looking of [
			"git grep -ln 'changed-checks' origin/main -- '*.nix' '*.py'",
			"git -C ~/src/core.nix grep -n nix-build origin/main",
			"git log --oneline origin/main -- tests/changed-checks.py",
			"git show origin/main:tests/changed-checks.py | head -50",
			"git diff origin/main -- tests/vm-first-vm-test.py",
			"git --no-pager blame checks.nix",
		]) {
			expect(kindOf(looking), looking).toBeUndefined();
		}
		// A git step beside the work leaves the work to be judged.
		expect(kindOf("git log -1; nix build .#a")).toBe("build");
		expect(kindOf("git -C core.nix pull && changed-checks --build")).toBe(
			"vm-check",
		);
	});

	it("finds none in a path or a glob that only names the work", () => {
		// On 24 October this read-only loop waited 315 s for a turn as a build.
		for (const looking of [
			"D=/sys/fs/cgroup/build.slice/nix-daemon.service; for c in $D/nix-build-*; do cat $c/cpu.weight; done",
			"ls -d /sys/fs/cgroup/build.slice/nix-daemon.service/nix-build-uid-872415232",
			"cat $D/nix-build-uid-1/cpu.weight",
		]) {
			expect(kindOf(looking), looking).toBeUndefined();
		}
		expect(kindOf("nix-build lab/container-probe.nix")).toBe("build");
		expect(kindOf("/nix/store/abc-nix/bin/nix-build x.nix")).toBe("build");
	});

	it("finds no work in a step that only reads a file or a path, though it sets a variable", () => {
		// On 24 October Y9XISP's look at a driver it had just built waited
		// for a turn as a VM test, from `w=$(readlink -f .../nixos-test-driver)`.
		const looking =
			"cd $T && d=$(nix build --no-link --print-out-paths \"git+file://$PWD?rev=9bf8#checks.x86_64-linux.vm-network-revives-units.driver\"); w=$(readlink -f $d/bin/nixos-test-driver); head -c 1500 $w | tr ':' '\\n' | grep -E 'site-packages' | head -5; ls $d";
		expect(kindOf(looking)).toBe("build");
		for (const reading of [
			"w=$(readlink -f $d/bin/nixos-test-driver)",
			"p=$(realpath result/bin/nixos-test-driver)",
			"ls -l $d/bin/nixos-test-driver",
			"stat $d/bin/qemu-system-x86_64",
			"file $d/bin/nixos-test-driver",
			"cat $d/bin/nixos-test-driver",
			"head -c 1500 $d/bin/nixos-test-driver",
			"[ -x $d/bin/nixos-test-driver ]",
			"test -x $d/bin/nixos-test-driver",
		]) {
			expect(kindOf(reading), reading).toBeUndefined();
		}
		// Set from what a step runs, a variable still runs it.
		for (const [running, kind] of [
			["out=$(nix build --print-out-paths .#tool)", "build"],
			["log=$($d/bin/nixos-test-driver 2>&1)", "vm-test"],
			[
				"[ -x $d/bin/nixos-test-driver ] && $d/bin/nixos-test-driver",
				"vm-test",
			],
		] as const) {
			expect(kindOf(running), running).toBe(kind);
		}
	});

	it("finds no VM in a store path that only names the driver or qemu", () => {
		// On 24 October Y9XISP's grep through the driver's sources waited for a
		// turn as a VM test, since the store path named nixos-test-driver.
		for (const looking of [
			"D=/nix/store/xfx93d0y-nixos-test-driver-1.1/lib/python3.14/site-packages/test_driver; grep -rn 'timeout' $D/*.py | head -20",
			"ls /nix/store/abc-qemu-system-x86_64-9.2.0/bin",
			"cat /nix/store/abc-qemu-kvm-9.2.0/share/doc/README",
			"rg retry $D/nixos-test-driver/machine",
		]) {
			expect(kindOf(looking), looking).toBeUndefined();
		}
		for (const running of [
			"$d/bin/nixos-test-driver --output_directory $out > $L 2>&1",
			"/nix/store/abc-nixos-test-driver-1.1/bin/nixos-test-driver",
			"/nix/store/abc-qemu-9.2.0/bin/qemu-system-x86_64 -m 2G",
			"qemu-kvm -nographic",
		]) {
			expect(kindOf(running), running).toBe("vm-test");
		}
	});

	it("knows an image built for containers as a build", () => {
		for (const building of [
			"podman build -t probe .",
			"docker build .",
			"docker buildx build --load .",
			"docker compose build",
			"buildah build -t probe .",
		]) {
			expect(kindOf(building), building).toBe("build");
		}
		expect(kindOf("podman ps")).toBeUndefined();
		expect(kindOf("docker images")).toBeUndefined();
	});

	it("says the step that does the work, past the variables it sets", () => {
		expect(whatOf('cd core && RUST_LOG=debug A="x y" cargo test -p a')).toBe(
			"cargo test -p a",
		);
		expect(whatOf("echo hi")).toBe("echo hi");
		// Seen live: a mesh notice that named the variables told a peer a path.
		expect(
			whatOf(
				"W=/home/jitsusama/.cache/w; L=$W/log\ncd ~/src/core.nix && NIX_CONFIG='x' nix build .#vm -L > $L",
			),
		).toBe("nix build .#vm -L > $L");
	});

	it("says the step that does the work, never a line of a heredoc", () => {
		// On 24 October Y9XISP's commit and build was named for its commit's
		// subject, "write changed-checks in Rust", and so held to the 24 GiB
		// of an evaluation of every check rather than a build's 4.
		const committing =
			'cd $T && git commit -q -F - <<\'EOF\'\nrefactor(tests): write changed-checks in Rust\n\nIt is now a crate.\nEOF\nf="git+file://$PWD"; nix build --no-link -L "$f#checks.x86_64-linux.formatting" > $L 2>&1';
		const what = whatOf(committing);
		expect(what).toBe(
			'nix build --no-link -L "$f#checks.x86_64-linux.formatting" > $L 2>&1',
		);
		expect(needsGibOf(job("committing", { kind: "build", what }))).toBe(4);
	});
});

describe("a builder elsewhere", () => {
	const long = startedAgo(60 * 60 * 1000);
	const vmsRunning = Array.from({ length: MOST_VMS }, (_, i) =>
		job(`vm-${i}`, { kind: "vm-check", started: long }),
	);
	const full = { ...ROOMY, vms: MOST_VMS };
	const withVms = { builds: 4, vms: 2 };

	it("gives a waiting VM check a builder's free VM slot, and none once they're spoken for", () => {
		const waiting = job("vm-next", { kind: "vm-check" });
		expect(nextTurn([...vmsRunning, waiting], full, NOW)).toBeUndefined();
		expect(
			waitReasons([...vmsRunning, waiting], full, NOW).get("vm-next"),
		).toBe("vms");

		const standing = { ...full, offload: withVms };
		expect(nextTurn([...vmsRunning, waiting], standing, NOW)?.id).toBe(
			"vm-next",
		);

		// Two given their turns this minute are still evaluating, so they
		// hold no slot's lock yet, but the two free slots are theirs.
		const evaluating = [
			...vmsRunning,
			job("vm-there-1", { kind: "vm-check", started: startedAgo(20_000) }),
			job("vm-there-2", { kind: "vm-check", started: startedAgo(10_000) }),
			waiting,
		];
		expect(nextTurn(evaluating, standing, NOW)).toBeUndefined();
	});

	it("holds slow builds for a builder being lent, a few minutes at most, and lets the rest go", () => {
		// A nix build started while the builder boots keeps a hook that
		// found none, and runs wholly here (15:48 on 29 October).
		const lending = { ...ROOMY, lendingSince: NOW - 30_000 };
		const build = job("build");
		expect(nextTurn([build], lending, NOW)).toBeUndefined();
		expect(waitReasons([build], lending, NOW).get("build")).toBe("lending");

		// The builder takes no VM work, and quick builds stay here.
		const check = job("check", { kind: "vm-check" });
		const quick = job("quick", { quick: true });
		const test = job("test", { kind: "vm-test" });
		expect(nextTurn([build, check], lending, NOW)?.id).toBe("check");
		expect(nextTurn([build, quick], lending, NOW)?.id).toBe("quick");
		expect(nextTurn([build, test], lending, NOW)?.id).toBe("test");

		const late = { ...ROOMY, lendingSince: NOW - LENDING_WAIT_MS };
		expect(nextTurn([build], late, NOW)?.id).toBe("build");
	});

	it("starts VMs one at a time here, each once the last has settled", () => {
		// 16:28 to 16:31 on 29 October: four VMs in before any one's memory
		// showed, and six ran at a 17.6% stall.
		const next = job("next", { kind: "vm-check" });
		const just = job("just", { kind: "vm-test", started: startedAgo(30_000) });
		expect(nextTurn([just, next], ROOMY, NOW)).toBeUndefined();
		expect(waitReasons([just, next], ROOMY, NOW).get("next")).toBe("vms");

		const minute = startedAgo(VM_SPREAD_MS + 1_000);
		const growing = { ...just, started: minute, grewAt: startedAgo(5_000) };
		expect(nextTurn([growing, next], ROOMY, NOW)).toBeUndefined();

		const steady = { ...growing, grewAt: startedAgo(VM_STEADY_MS) };
		expect(nextTurn([steady, next], ROOMY, NOW)?.id).toBe("next");

		// A long test still growing past its first minutes holds nobody.
		const old = { ...growing, started: startedAgo(VM_SETTLE_MS) };
		expect(nextTurn([old, next], ROOMY, NOW)?.id).toBe("next");
		// Builds aren't paced.
		expect(nextTurn([just, job("build")], ROOMY, NOW)?.id).toBe("build");
	});

	it("counts a full builder as no room, since Nix then builds here", () => {
		// 14:27 on 29 October: the lent builder's eight slots all building,
		// and VM checks counted against them ran their qemu here.
		const waiting = job("vm-next", { kind: "vm-check" });
		const busy = { ...full, offload: { builds: 0, vms: 0 } };
		expect(nextTurn([...vmsRunning, waiting], busy, NOW)).toBeUndefined();
	});

	it("gives a VM test none of a builder's slots, since its qemu runs here", () => {
		const test = job("vm-next", { kind: "vm-test" });
		const lent = { ...full, offload: { builds: 8, vms: 8 } };
		expect(nextTurn([...vmsRunning, test], lent, NOW)).toBeUndefined();
		expect(waitReasons([...vmsRunning, test], lent, NOW).get("vm-next")).toBe(
			"vms",
		);
	});

	it("counts no VM slots for a builder that can't run VMs", () => {
		const waiting = job("vm-next", { kind: "vm-check" });
		const buildsOnly = { ...full, offload: { builds: 8, vms: 0 } };
		expect(nextTurn([...vmsRunning, waiting], buildsOnly, NOW)).toBeUndefined();
	});

	it("starts builds beside a VM check on its slots whatever this machine's CPU pressure", () => {
		const checking = [job("vm", { kind: "vm-check", started: long })];
		const pressed = { ...BUSY, vms: 1 };
		const build = job("build");
		expect(nextTurn([...checking, build], pressed, NOW)).toBeUndefined();
		// With no builder, it would run here, past the CPU line.
		expect(waitReasons([...checking, build], pressed, NOW).get("build")).toBe(
			"busy",
		);

		const oneSlot = { ...pressed, offload: { builds: 1, vms: 0 } };
		expect(nextTurn([...checking, build], oneSlot, NOW)?.id).toBe("build");

		// Once a build there takes the slot, the builder reads it busy.
		const there = job("there", { started: long, capped: true });
		const taken = { ...pressed, offload: { builds: 0, vms: 0 } };
		expect(nextTurn([...checking, there, build], taken, NOW)).toBeUndefined();
	});

	it("leaves the one build here beside a VM check when the machine has room", () => {
		const checking = [job("vm", { kind: "vm-check", started: long })];
		const calm = { ...ROOMY, vms: 1, offload: { builds: 1, vms: 0 } };
		const running = [
			job("here", { started: long, capped: true }),
			job("there", { started: long, capped: true }),
		];
		expect(
			nextTurn([...checking, running[0] as Job, job("next")], calm, NOW)?.id,
		).toBe("next");
		const taken = { ...calm, offload: { builds: 0, vms: 0 } };
		expect(
			nextTurn([...checking, ...running, job("next")], taken, NOW),
		).toBeUndefined();
	});
});

describe("whose turn it is", () => {
	it("starts timed work first, then the oldest", () => {
		const jobs = [
			job("old"),
			job("newer", { since: startedAgo(10_000) }),
			job("timed", { kind: "benchmark", since: startedAgo(5_000) }),
		];
		expect(waitingInOrder(jobs).map((one) => one.id)).toEqual([
			"timed",
			"old",
			"newer",
		]);
		expect(nextTurn(jobs, ROOMY, NOW)?.id).toBe("timed");
	});

	it("starts the work a session waits on first within its class", () => {
		const awaited = new Set(["held-on"]);
		const jobs = [
			job("old"),
			job("waited", {
				since: startedAgo(10_000),
				owner: { session: "held-on", pid: 2 },
			}),
			job("timed", { kind: "benchmark", since: startedAgo(5_000) }),
		];
		expect(waitingInOrder(jobs, awaited).map((one) => one.id)).toEqual([
			"timed",
			"waited",
			"old",
		]);
		const bulk = jobs.filter((one) => one.id !== "timed");
		expect(nextTurn(bulk, ROOMY, NOW, undefined, awaited)?.id).toBe("waited");
		expect(nextTurn(bulk, ROOMY, NOW)?.id).toBe("old");
	});

	it("starts a quest put first after the work a session waits on", () => {
		const old = job("old", { since: startedAgo(600_000) });
		const lab = job("lab", { quest: "QEST-LAB" });
		const parked = job("parked", {
			owner: { session: "waited-on", pid: 2 },
			since: startedAgo(1),
		});
		const bench = job("bench", { kind: "benchmark", since: startedAgo(1) });
		const first = new Set(["QEST-LAB"]);

		expect(
			waitingInOrder(
				[old, lab, parked, bench],
				new Set(["waited-on"]),
				first,
			).map((one) => one.id),
		).toEqual(["bench", "parked", "lab", "old"]);
		expect(nextTurn([old, lab], ROOMY, NOW, undefined, NOBODY, first)?.id).toBe(
			"lab",
		);
		expect(nextTurn([old, lab], ROOMY, NOW)?.id).toBe("old");
	});

	it("gives no turn within a spread of the last, nor under pressure", () => {
		const running = job("running", { started: startedAgo(SPREAD_MS - 1) });
		expect(nextTurn([running, job("next")], ROOMY, NOW)).toBeUndefined();
		const settled = { ...running, started: startedAgo(SPREAD_MS) };
		expect(nextTurn([settled, job("next")], ROOMY, NOW)?.id).toBe("next");
		expect(
			nextTurn([job("next")], { ...ROOMY, memoryPressure: 10 }, NOW),
		).toBeUndefined();
	});

	it("holds everyone behind a job the memory left can't fit", () => {
		const jobs = [job("vm", { kind: "vm-test" }), job("small")];
		expect(nextTurn(jobs, { ...ROOMY, availableGib: 5 }, NOW)).toBeUndefined();
		expect(nextTurn(jobs, { ...ROOMY, availableGib: 6 }, NOW)?.id).toBe("vm");
	});

	describe("a job memory can't free", () => {
		// 11-03: a 24 GiB evaluation of every check waited 4,473 s on memory
		// with nothing queued running from 20:05Z, and everything behind it
		// waited on the order.
		const stuck = (memoryMs: number, over: Partial<Job> = {}) =>
			job("every", {
				what: "nix eval --json .#checks.x86_64-linux --apply f",
				since: startedAgo(memoryMs + 60_000),
				waitingSince: { reason: "memory", at: startedAgo(memoryMs) },
				...over,
			});
		const small = job("small");
		const short = { ...ROOMY, availableGib: 10 };

		it("lets a job that fits pass one that waited on memory past the wait", () => {
			const jobs = [stuck(PASS_AFTER_MS + 1_000), small];
			expect(nextTurn(jobs, short, NOW)?.id).toBe("small");
			expect(Object.fromEntries(waitReasons(jobs, short, NOW))).toEqual({
				every: "memory",
				small: "order",
			});
		});

		it("counts the memory it waited on before as well as now", () => {
			const half = PASS_AFTER_MS / 2 + 1_000;
			const jobs = [
				stuck(half, { waitedOnMs: { memory: half, order: 60_000 } }),
				small,
			];
			expect(nextTurn(jobs, short, NOW)?.id).toBe("small");
		});

		it("lets pass only a job that fits now", () => {
			const jobs = [stuck(PASS_AFTER_MS + 1_000), job("mid", { needsGib: 12 })];
			expect(nextTurn(jobs, short, NOW)).toBeUndefined();
			expect(waitReasons(jobs, short, NOW).get("mid")).toBe("memory");
		});

		it("holds the line for a job the running jobs will free room for", () => {
			const running = job("running", {
				needsGib: 16,
				started: startedAgo(RAMP_MS + 1_000),
			});
			const jobs = [running, stuck(PASS_AFTER_MS + 1_000), small];
			expect(nextTurn(jobs, short, NOW)).toBeUndefined();
			expect(Object.fromEntries(waitReasons(jobs, short, NOW))).toEqual({
				every: "memory",
				small: "order",
			});
		});

		it("holds the line for a job that has waited on memory under the wait", () => {
			const jobs = [stuck(PASS_AFTER_MS - 1_000), small];
			expect(nextTurn(jobs, short, NOW)).toBeUndefined();
			expect(waitReasons(jobs, short, NOW).get("small")).toBe("order");
		});

		it("starts the job it passed as soon as that one fits", () => {
			const jobs = [stuck(PASS_AFTER_MS + 1_000), small];
			const room = { ...ROOMY, availableGib: EVERY_CHECK_GIB };
			expect(nextTurn(jobs, room, NOW)?.id).toBe("every");
			expect(waitReasons(jobs, room, NOW).get("every")).toBe("order");
		});

		describe("while a long run holds the memory it waits for", () => {
			// 11-03: a 20 GiB flake check and a 24 GiB evaluation waited on the
			// memory a changed-checks --build held, 13 GiB for its 6,402 s, and
			// 30 tests of 1 to 171 s that fit waited behind them on the order.
			const check = (endsInMs: number) =>
				job("check", {
					kind: "vm-check",
					what: "changed-checks --build",
					needsGib: 13,
					lastRanS: 6_400,
					started: startedAgo(6_400_000 - endsInMs),
				});
			const flake = stuck(PASS_AFTER_MS + 1_000, { needsGib: 20 });
			const room = { ...ROOMY, availableGib: 9 };

			it("lets work that fits pass, when how long it runs is unknown", () => {
				const jobs = [check(KEEPS_LINE_FOR_MS * 10), flake, small];
				expect(nextTurn(jobs, room, NOW)?.id).toBe("small");
				expect(Object.fromEntries(waitReasons(jobs, room, NOW))).toEqual({
					every: "memory",
					small: "order",
				});
			});

			it("holds work that would still run when that memory comes back", () => {
				const long = job("long", { lastRanS: 7_200 });
				const short = job("short", {
					since: startedAgo(30_000),
					lastRanS: 30,
				});
				const jobs = [check(KEEPS_LINE_FOR_MS * 10), flake, long, short];
				expect(nextTurn(jobs, room, NOW)?.id).toBe("short");
				expect(waitReasons(jobs, room, NOW).get("long")).toBe("order");
			});

			it("holds the line once that memory is due back within the wait", () => {
				const jobs = [check(KEEPS_LINE_FOR_MS - 1_000), flake, small];
				expect(nextTurn(jobs, room, NOW)).toBeUndefined();
				expect(waitReasons(jobs, room, NOW).get("small")).toBe("order");
			});

			it("counts a run past the length its last one took as due as long again", () => {
				// mw192vak's last run took 1,010 s; it ran 6,402.
				const outran = { ...check(-60_000), lastRanS: 1_010 };
				expect(nextTurn([outran, flake, small], room, NOW)?.id).toBe("small");
				const young = job("young", {
					needsGib: 13,
					started: startedAgo(KEEPS_LINE_FOR_MS / 2),
				});
				expect(nextTurn([young, flake, small], room, NOW)).toBeUndefined();
			});

			it("holds the line again once work that passed it would free its room", () => {
				const passed = job("passed", {
					needsGib: 4,
					started: startedAgo(RAMP_MS + 1_000),
				});
				const jobs = [check(KEEPS_LINE_FOR_MS * 10), passed, flake, small];
				const left = { ...room, availableGib: 16 };
				expect(nextTurn(jobs, left, NOW)).toBeUndefined();
				expect(waitReasons(jobs, left, NOW).get("small")).toBe("order");
			});
		});
	});

	it("holds an evaluation of every check that reads only their names to a build's", () => {
		// mw13l2lv waited 4,473 s for 24 GiB on 3 November; listing core's
		// 678 names held 169 MB at most (16V6F4).
		const named = [
			`nix eval --json .#checks.x86_64-linux --apply 'c: builtins.filter (n: builtins.match "vm-(screens|greeter|boot).*" n != null) (builtins.attrNames c)'`,
			`nix eval --json "path:$PWD#checks" --apply 'builtins.mapAttrs (s: c: builtins.attrNames c)' 2>/dev/null`,
			`nix eval --json "$f#checks.x86_64-linux" --apply builtins.attrNames | jq -M -r '.[]'`,
			`nix eval --json "path:$t#checks" --apply 'c: builtins.mapAttrs (_: builtins.attrNames) c'`,
			`nix eval --json .#checks --apply 'c: builtins.mapAttrs (s: v: builtins.attrNames v) c'`,
			`nix eval --json .#checks.x86_64-linux --apply 'a: builtins.filter (n: n != "penelope") (builtins.attrNames a)'`,
		];
		for (const command of named) {
			expect(needsGibOfCommand("build", command)).toBe(4);
		}
		const forced = [
			"nix eval --json .#checks.x86_64-linux",
			`nix eval --json .#checks.x86_64-linux --apply 'c: map (n: c.\${n}.drvPath) (builtins.attrNames c)'`,
			`nix eval --json .#checks --apply 'builtins.mapAttrs (s: c: builtins.mapAttrs (n: v: v.drvPath) c)'`,
			`nix eval --json .#checks.x86_64-linux --apply 'c: builtins.attrValues c'`,
			// Each returns a set of checks beside their names, which --json forces.
			`nix eval --json .#checks.x86_64-linux --apply 'c: [ (builtins.attrNames c) c ]'`,
			`nix eval --json .#checks --apply 'builtins.mapAttrs (s: c: [ (builtins.attrNames c) c ])'`,
			`nix eval --json .#checks --apply 'c: builtins.mapAttrs (s: v: v) c'`,
			`nix eval --json .#checks --apply 'c: builtins.mapAttrs (_: (x: [ (builtins.attrNames x) x ])) c'`,
			`nix eval --json .#checks.x86_64-linux --apply 'c: map (n: c) (builtins.attrNames c)'`,
			// Cut short, so what it applies can't be read.
			`nix eval --raw '.#checks.x86_64-linux' --apply 'c: b...`,
		];
		for (const command of forced) {
			expect(needsGibOfCommand("build", command)).toBe(EVERY_CHECK_GIB);
		}
	});

	it("holds a zone's evaluation tests to what nix-unit held when it was killed, at least", () => {
		const tec =
			"~/.local/state/tec/toolchain/base_profile/bin/tec run //system/aquifer/converge:evalTests";
		expect(kindOf(tec)).toBe("build");
		expect(kindOf("nix-unit --flake .#tests")).toBe("build");
		expect(needsGibOfCommand("build", tec)).toBe(EVAL_TESTS_GIB);
		// The chain T9C192 ran: its first step is a cargo build's.
		const chain = `cd converge && { (set -e; cargo fmt --check; cargo clippy --all-targets -- -D warnings; cargo test; ${tec}); echo done; }`;
		expect(needsGibOfCommand("build", chain)).toBe(EVAL_TESTS_GIB);
		expect(leastGibOfCommand(chain)).toBe(EVAL_TESTS_GIB);
		expect(whatOf(chain).slice(0, tec.length)).toBe(tec);
		// Named, not run, or another target: no floor.
		expect(leastGibOfCommand(`echo "then ${tec}"`)).toBe(0);
		expect(leastGibOfCommand("tec run //system/aquifer/converge:test")).toBe(0);
		expect(leastGibOfCommand("ls /nix/store/x-nix-unit-2.0")).toBe(0);
	});

	it("holds a whole flake's check to what its evaluation keeps", () => {
		const check = job("check", { what: "nix flake check --keep-going -L" });
		expect(needsGibOf(check)).toBe(EVALUATION_GIB);
		const one = job("one", { what: "nix build .#checks.x.foo" });
		expect(needsGibOf(one)).toBe(4);
		expect(
			needsGibOf(job("wrapped", { what: "nice -n 10 nix -L flake check" })),
		).toBe(EVALUATION_GIB);
		// Evaluating every check's derivation at once reached 24 GB as a
		// bare `nix eval`; changed-checks evaluates them 40 at a time.
		expect(
			needsGibOf(
				job("every", {
					what: "nix eval --json .#checks.x86_64-linux --apply f",
				}),
			),
		).toBe(EVERY_CHECK_GIB);
		expect(
			needsGibOf(job("changed", { what: "changed-checks --build --no-vm" })),
		).toBe(CHANGED_CHECKS_GIB);
		expect(
			needsGibOf(
				job("vm", { kind: "vm-check", what: "changed-checks --build" }),
			),
		).toBe(CHANGED_CHECKS_GIB);
		expect(CHANGED_CHECKS_GIB).toBeLessThan(EVERY_CHECK_GIB);
		const room = { ...ROOMY, availableGib: EVALUATION_GIB - 1 };
		expect(nextTurn([check], room, NOW)).toBeUndefined();
		expect(nextTurn([job("build")], room, NOW)?.id).toBe("build");
	});

	it("counts what just started as taken while it grows", () => {
		const growing = job("growing", { started: startedAgo(RAMP_MS - 1) });
		const room = { ...ROOMY, availableGib: 7 };
		expect(nextTurn([growing, job("next")], room, NOW)).toBeUndefined();
		const grown = { ...growing, started: startedAgo(RAMP_MS) };
		expect(nextTurn([grown, job("next")], room, NOW)?.id).toBe("next");
	});

	it("lets the next job past a VM the VMs at once hold back", () => {
		const vms = Array.from({ length: MOST_VMS }, (_, at) =>
			job(`vm${at}`, { kind: "vm-test", started: startedAgo(RAMP_MS) }),
		);
		const jobs = [...vms, job("third", { kind: "vm-test" }), job("build")];
		expect(nextTurn(jobs, ROOMY, NOW)?.id).toBe("build");
	});

	it("counts the VMs the machine runs, queued or not", () => {
		const machine = { ...ROOMY, vms: MOST_VMS };
		expect(
			nextTurn([job("vm", { kind: "vm-test" })], machine, NOW),
		).toBeUndefined();
		// A VM outside the queue is a check the daemon runs: builds beside
		// it are capped.
		expect(nextTurn([job("build")], { ...ROOMY, vms: 1 }, NOW)).toMatchObject({
			capped: true,
		});
		const test = job("test", { kind: "vm-test", started: startedAgo(RAMP_MS) });
		expect(nextTurn([test, job("build")], { ...ROOMY, vms: 1 }, NOW)).toEqual(
			job("build"),
		);
	});

	it("starts a build beside a VM check on a busy machine, but not while the person's programs stall on memory", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		const night = { ...ROOMY, cpuPressure: 68, floorsPressure: 0 };
		expect(nextTurn([check, job("build")], night, NOW)).toEqual({
			...job("build"),
			capped: true,
		});
		const stalled = { ...night, floorsPressure: MOST_FLOORS_PRESSURE + 0.5 };
		expect(nextTurn([check, job("build")], stalled, NOW)).toBeUndefined();
		expect(nextTurn([job("build")], stalled, NOW)?.id).toBe("build");
	});

	it("holds the checks behind a build that waits for a check", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		const later = job("later", { kind: "vm-check", since: startedAgo(1) });
		expect(nextTurn([check, job("build"), later], BUSY, NOW)).toBeUndefined();
	});

	it("starts one capped build beside a VM check while the CPU is free", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		expect(nextTurn([check, job("build")], ROOMY, NOW)).toEqual({
			...job("build"),
			capped: true,
		});
		const beside = job("beside", { started: startedAgo(RAMP_MS) });
		expect(nextTurn([check, beside, job("build")], ROOMY, NOW)).toBeUndefined();
		expect(nextTurn([check, job("build")], BUSY, NOW)).toBeUndefined();
		const older = job("older", { cappable: undefined });
		expect(nextTurn([check, older], ROOMY, NOW)).toBeUndefined();
		expect(nextTurn([older], ROOMY, NOW)?.id).toBe("older");
		const waiting = [job("build"), job("bench", { kind: "benchmark" })];
		// Past the CPU line a benchmark waits too, as builds do.
		expect(nextTurn([check, ...waiting], BUSY, NOW)).toBeUndefined();
		expect(
			nextTurn([check, job("build")], ROOMY, NOW, {
				buildsWaitForVmChecks: false,
			})?.id,
		).toBe("build");
		const building = job("building", { started: startedAgo(RAMP_MS) });
		expect(
			nextTurn([building, job("check", { kind: "vm-check" })], ROOMY, NOW)?.id,
		).toBe("check");
	});

	it("starts quick work ahead of other bulk, past a job held back, one at a time", () => {
		const quick = job("quick", { quick: true, since: startedAgo(1) });
		expect(nextTurn([job("build"), quick], ROOMY, NOW)?.id).toBe("quick");
		const big = job("big", { what: "changed-checks --build --no-vm" });
		const room = { ...ROOMY, availableGib: 10 };
		expect(nextTurn([big, job("build")], room, NOW)).toBeUndefined();
		expect(nextTurn([big, quick], room, NOW)?.id).toBe("quick");
		const another = { ...quick, id: "another", started: startedAgo(RAMP_MS) };
		expect(nextTurn([another, big, quick], room, NOW)).toBeUndefined();
		expect(nextTurn([another, quick], room, NOW)?.id).toBe("quick");
	});

	it("gives quick work a turn of its own beside a VM check, whatever the CPU", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		const quick = job("quick", { quick: true });
		expect(nextTurn([check, job("build"), quick], BUSY, NOW)).toEqual({
			...quick,
			capped: true,
		});
		const beside = job("beside", { started: startedAgo(RAMP_MS) });
		expect(nextTurn([check, beside, quick], ROOMY, NOW)?.id).toBe("quick");
		const running = { ...quick, id: "running", started: startedAgo(RAMP_MS) };
		expect(nextTurn([check, running, quick], ROOMY, NOW)?.id).toBe(undefined);
		expect(nextTurn([check, running, job("build")], ROOMY, NOW)?.id).toBe(
			"build",
		);
	});

	it("lets quick work past a job marked quick that has run past quick work's time, which counts as a build", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		// Learned as quick from a cached run, it is rebuilding for real.
		const outrun = job("kernel", {
			quick: true,
			started: startedAgo(QUICK_OUTRUN_MS),
		});
		const quick = job("quick", { quick: true });

		expect(nextTurn([check, outrun, quick], ROOMY, NOW)?.id).toBe("quick");
		expect(
			nextTurn([check, outrun, job("build")], ROOMY, NOW),
			"it holds the one build beside a VM check",
		).toBeUndefined();
	});

	it("counts a wait as wasted only when its memory stands free", () => {
		const waiting = [job("vm", { kind: "vm-test" })];
		expect(
			waitsWithRoom(waiting, ROOMY),
			"a VM test waiting with its memory free is a wasted wait",
		).toBe(true);
		expect(
			waitsWithRoom(waiting, { ...ROOMY, availableGib: 5 }),
			"a VM test waiting for memory is no wasted wait",
		).toBe(false);
		expect(
			waitsWithRoom([{ ...waiting[0], started: startedAgo(1) }], ROOMY),
			"a VM test already started is not waiting",
		).toBe(false);
	});
});

describe("the room left", () => {
	it("counts what would start now, past what runs and waits", () => {
		expect(roomLeft([], ROOMY, NOW)).toEqual({ vms: MOST_VMS, builds: 10 });
		// A VM just started leaves no VM room until it settles.
		const running = job("vm", { kind: "vm-test", started: startedAgo(1) });
		expect(roomLeft([running, job("next")], ROOMY, NOW)).toEqual({
			vms: 0,
			builds: 0,
		});
		const settled = { ...running, started: startedAgo(VM_SPREAD_MS) };
		expect(roomLeft([settled, job("next")], ROOMY, NOW)).toEqual({
			vms: MOST_VMS - 1,
			builds: 0,
		});
		expect(roomLeft([], { ...ROOMY, availableGib: 9, vms: 1 }, NOW)).toEqual({
			vms: 1,
			builds: 1,
		});
		const queued = [job("vm", { kind: "vm-test" })];
		expect(roomLeft(queued, { ...ROOMY, availableGib: 10 }, NOW)).toEqual({
			vms: 0,
			builds: 1,
		});
		expect(roomLeft([], { ...ROOMY, memoryPressure: 10 }, NOW)).toEqual({
			vms: 0,
			builds: 0,
		});
	});

	it("leaves no VM check past a build held for one", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		// Its qemu runs here, as the machine's count shows.
		const here = { ...ROOMY, vms: 1 };
		expect(roomLeft([check], here, NOW)).toEqual({
			vms: MOST_VMS - 1,
			builds: 1,
		});
		// Past the CPU line no build starts beside it, and no VM here either.
		expect(roomLeft([check], BUSY, NOW)).toEqual({
			vms: 0,
			builds: 0,
		});
		expect(roomLeft([check, job("build")], BUSY, NOW)).toEqual({
			vms: 0,
			builds: 0,
		});
	});

	it("says the room in words, or nothing", () => {
		expect(roomSaid({ vms: 2, builds: 8 })).toBe(
			"2 more VM tests and 8 more builds",
		);
		expect(roomSaid({ vms: 1, builds: 0 })).toBe("1 more VM test");
		expect(roomSaid({ vms: 0, builds: 0 })).toBe("");
	});
});

describe("a walk of World's objects", () => {
	const home = "/home/j";
	const tree = `${home}/world/trees/w-main/src`;
	const inWorld = { cwd: tree, home };
	const elsewhere = { cwd: `${home}/src/core.nix`, home };

	it("reads git's object walks run in a World checkout as a walk", () => {
		// 11-04, 08:04 to 08:22: six OOM kills while 3 to 5 of these ran at
		// once from different sessions' World trees, each mapping 3 to 6 GB
		// of packs, with no turn.
		for (const walking of [
			"git push delta HEAD:refs/heads/x",
			"timeout 3600 git push --force-with-lease origin x > $L 2>&1",
			"git fetch origin main",
			"git pull --rebase",
			"git gc --auto",
			"git repack -ad",
			"git rev-list --objects --all | git pack-objects --stdout > p.pack",
			"git -c core.askPass=true fetch delta",
		]) {
			expect(kindOf(walking, inWorld), walking).toBe("world-walk");
		}
		expect(kindOf("git push", { cwd: `${home}/world`, home })).toBe(
			"world-walk",
		);
	});

	it("reads a walk against World from wherever the command names it", () => {
		for (const walking of [
			"git -C ~/world/trees/w-main/src push origin x",
			`git -C ${tree} fetch`,
			"git -C $HOME/world/trees/a/src -C ../../b/src push",
			"cd ~/world/trees/w-main/src && git push",
			"T=$HOME/world/trees/a/src; cd $T && git fetch origin",
			"git clone ~/world/git /tmp/copy",
			"git fetch file:///home/j/world/git main",
			"git --git-dir=/home/j/world/git fetch origin",
		]) {
			expect(kindOf(walking, elsewhere), walking).toBe("world-walk");
		}
		// Named outright, it needs no folder to be read from.
		expect(kindOf("cd ~/world/trees/a/src && git push", { home })).toBe(
			"world-walk",
		);
		// The step said is the walk, not the `cd` before it.
		expect(
			whatOf("cd ~/world/trees/a/src && timeout 3600 git push origin x"),
		).toBe("timeout 3600 git push origin x");
		// A build in the same call takes the turn as a build.
		expect(kindOf("git push && nix build .#tool", inWorld)).toBe("build");
		expect(whatOf("git push && nix build .#tool")).toBe("nix build .#tool");
	});

	it("leaves every other repo's git, and git's reads of history, alone", () => {
		for (const other of [
			"git push",
			"git fetch origin main",
			"cd ~/src/dotfiles && git pull",
		]) {
			expect(kindOf(other, elsewhere), other).toBeUndefined();
		}
		expect(kindOf("cd ~/src/core.nix && git push", inWorld)).toBeUndefined();
		for (const reading of [
			"git log --oneline -20",
			"git diff origin/main",
			"git rev-parse HEAD",
			"git rev-list --objects HEAD | wc -l",
			"git status",
			"git -c push.default=current status",
			"git log --grep push",
			"echo git push",
			"gh pr create --title 'git push it'",
			"rg 'git fetch' scripts",
		]) {
			expect(kindOf(reading, inWorld), reading).toBeUndefined();
		}
	});

	it("holds a walk to 6 GiB", () => {
		expect(
			needsGibOf(job("walk", { kind: "world-walk", what: "git push" })),
		).toBe(6);
		expect(needsGibOfCommand("world-walk", "cd x && git push")).toBe(6);
	});

	it("runs at most two at once, whatever memory reads, and lets others past", () => {
		const long = startedAgo(RAMP_MS + 60_000);
		const walk = (id: string, over: Partial<Job> = {}) =>
			job(id, { kind: "world-walk", what: "git push", ...over });
		const running = [
			walk("one", { started: long }),
			walk("two", { started: long }),
		];
		const jobs = [
			...running,
			walk("third", { since: startedAgo(9_000) }),
			job("build", { since: startedAgo(8_000) }),
		];
		const plenty = { ...ROOMY, availableGib: 100 };

		expect(WALKS_AT_ONCE).toBe(2);
		expect(nextTurn(jobs, plenty, NOW)?.id).toBe("build");
		expect(Object.fromEntries(waitReasons(jobs, plenty, NOW))).toEqual({
			third: "walks",
			build: "order",
		});
		// With one of them done, the next starts.
		const after = jobs.filter((one) => one.id !== "two");
		expect(nextTurn(after, plenty, NOW)?.id).toBe("third");
		expect(waitReasons(after, plenty, NOW).get("third")).toBe("order");
	});

	it("waits on memory like any job when its 6 GiB isn't free", () => {
		const jobs = [job("walk", { kind: "world-walk", what: "git fetch" })];
		const tight = { ...ROOMY, availableGib: 5 };
		expect(nextTurn(jobs, tight, NOW)).toBeUndefined();
		expect(waitReasons(jobs, tight, NOW).get("walk")).toBe("memory");
	});

	it("isn't a build, so it never waits for a VM check or a builder being lent", () => {
		const jobs = [
			job("check", { kind: "vm-check", started: startedAgo(RAMP_MS + 60_000) }),
			job("beside", { started: startedAgo(RAMP_MS + 60_000) }),
			job("walk", { kind: "world-walk", what: "git push" }),
		];
		const lending = { ...ROOMY, lendingSince: NOW - 10_000 };
		expect(nextTurn(jobs, lending, NOW)?.id).toBe("walk");
		expect(nextTurn(jobs, lending, NOW)?.capped).toBeUndefined();
	});
});

describe("walks of World's objects among themselves", () => {
	const home = "/home/j";
	const inWorld = { cwd: `${home}/world/trees/w-main/src`, home };
	const long = startedAgo(RAMP_MS + 60_000);
	const plenty = { ...ROOMY, availableGib: 100 };
	const walk = (id: string, over: Partial<Job> = {}) =>
		job(id, { kind: "world-walk", what: "git fetch", ...over });

	it("reads a plain fetch of origin's main as one, however it is written", () => {
		// Each as an agent ran it on 4 and 5 November.
		for (const fetching of [
			"git fetch -q origin main 2>&1 | tail -2",
			"timeout 300 git fetch origin main 2>&1 | tail -1",
			"git fetch -q --no-tags origin main",
			"git fetch origin main 2>&1 | grep -v '^remote: *$'",
			"timeout 250 git fetch --no-tags origin refs/heads/main 2>&1 | tail -3",
			"git -c fetch.uriProtocols=https fetch --no-tags origin refs/heads/main",
			"git fetch -q origin refs/heads/main:refs/remotes/origin/main",
			"git fetch origin main > $L 2>&1",
		]) {
			expect(walkOf(fetching, inWorld), fetching).toBe("main-fetch");
		}
		expect(
			walkOf("cd ~/world/trees/a/src && git fetch origin main", { home }),
		).toBe("main-fetch");
	});

	it("reads a push, alone or after a fetch of main, as a push", () => {
		expect(walkOf("git push origin x", inWorld)).toBe("push");
		expect(
			walkOf("git fetch origin main && git push origin HEAD:x", inWorld),
		).toBe("push");
	});

	it("knows a push of World that skips its pre-push hooks", () => {
		// Each as an agent ran it on 6 November.
		for (const skipping of [
			"git push --no-verify -u origin jitsusama/refscale-replay 2>&1",
			"(git push --no-verify -u origin jitsusama/refscale-replay > $TMPDIR/push.log 2>&1)",
			"timeout 3000 git -c protocol.version=2 -c push.negotiate=true push --no-verify origin HEAD:refs/heads/x",
			"git fetch origin main && git push origin x --no-verify",
		]) {
			expect(skipsWorldPushHooks(skipping, inWorld), skipping).toBe(true);
		}
		for (const keeping of [
			"git push origin x",
			// A dry run, for a push.
			"git push -n origin x",
			"git push --no-verify --verify origin x",
			"git commit --no-verify -m wip",
			"echo 'git push --no-verify origin x'",
		]) {
			expect(skipsWorldPushHooks(keeping, inWorld), keeping).toBe(false);
		}
		expect(
			skipsWorldPushHooks("git push --no-verify origin x", {
				cwd: `${home}/src/core.nix`,
				home,
			}),
			"a push that skips hooks outside World is none of this",
		).toBe(false);
	});

	it("reads every other walk as other, and nothing outside World", () => {
		for (const other of [
			"timeout 300 git fetch origin river/deferred-metadata",
			"git fetch origin main river/deferred-metadata",
			// Every branch, not main alone.
			"git fetch origin",
			"git fetch --prune origin main",
			"git fetch --depth 1 origin main",
			"git fetch delta main",
			// A git by its path never finds the queue's first on the PATH.
			"/run/current-system/sw/bin/git fetch origin main",
			"git --git-dir=/home/j/world/git fetch origin main",
			"git pull origin main",
			"git fetch origin main && git fetch origin x",
			"git push origin x && git fetch origin x",
			"git gc --auto",
		]) {
			expect(walkOf(other, inWorld), other).toBe("other");
		}
		expect(
			walkOf("git fetch origin main", { cwd: `${home}/src/core.nix`, home }),
		).toBeUndefined();
		expect(walkOf("git log origin/main", inWorld)).toBeUndefined();
	});

	it("puts pushes and fetches of main ahead of other walks, leaving other work its place", () => {
		// 5 November: a push waited 61 minutes behind review fetches.
		const jobs = [
			walk("review", { walk: "other", since: startedAgo(9_000) }),
			job("build", { since: startedAgo(8_000) }),
			walk("review2", { walk: "other", since: startedAgo(7_000) }),
			walk("push", { walk: "push", since: startedAgo(6_000) }),
			walk("main", { walk: "main-fetch", since: startedAgo(5_000) }),
		];
		expect(waitingInOrder(jobs).map((one) => one.id)).toEqual([
			"push",
			"build",
			"main",
			"review",
			"review2",
		]);
		const busy = [
			...jobs,
			walk("one", { started: long }),
			walk("two", { started: long }),
		];
		const after = busy.filter((one) => one.id !== "two" && one.id !== "build");
		expect(nextTurn(after, plenty, NOW)?.id).toBe("push");
	});

	it("holds a fetch of main while one runs, letting other walks past", () => {
		// 5 November, 21:03: four fetches of main waited behind one running.
		const jobs = [
			walk("fetching", { walk: "main-fetch", started: long }),
			walk("main", { walk: "main-fetch", since: startedAgo(9_000) }),
			walk("review", { walk: "other", since: startedAgo(8_000) }),
		];
		expect(nextTurn(jobs, plenty, NOW)?.id).toBe("review");
		expect(waitReasons(jobs, plenty, NOW).get("main")).toBe("walks");
		// One running too long holds it no longer.
		const hung = jobs.map((one) =>
			one.id === "fetching"
				? { ...one, started: startedAgo(JOINS_FOR_MS + 1_000) }
				: one,
		);
		expect(nextTurn(hung, plenty, NOW)?.id).toBe("main");
		// Nor does one that was itself answered, nor one of older rules.
		for (const running of [
			walk("fetching", { walk: "main-fetch", started: long, answered: true }),
			walk("fetching", { started: long }),
		]) {
			const others = [running, ...jobs.slice(1)];
			expect(nextTurn(others, plenty, NOW)?.id).toBe("main");
		}
	});

	it("counts an answered fetch as no walk, no memory and no turn to space out", () => {
		const answered = (id: string) =>
			walk(id, {
				walk: "main-fetch",
				started: startedAgo(1_000),
				answered: true,
			});
		const jobs = [
			answered("a"),
			answered("b"),
			walk("review", { walk: "other", since: startedAgo(9_000) }),
		];
		const six = { ...ROOMY, availableGib: 6 };
		expect(nextTurn(jobs, six, NOW)?.id).toBe("review");
	});
});
