import { describe, expect, it } from "vitest";
import {
	CHANGED_CHECKS_GIB,
	EVALUATION_GIB,
	kindOf,
	needsGibOf,
	whatOf,
} from "../../../../lib/internal/priority/queue.ts";
import { job } from "./queue-line.ts";

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

	it("reads Acceluary's timed run as one, whatever it times", () => {
		// 8 November: its paired timings were given back while builds held
		// the load at 25 to 55 (E2ZIAQ), so builds yield to them.
		const home = "/home/joel";
		const acceluary = { home, cwd: `${home}/src/acceluary` };
		const cases = {
			here: kindOf("node tools/timed.mjs cold -- node bench.mjs", acceluary),
			// Its own suite timed is the timed run, not a stamp.
			suite: kindOf("node tools/timed.mjs suite -- npm test", acceluary),
			cd: kindOf(
				"cd ~/.local/state/pi/work/trees/worktree-local-acceluary-x && node tools/timed.mjs a -- true",
				{ home },
			),
			path: kindOf("node ~/src/acceluary/tools/timed.mjs a -- true", { home }),
			elsewhere: kindOf("node tools/timed.mjs a -- true", {
				home,
				cwd: `${home}/src/other`,
			}),
			look: kindOf("cat tools/timed.mjs", acceluary),
		};

		expect(cases).toEqual({
			here: "timed-run",
			suite: "timed-run",
			cd: "timed-run",
			path: "timed-run",
			elsewhere: undefined,
			look: undefined,
		});
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

	it("finds none in a step that only finds a tool or asks how to call it", () => {
		// On 10 November commands like these waited 964 s, 104 s and 754 s
		// for a turn as runs of changed-checks, while memory was short.
		for (const looking of [
			"direnv exec . which nix-offload changed-checks 2>/dev/null",
			"direnv exec . changed-checks --help 2>&1 | head -30",
			"timeout 60 direnv exec . changed-checks --help 2>&1 | grep -i -n 'system'",
			"changed-checks --help 2>&1",
			"changed-checks --version",
			"command -v merge-net run-subtests changed-checks",
			"type changed-checks merge-net 2>&1",
			"for p in $(pgrep -u $USER -f 'changed-checks|run-subtests|nix-offload|vm-desktop' ); do echo $p; done",
			"env -u SSH_AUTH_SOCK direnv exec ~/src/core.nix which changed-checks",
		]) {
			expect(kindOf(looking), looking).toBeUndefined();
		}
		// What runs under the same words still runs.
		for (const running of [
			"env -u SSH_AUTH_SOCK direnv exec . changed-checks > $G/changed.log 2>&1",
			"timeout 3000 direnv exec . changed-checks --no-vm > x.log 2>&1",
			"(direnv exec . changed-checks > $S/changed.log 2>&1",
			"changed-checks --help --no-vm",
		]) {
			expect(kindOf(running), running).toBe("build");
		}
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
