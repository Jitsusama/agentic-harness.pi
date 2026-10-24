import { describe, expect, it } from "vitest";
import {
	CHANGED_CHECKS_GIB,
	EVALUATION_GIB,
	EVERY_CHECK_GIB,
	type Job,
	kindOf,
	MOST_CPU_PRESSURE_BESIDE_VMS,
	MOST_VMS,
	needsGibOf,
	nextTurn,
	RAMP_MS,
	roomLeft,
	roomSaid,
	SPREAD_MS,
	waitingInOrder,
	waitsWithRoom,
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

	it("reads changed-checks and an evaluation of every check as heavy", () => {
		// Seen 24 October: two `changed-checks --build --no-vm` runs held
		// about 20 GiB each with no turn, beside a flake check given one.
		expect(kindOf("changed-checks")).toBe("build");
		expect(kindOf("cd ~/src/core.nix && changed-checks --build --no-vm")).toBe(
			"build",
		);
		expect(kindOf("direnv exec . changed-checks --build")).toBe("vm-check");
		expect(kindOf("nix eval --json .#checks.x86_64-linux --apply 'x: 1'")).toBe(
			"build",
		);
		expect(kindOf('nix eval --json "path:$W#checks"')).toBe("build");
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
		expect(nextTurn([job("build")], { ...ROOMY, vms: 1 }, NOW)?.capped).toBe(
			true,
		);
		const test = job("test", { kind: "vm-test", started: startedAgo(RAMP_MS) });
		expect(nextTurn([test, job("build")], { ...ROOMY, vms: 1 }, NOW)).toEqual(
			job("build"),
		);
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
		expect(nextTurn([check, ...waiting], BUSY, NOW)?.id).toBe("bench");
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

	it("counts a wait as wasted only when its memory stands free", () => {
		const waiting = [job("vm", { kind: "vm-test" })];
		expect(waitsWithRoom(waiting, ROOMY)).toBe(true);
		expect(waitsWithRoom(waiting, { ...ROOMY, availableGib: 5 })).toBe(false);
		expect(
			waitsWithRoom([{ ...waiting[0], started: startedAgo(1) }], ROOMY),
		).toBe(false);
	});
});

describe("the room left", () => {
	it("counts what would start now, past what runs and waits", () => {
		expect(roomLeft([], ROOMY, NOW)).toEqual({ vms: MOST_VMS, builds: 10 });
		const running = job("vm", { kind: "vm-test", started: startedAgo(1) });
		expect(roomLeft([running, job("next")], ROOMY, NOW)).toEqual({
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
		expect(roomLeft([check], ROOMY, NOW)).toEqual({
			vms: MOST_VMS - 1,
			builds: 1,
		});
		expect(roomLeft([check], BUSY, NOW)).toEqual({
			vms: MOST_VMS - 1,
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
