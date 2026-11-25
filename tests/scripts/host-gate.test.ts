/**
 * host-gate.sh as review_offer merge runs it: bash running the script as
 * it stands, in a clone of a bare origin, with the commit to merge as its
 * last word. Each case commits a change on a branch and has a stand-in
 * nix-offload say what its keeper kept as passed at that commit, the way
 * `nix-offload passed ran` does, or say it runs no keeper. The tools the
 * words name come from a profile of the test's own, as from the
 * account's and the system's on a machine.
 */

import { execFile } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "../../lib/internal/record.ts";
import config from "../../vitest.config.ts";
import {
	bareOrigin,
	cloneAt,
	folder,
	removeAll,
} from "../lib/internal/carry/support/machines.ts";
import { git } from "../support/git-fixture.ts";
// Imported only to be named, so `--changed` runs this file when a script
// it runs changes alone; it runs them from their paths below.
import "../../scripts/host-gate.sh";
import "../../scripts/host-test-there.sh";
// Imported only to be named too: what test:host's setup loads from
// outside tests/setup/, whose own changes rerun everything, so a change
// to one, or to what one comes to import, runs the case below that
// holds the gate's list to it.
import "../../lib/core/internal/keyring/secrets.ts";
import "../support/memory-secret-store.ts";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPTS = join(ROOT, "scripts");
const GATE = join(SCRIPTS, "host-gate.sh");
const RUNNER = join(SCRIPTS, "host-test-there.sh");
/** The tools test:host's words name, each a program in a store folder. */
const TOOLS = ["bash", "mycelium", "fd", "rg", "script"] as const;
/** What nix-offload exits with where the machine runs no keeper. */
const NO_KEEPER = 69;
/** What host-test-there.sh exits with when nothing ran. */
const NOTHING_RAN = 75;
/** A word the agent fence lets out (PLAIN_WORD in offload-exemption.ts). */
const PLAIN = /^[A-Za-z0-9._/@:=+^*-]+$/;
/** The account the generations' per-user profiles are for. */
const USER = "someone";

const made: string[] = [];
/** Folders a case made read-only, opened again so they can go. */
const locked = new Set<string>();
afterEach(() => {
	for (const dir of locked) chmodSync(dir, 0o755);
	locked.clear();
	removeAll(made);
});

/** A stand-in nix-offload saying what `keeper` holds for each commit. */
const OFFLOAD = `#!/usr/bin/env bash
[[ "$1 $2" == "passed ran" ]] || exit 64
[[ -e "$FAKE_KEEPER/none" ]] && exit ${NO_KEEPER}
cat "$FAKE_KEEPER/$3" 2> /dev/null
exit 0
`;

/**
 * A harness clone, a state folder, a proven runtime, a profile of tools
 * and a stand-in nix-offload whose keeper's record is a folder.
 */
async function harness() {
	const origin = await bareOrigin(made);
	const checkout = await cloneAt(origin, join(folder(made, "clone"), "h"));
	const state = folder(made, "state");
	const runtime = folder(made, "runtime");
	mkdirSync(join(runtime, "lib", "node_modules", "pi-monorepo"), {
		recursive: true,
	});
	const store = folder(made, "store");
	const profile = folder(made, "profile");
	const tools: Record<string, string> = {};
	for (const tool of TOOLS) {
		const bin = join(store, `0000-${tool}`, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, tool), "");
		chmodSync(join(bin, tool), 0o755);
		symlinkSync(join(bin, tool), join(profile, tool));
		tools[tool] = realpathSync(join(store, `0000-${tool}`));
	}
	const bin = folder(made, "bin");
	writeFileSync(join(bin, "nix-offload"), OFFLOAD);
	chmodSync(join(bin, "nix-offload"), 0o755);
	const keeper = folder(made, "keeper");
	const generations = folder(made, "generations");
	return {
		checkout,
		state,
		runtime,
		store,
		profile,
		tools,
		bin,
		keeper,
		generations,
	};
}

/** An hour, in milliseconds. */
const HOUR = 3_600_000;

/**
 * An earlier system generation of the machine, `hoursAgo` old, as
 * /nix/var/nix/profiles holds them: the tools as the harness's, but for
 * those `moved` names to other store folders. The folder is left
 * read-only, as root's is to the account, unless `writable`, and is
 * `into` in place of the machine's. Answers its tools.
 */
function generation(
	on: Harness,
	number: number,
	moved: Record<string, string>,
	{ hoursAgo = 1, writable = false, into = on.generations } = {},
): Record<string, string> {
	mkdirSync(into, { recursive: true });
	chmodSync(into, 0o755);
	const link = join(into, `system-${number}-link`);
	const user = join(link, "etc", "profiles", "per-user", USER, "bin");
	mkdirSync(user, { recursive: true });
	mkdirSync(join(link, "sw", "bin"), { recursive: true });
	const tools: Record<string, string> = {};
	for (const tool of TOOLS) {
		const name = moved[tool];
		const home = name ? join(on.store, name) : (on.tools[tool] ?? "");
		if (name) {
			mkdirSync(join(home, "bin"), { recursive: true });
			writeFileSync(join(home, "bin", tool), "");
			chmodSync(join(home, "bin", tool), 0o755);
		}
		symlinkSync(join(home, "bin", tool), join(user, tool));
		tools[tool] = realpathSync(home);
	}
	const when = new Date(Date.now() - hoursAgo * HOUR);
	utimesSync(link, when, when);
	if (!writable) {
		chmodSync(into, 0o555);
		locked.add(into);
	}
	return tools;
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Commits `files` on a branch of its own, answering the commit. */
async function change(on: Harness, ...files: string[]): Promise<string> {
	await git(on.checkout, "checkout", "-q", "-B", "work", "origin/main");
	for (const file of files) {
		const path = join(on.checkout, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${file}\n`);
	}
	await git(on.checkout, "add", ...files);
	await git(on.checkout, "commit", "-q", "-m", `change ${files.join(" ")}`);
	return git(on.checkout, "rev-parse", "HEAD");
}

/** The words test:host runs as on this harness's machine, after `--`. */
function testHost(
	on: Pick<Harness, "tools" | "runtime">,
	runtime = on.runtime,
): string[] {
	const tool = (name: string) => on.tools[name] ?? "";
	const path = ["mycelium", "fd", "rg", "script"]
		.map((name) => `${tool(name)}/bin`)
		.join(":");
	return [
		`${tool("bash")}/bin/bash`,
		"scripts/host-run.sh",
		runtime,
		`${tool("mycelium")}/bin/mycelium`,
		path,
	];
}

/** Keeps a passing run of `words` at `sha`, as nix-offload's keeper does. */
function kept(on: Harness, sha: string, words: string[]): void {
	const line = JSON.stringify({
		copies: [on.runtime],
		dir: null,
		ended: 1_700_000_000,
		ran: words,
	});
	writeFileSync(join(on.keeper, sha), `${line}\n`, { flag: "a" });
}

/** What `script` answers in `on`'s checkout: its exit code and what it said. */
async function answer(
	on: Harness,
	script: string,
	words: string[],
	home = on.state,
): Promise<{ code: number; out: string; said: string }> {
	const env: NodeJS.ProcessEnv = {
		PATH: `${on.bin}:${process.env.PATH ?? ""}`,
		HOME: home,
		XDG_STATE_HOME: on.state,
		PI_HOST_RUNTIME: on.runtime,
		HOST_TEST_PROFILES: on.profile,
		HOST_GATE_GENERATIONS: on.generations,
		USER,
		FAKE_KEEPER: on.keeper,
	};
	try {
		const { stdout, stderr } = await run("bash", [script, ...words], {
			cwd: on.checkout,
			env,
		});
		return { code: 0, out: stdout, said: stdout + stderr };
	} catch (error) {
		if (!isRecord(error)) throw error;
		const { code, stdout, stderr } = error;
		const out = typeof stdout === "string" ? stdout : "";
		return {
			code: typeof code === "number" ? code : -1,
			out,
			said: `${out}${typeof stderr === "string" ? stderr : ""}`,
		};
	}
}

/** What the gate answers for `sha`. */
function gate(on: Harness, sha: string) {
	return answer(on, GATE, [sha]);
}

/**
 * A relative import in a file of code, its path the first group: static,
 * dynamic, or a file beside it named by `new URL`, as a program it
 * spawns by path is.
 */
const IMPORT =
	/(?:\bfrom\s*|\bimport\s*\(?\s*|\bnew URL\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

/**
 * A relative import vitest's own graph follows, static or dynamic: not
 * a file named by `new URL`, which only a program spawned reads.
 */
const MODULE_IMPORT =
	/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;

/** What a file of code ends in. */
const CODE = /\.(?:[cm]?[jt]s|tsx)$/;

/**
 * Every file of code that `from`, paths from the root, reach by the
 * imports `imports` reads, `from` among them: never a folder, as
 * `new URL("../..", import.meta.url)` names one.
 */
function reached(from: readonly string[], imports: RegExp): string[] {
	const found = new Set<string>();
	const next = from.map((file) => relative(ROOT, resolve(ROOT, file)));
	for (let file = next.pop(); file !== undefined; file = next.pop()) {
		const path = join(ROOT, file);
		if (found.has(file) || !CODE.test(file)) continue;
		if (!(statSync(path, { throwIfNoEntry: false })?.isFile() ?? false))
			continue;
		found.add(file);
		for (const imported of readFileSync(path, "utf8").matchAll(imports))
			next.push(
				relative(ROOT, resolve(ROOT, dirname(file), imported[1] ?? "")),
			);
	}
	return [...found].sort();
}

/** The reporters test:host names by path, from its script in package.json. */
function hostTestReporters(): string[] {
	const manifest: unknown = JSON.parse(
		readFileSync(join(ROOT, "package.json"), "utf8"),
	);
	const scripts = isRecord(manifest) ? manifest.scripts : undefined;
	const script = isRecord(scripts) ? Reflect.get(scripts, "test:host") : "";
	if (typeof script !== "string" || script === "")
		throw new Error("package.json has no test:host script");
	return [...script.matchAll(/--reporter=(\.{1,2}\/\S+)/g)].map(
		(found) => found[1] ?? "",
	);
}

/**
 * What test:host loads before its first case, as paths from the root:
 * the config, the process lane's setup files and global setup, the
 * root's global setup and the reporters its script names, with every
 * file each of those imports in turn, the scripts' loader among them.
 */
function hostTestSetup(): string[] {
	const lane = config.test?.projects?.find(
		(project) =>
			typeof project === "object" &&
			"test" in project &&
			project.test?.name === "process",
	);
	const its =
		typeof lane === "object" && "test" in lane ? lane.test : undefined;
	return reached(
		[
			"vitest.config.ts",
			...[its?.setupFiles ?? []].flat(),
			...[its?.globalSetup ?? []].flat(),
			...[config.test?.globalSetup ?? []].flat(),
			...hostTestReporters(),
		],
		IMPORT,
	);
}

/** The paths the gate counts as hosted, as its own pattern says. */
function hostedPattern(): RegExp {
	const said = /^hosted='([^']*)'$/m.exec(readFileSync(GATE, "utf8"))?.[1];
	if (said === undefined)
		throw new Error("host-gate.sh sets no hosted pattern");
	return new RegExp(said);
}

describe("host-gate.sh", () => {
	it("lets a change that touches nothing hosts run merge without a run", async () => {
		const on = await harness();
		const sha = await change(on, "docs/notes.md");

		const answered = await gate(on, sha);

		expect(answered).toMatchObject({
			code: 0,
			said: expect.stringContaining("touches nothing pi hosts run"),
		});
	});

	it("refuses a change to the host with no run, naming what clears it", async () => {
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(`nothing ran test:host at ${sha}`);
		expect(answered.said).toContain(`bash ${RUNNER}`);
	});

	it.each([
		"extensions/subagent-workflow/index.ts",
		"extensions/job-workflow/outbox.ts",
		"lib/mesh/address.ts",
	])(
		"refuses a change to %s, which the host cases drive, with no run",
		async (file) => {
			const on = await harness();
			const sha = await change(on, file);

			const answered = await gate(on, sha);

			expect(answered.code).toBe(1);
			expect(answered.said).toContain(`nothing ran test:host at ${sha}`);
		},
	);

	it("lets a change to an extension no host case drives merge without a run", async () => {
		const on = await harness();
		const sha = await change(on, "extensions/mermaid-widget/index.ts");

		const answered = await gate(on, sha);

		expect(answered).toMatchObject({
			code: 0,
			said: expect.stringContaining("touches nothing pi hosts run"),
		});
	});

	it.each(["extensions/park-workflow/README.md", "host/README.md"])(
		"lets a change to %s, a README nothing a host runs reads, merge without a run",
		async (file) => {
			const on = await harness();
			const sha = await change(on, file);

			const answered = await gate(on, sha);

			expect(answered).toMatchObject({
				code: 0,
				said: expect.stringContaining("touches nothing pi hosts run"),
			});
		},
	);

	it("still refuses a README's change beside code the host cases drive", async () => {
		const on = await harness();
		const sha = await change(
			on,
			"extensions/park-workflow/README.md",
			"extensions/park-workflow/watch.ts",
		);

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(
			"changes 1 path(s) pi hosts run, such as extensions/park-workflow/watch.ts",
		);
	});

	it.each(["host/engine/prompt.md", "host/engine/NOT-README.md"])(
		"still refuses %s, other markdown under the host, which a host could read",
		async (file) => {
			const on = await harness();
			const sha = await change(on, file);

			const answered = await gate(on, sha);

			expect(answered.code).toBe(1);
			expect(answered.said).toContain(`nothing ran test:host at ${sha}`);
		},
	);

	// The host tests load under the process lane's setup, the scripts'
	// loader among it, so a change there alone shapes how test:host runs.
	// The list is read from the config, so a setup file added there, or
	// one a setup file comes to import, can't slip past the gate.
	it("counts everything test:host loads before its cases as hosted", () => {
		const setup = hostTestSetup();
		expect(setup, "what the config names, and what that imports").toEqual(
			expect.arrayContaining([
				"tests/setup/scripts-as-text.ts",
				"tests/setup/xdg-sandbox.ts",
				"tests/setup/temp-root.ts",
				"tests/support/memory-secret-store.ts",
				"lib/core/internal/keyring/secret-service-call.mjs",
				"tests/host/end-to-end/support/every-case-ran.mts",
			]),
		);
		const hosted = hostedPattern();
		expect(
			setup.filter((file) => !hosted.test(file)),
			"loaded by test:host, not counted",
		).toEqual([]);
	});

	// `--changed` runs this file only when a change reaches its imports, or
	// is under tests/setup/, so the case above holds the gate's list to
	// each module the setup loads only while this file imports it. A
	// program or reporter it loads by path is counted itself, and today
	// imports nothing of the package's.
	it("imports each module test:host's setup loads from outside tests/setup, so a change to one runs it", () => {
		const own = new Set(
			reached([relative(ROOT, import.meta.filename)], MODULE_IMPORT),
		);
		expect(
			hostTestSetup().filter(
				(file) =>
					/\.ts$/.test(file) &&
					!file.startsWith("tests/setup/") &&
					!own.has(file),
			),
			"loaded by the setup, past this file's reach",
		).toEqual([]);
	});

	// A setup file may name a folder as `new URL("../..", import.meta.url)`
	// does, which the walk passes rather than reads.
	it("walks past a folder an import names", () => {
		expect(
			reached(["tests/setup/scripts-as-text-changed.test.ts"], IMPORT),
			"what that file reaches",
		).toContain("lib/internal/record.ts");
	});

	// The pattern is read as the gate reads it, so each path is asked of
	// it here; one each way runs the gate, to show grep reads it alike.
	it.each([
		"tests/setup/scripts-as-text.ts",
		"tests/setup/pi-install.ts",
		"tests/setup/xdg-sandbox.ts",
		"tests/setup/temp-root.ts",
		"tests/support/memory-secret-store.ts",
		"lib/core/internal/keyring/store.ts",
		"lib/core/internal/keyring/secret-service-call.mjs",
		"scripts/spawn-decide.ts",
	])("counts %s, which the host or its tests load, as hosted", (file) => {
		expect(hostedPattern().test(file), `${file} is hosted`).toBe(true);
	});

	it.each([
		"tests/setup/chrome-present.ts",
		"tests/setup/scripts-as-text.test.ts",
		"tests/setup/signal-stamp.ts",
		// A helper every lane's tests share, left to pnpm check's.
		"tests/support/until.ts",
		// Google's and Slack's sign-ins keep their tokens here; no host does.
		"lib/core/internal/keyring/document.ts",
	])(
		"counts %s, which test:host loads only as any test does, as no host's",
		(file) => {
			expect(hostedPattern().test(file), `${file} is no host's`).toBe(false);
		},
	);

	it("refuses a change to the scripts' loader until test:host ran at it", async () => {
		const on = await harness();
		const sha = await change(on, "tests/setup/scripts-as-text.ts");

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(`nothing ran test:host at ${sha}`);
	});

	it("lets a change to a helper every lane shares merge without a run", async () => {
		const on = await harness();
		const sha = await change(on, "tests/support/until.ts");

		const answered = await gate(on, sha);

		expect(answered).toMatchObject({
			code: 0,
			said: expect.stringContaining("touches nothing pi hosts run"),
		});
	});

	// Y9XISP on 24 November: a refspec that fetches no main, or a ref of the
	// checkout's named origin/main, could set main at the head itself.
	it("judges against main as origin has it, whatever the checkout's refspec fetches", async () => {
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");
		await git(
			on.checkout,
			"config",
			"remote.origin.fetch",
			"+refs/heads/none:refs/remotes/origin/none",
		);
		await git(on.checkout, "update-ref", "refs/remotes/origin/main", sha);

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(`nothing ran test:host at ${sha}`);
	});

	it("judges against origin's main, not a branch of the checkout's named origin/main", async () => {
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");
		await git(on.checkout, "branch", "origin/main", sha);

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(`nothing ran test:host at ${sha}`);
	});

	it("still refuses hosted code renamed to a README, by the path it left", async () => {
		const on = await harness();
		const code = "host/engine/engine.ts";
		await change(on, code);
		await git(on.checkout, "push", "-q", "origin", "HEAD:main");
		await git(on.checkout, "mv", code, "host/engine/README.md");
		await git(on.checkout, "commit", "-q", "-m", "rename the engine");
		const sha = await git(on.checkout, "rev-parse", "HEAD");

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(`such as ${code}`);
	});

	it("lets a change to the host merge once the keeper kept test:host passing at it", async () => {
		const on = await harness();
		const sha = await change(on, "lib/ui/panel/panel-screen.ts");
		kept(on, sha, ["/nix/store/0000-coreutils/bin/true"]);
		kept(on, sha, testHost(on));

		const answered = await gate(on, sha);

		expect(answered).toMatchObject({
			code: 0,
			said: expect.stringContaining(`test:host passed at ${sha}`),
		});
	});

	it("refuses another program the keeper kept as passing, such as true", async () => {
		const on = await harness();
		const sha = await change(on, "lib/core/session/slot.ts");
		kept(on, sha, ["/nix/store/0000-coreutils/bin/true"]);

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(`what passed at ${sha} isn't test:host`);
	});

	it("refuses a run of only some files", async () => {
		const on = await harness();
		const sha = await change(on, "tests/host/end-to-end/keys.test.ts");
		kept(on, sha, [...testHost(on), "tests/host/end-to-end/keys.test.ts"]);

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("isn't test:host");
	});

	it("refuses a run on another runtime than the proven one", async () => {
		const on = await harness();
		const sha = await change(on, "package.json");
		kept(on, sha, testHost(on, "/nix/store/elsewhere"));

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("isn't test:host on the proven");
	});

	it("refuses at once, naming the link, when the hosts' runtime link names nothing", async () => {
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");
		kept(on, sha, testHost(on));
		const gone = join(on.state, "pi-host", "gone");

		const answered = await gate({ ...on, runtime: gone }, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(`runtime link ${gone} names nothing`);
	});

	it("refuses a host change when the runtime link dangles in a folder that's there", async () => {
		// GNU's readlink -f answers a dangling link's target, so the existence
		// test is what refuses it there; macOS's readlink refuses it first.
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");
		kept(on, sha, testHost(on));
		const links = join(on.state, "pi-host");
		mkdirSync(links, { recursive: true });
		const dangling = join(links, "dangling");
		symlinkSync(join(links, "nowhere"), dangling);

		const answered = await gate({ ...on, runtime: dangling }, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(`runtime link ${dangling} names nothing`);
	});

	it("lets a change hosts don't run through on a machine with no runtime link", async () => {
		const on = await harness();
		const sha = await change(on, "docs/notes.md");
		const gone = join(on.state, "pi-host", "gone");

		const answered = await gate({ ...on, runtime: gone }, sha);

		expect(answered.code).toBe(0);
		expect(answered.said).toContain("touches nothing pi hosts run");
	});

	it("takes a run on the tools this machine had before its latest switch", async () => {
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");
		const before = generation(on, 1196, { mycelium: "1111-mycelium" });
		kept(on, sha, testHost({ ...on, tools: before }));

		const answered = await gate(on, sha);

		expect(answered).toMatchObject({
			code: 0,
			said: expect.stringContaining(
				"on the tools of this machine's system generation 1196",
			),
		});
	});

	it("refuses a run on tools no recent generation of this machine had", async () => {
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");
		generation(on, 1196, { mycelium: "1111-mycelium" });
		const stale = generation(
			on,
			1100,
			{ mycelium: "2222-mycelium" },
			{ hoursAgo: 13 },
		);
		const forged = { ...on.tools, mycelium: join(on.store, "3333-mycelium") };
		kept(on, sha, testHost({ ...on, tools: stale }));
		kept(on, sha, testHost({ ...on, tools: forged }));

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("with this machine's tools");
	});

	it("refuses a generation in a folder the account could write", async () => {
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");
		const forged = generation(
			on,
			1199,
			{ mycelium: "4444-mycelium" },
			{ writable: true },
		);
		kept(on, sha, testHost({ ...on, tools: forged }));

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("with this machine's tools");
	});

	it("refuses a fresh profile generation of the account's own with forged tools", async () => {
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");
		const profiles = join(on.state, ".local", "state", "nix", "profiles");
		const forged = generation(
			on,
			1199,
			{ mycelium: "5555-mycelium" },
			{ writable: true, into: profiles },
		);
		kept(on, sha, testHost({ ...on, tools: forged }));

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("with this machine's tools");
	});

	it("refuses a pass kept for an earlier commit of the same branch", async () => {
		const on = await harness();
		const earlier = await change(on, "host/service/program.ts");
		kept(on, earlier, testHost(on));
		const path = join(on.checkout, "host", "service", "program.ts");
		writeFileSync(path, "changed again\n");
		await git(on.checkout, "commit", "-q", "-am", "change it again");
		const later = await git(on.checkout, "rev-parse", "HEAD");

		const answered = await gate(on, later);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(`nothing ran test:host at ${later}`);
	});

	it("refuses on a machine whose nix-offload runs no keeper", async () => {
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");
		kept(on, sha, testHost(on));
		writeFileSync(join(on.keeper, "none"), "");

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("runs no nix-offload keeper");
	});
});

describe("host-test-there.sh", () => {
	it("inside the fence prints the lone call the fence lets out, and the gate takes", async () => {
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");
		const fenced = folder(made, "fenced-home");
		const key = join(fenced, ".local", "state", "nix-offload");
		mkdirSync(key, { recursive: true });
		writeFileSync(join(key, "store_ed25519"), "");

		const answered = await answer(on, RUNNER, [], fenced);

		expect(answered.code, answered.said).toBe(NOTHING_RAN);
		const call = answered.out.trim();
		expect(call).toMatch(
			new RegExp(`^cd ${on.checkout} && nix-offload there --never-ask --run `),
		);
		const words = call.split(" ").slice(3);
		expect(words.filter((word) => !PLAIN.test(word))).toEqual([]);
		expect(words.slice(words.indexOf("--") + 1)).toEqual(testHost(on));
		kept(on, sha, testHost(on));
		expect((await gate(on, sha)).code).toBe(0);
	});
});
