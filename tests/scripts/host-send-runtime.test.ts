/**
 * host-send-runtime.sh as host-test-there.sh runs it, against a stand-in
 * lender: ssh runs the remote command in a folder of the test's own, as
 * the lender's home, where a stand-in nix keeps a list as its store and
 * takes a path in only from a cache holding its narinfo. A stand-in nix
 * here answers the closure and writes the cache. The lender is named the
 * way nix-offload names it, by a store URI in a file. The stand-ins are
 * the host-send-runtime-*.sh files beside this one, each saying what
 * files of $FAKE steer it.
 */

import { execFile } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "../../lib/internal/record.ts";
import { folder, removeAll } from "../lib/internal/carry/support/machines.ts";

const run = promisify(execFile);
const SCRIPTS = join(import.meta.dirname, "..", "..", "scripts");
const SENDER = join(SCRIPTS, "host-send-runtime.sh");
const RUNNER = join(SCRIPTS, "host-test-there.sh");
/** The stand-in named `name`, beside this file. */
const STAND_IN = (name: string) =>
	join(import.meta.dirname, `host-send-runtime-${name}.sh`);
/** The tools test:host's words name, each a program in a store folder. */
const TOOLS = ["bash", "mycelium", "fd", "rg", "script"] as const;
/** A store path the lender has from the start, as its system's. */
const BASE = "/nix/store/0base-glibc";
const RUNTIME = "/nix/store/1run-pi-host-runtime-1.5.0";
/** The name this machine sends under, as HOST_SEND_FROM gives it. */
const ME = "here";

const made: string[] = [];
afterEach(() => removeAll(made));

/** Writes `text` to `bin`/`name` as a program. */
function program(bin: string, name: string, text: string): void {
	writeFileSync(join(bin, name), text);
	chmodSync(join(bin, name), 0o755);
}

/** Puts the stand-in `which` in `bin` as the program `name`. */
function standIn(bin: string, name: string, which: string): void {
	copyFileSync(STAND_IN(which), join(bin, name));
	chmodSync(join(bin, name), 0o755);
}

/**
 * A stand-in lender holding `held`, this machine's closure `closure`, and
 * the store file nix-offload writes while the lender stands, its URI
 * ending `settings`.
 */
function lender(closure: string[], held: string[], settings?: string) {
	const fake = folder(made, "fake");
	mkdirSync(join(fake, "lender"));
	const bin = join(fake, "bin");
	const lenderBin = join(fake, "lender-bin");
	mkdirSync(bin);
	mkdirSync(lenderBin);
	standIn(bin, "ssh", "ssh");
	standIn(bin, "nix", "nix");
	standIn(lenderBin, "nix", "lender-nix");
	standIn(lenderBin, "nix-store", "lender-nix-store");
	writeFileSync(join(fake, "closure"), `${closure.join("\n")}\n`);
	// Every path refers to the system's, as a cache checks before it takes one.
	writeFileSync(
		join(fake, "references"),
		closure
			.filter((path) => path !== BASE)
			.map((path) => `${path} ${BASE}\n`)
			.join(""),
	);
	writeFileSync(join(fake, "lender-store"), `${held.join("\n")}\n`);
	writeFileSync(join(fake, "key"), "a key\n");
	writeFileSync(join(fake, "host-key"), "ssh-ed25519 AAAAfake");
	const hostKey = Buffer.from("ssh-ed25519 AAAAfake").toString("base64");
	const store = join(fake, "store");
	writeFileSync(
		store,
		`ssh-ng://nix-offload@nix-offload-more?${settings ?? `ssh-key=${join(fake, "key")}&base64-ssh-public-host-key=${hostKey}`}\n`,
	);
	return { fake, bin, store };
}

type Lender = ReturnType<typeof lender>;

/** The lines of the stand-ins' log `name`, none when it wasn't written. */
function logged(on: Lender, name: string): string[] {
	const file = join(on.fake, name);
	return existsSync(file)
		? readFileSync(file, "utf8").split("\n").filter(Boolean)
		: [];
}

/** What the lender's store holds. */
function held(on: Lender): string[] {
	return readFileSync(join(on.fake, "lender-store"), "utf8")
		.split("\n")
		.filter(Boolean);
}

/** What's in the lender's home, which a finished send leaves as it was. */
function home(on: Lender): string[] {
	return readdirSync(join(on.fake, "lender"));
}

/** The folders of kept pieces on the lender under `from`'s name. */
function sentFrom(on: Lender, from = ME): string[] {
	const dir = join(on.fake, "lender", "pi-host-send", from);
	return existsSync(dir) ? readdirSync(dir) : [];
}

/** The one folder of kept pieces on the lender under this machine's name. */
function onlySent(on: Lender): string {
	const [sum, ...more] = sentFrom(on);
	if (sum === undefined || more.length > 0) {
		throw new Error(`expected one kept send, found ${sentFrom(on).length}`);
	}
	return sum;
}

/** What `script` answers given `words`, with the lender's stand-ins. */
async function answer(
	on: Lender,
	script: string,
	words: string[],
	more: NodeJS.ProcessEnv = {},
	cwd = on.fake,
): Promise<{ code: number; out: string; said: string }> {
	const env: NodeJS.ProcessEnv = {
		PATH: `${on.bin}:${process.env.PATH ?? ""}`,
		HOME: on.fake,
		XDG_CACHE_HOME: join(on.fake, "cache"),
		XDG_RUNTIME_DIR: on.fake,
		NIX_OFFLOAD_STORES: `${join(on.fake, "none")}:${on.store}`,
		HOST_SEND_PIECE_BYTES: "1000",
		HOST_SEND_PAUSE: "0",
		HOST_SEND_FROM: ME,
		FAKE: on.fake,
		...more,
	};
	try {
		const { stdout, stderr } = await run("bash", [script, ...words], {
			cwd,
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

describe("host-send-runtime.sh", { timeout: 60_000 }, () => {
	it("sends nothing to a lender that already holds the runtime", async () => {
		const on = lender([BASE, RUNTIME], [BASE, RUNTIME]);

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).toContain("nix-offload-more already holds");
		expect(logged(on, "copied")).toEqual([]);
	});

	it("sends a lender only the paths it lacks, in pieces, and has its nix take them in", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(held(on)).toContain(RUNTIME);
		expect(logged(on, "copied")).toEqual([RUNTIME]);
		expect(answered.said).toContain(`nix-offload-more holds ${RUNTIME}`);
		expect(logged(on, "asked")).toEqual([
			`path-info --recursive -- ${RUNTIME}`,
		]);
		expect(new Set(logged(on, "hosts"))).toEqual(
			new Set(["nix-offload@nix-offload-more"]),
		);
		expect(home(on)).toEqual([]);
		const kept = readdirSync(join(on.fake, "cache", "pi-host", "send"));
		expect(kept.filter((name) => name !== ".lock")).toEqual([]);
	});

	it("sends only the runtime to a lender holding all it refers to, though a cache takes a path only with its references", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(held(on)).toContain(RUNTIME);
		expect(logged(on, "referenced")).toEqual([BASE]);
		expect(logged(on, "copied")).toEqual([RUNTIME]);
		expect(logged(on, "offered")).toEqual([
			"1run.narinfo",
			"nar/1run.nar.xz",
			"nix-cache-info",
		]);
	});

	it("sends a lender lacking the whole closure all of it, compressed, with nothing put in first", async () => {
		const on = lender([BASE, RUNTIME], []);

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(held(on)).toEqual(expect.arrayContaining([BASE, RUNTIME]));
		expect(logged(on, "referenced")).toEqual([]);
		expect(logged(on, "copied")).toEqual([`${BASE} ${RUNTIME}`]);
	});

	it("never sends a path the lender names that isn't in the closure", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "greedy"), "");

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(logged(on, "copied").join("\n")).not.toContain("9secret");
	});

	it("takes a cut-off send up again where it stopped, sending no piece twice", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "allowed"), "2");
		const sent = join(on.fake, "lender", "pi-host-send");
		mkdirSync(join(sent, ME, "0123456789abcdef"), { recursive: true });
		mkdirSync(join(sent, "elsewhere", "0123456789abcdef"), {
			recursive: true,
		});

		const cut = await answer(on, SENDER, [RUNTIME], { HOST_SEND_TRIES: "1" });
		const kept = sentFrom(on);
		rmSync(join(on.fake, "allowed"));
		const resumed = await answer(on, SENDER, [RUNTIME]);

		expect(cut.code, cut.said).toBe(1);
		expect(cut.said).toContain("wouldn't go to nix-offload-more");
		expect(kept).toHaveLength(1);
		expect(kept).not.toContain("0123456789abcdef");
		expect(resumed.code, resumed.said).toBe(0);
		expect(held(on)).toContain(RUNTIME);
		const uploads = logged(on, "uploads");
		expect(uploads.length).toBeGreaterThan(2);
		expect(new Set(uploads).size).toBe(uploads.length);
		expect(logged(on, "copied")).toHaveLength(1);
		expect(sentFrom(on, "elsewhere")).toEqual(["0123456789abcdef"]);
	});

	it("makes and sends the pieces again when those on the lender don't make the cache", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "allowed"), "2");
		await answer(on, SENDER, [RUNTIME], { HOST_SEND_TRIES: "1" });
		const sum = onlySent(on);
		writeFileSync(
			join(on.fake, "lender", "pi-host-send", ME, sum, "pieces", "p.aaaa"),
			"x".repeat(1000),
		);
		rmSync(join(on.fake, "allowed"));

		const mismatched = await answer(on, SENDER, [RUNTIME]);
		const again = await answer(on, SENDER, [RUNTIME]);

		expect(mismatched.code, mismatched.said).toBe(1);
		expect(mismatched.said).toContain("to be made and sent again");
		expect(again.code, again.said).toBe(0);
		expect(held(on)).toContain(RUNTIME);
		expect(logged(on, "copied")).toHaveLength(2);
	});

	it("gives a lender up at once, its folder removed, when it refuses a piece", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "full"), "");

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(1);
		expect(answered.said).toContain("refused p.aaaa (exit 1)");
		expect(logged(on, "uploads")).toEqual(["p.aaaa"]);
		expect(home(on)).toEqual([]);
	});

	it("stops at its deadline, leaving the rest to the next run", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "slow"), "");

		const answered = await answer(on, SENDER, [RUNTIME], {
			HOST_SEND_SECONDS: "2",
		});

		expect(answered.code, answered.said).toBe(1);
		expect(answered.said).toContain("wouldn't go to nix-offload-more");
		expect(logged(on, "uploads").length).toBeLessThanOrEqual(1);
	});

	it("sends nothing when its deadline is 0", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);

		const answered = await answer(on, SENDER, [RUNTIME], {
			HOST_SEND_SECONDS: "0",
		});

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).toContain("HOST_SEND_SECONDS is 0");
		expect(logged(on, "hosts")).toEqual([]);
	});

	it("counts a cache taken in as sent when the link dropped just after", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "lose-import"), "");

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(held(on)).toContain(RUNTIME);
		expect(logged(on, "imports")).toHaveLength(1);
		expect(home(on)).toEqual([]);
	});

	it("keeps the pieces there when the link to the import is lost, so the next run sends none again", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "lose-imports"), "");

		const lost = await answer(on, SENDER, [RUNTIME], { HOST_SEND_TRIES: "1" });
		const uploaded = logged(on, "uploads").length;
		const kept = sentFrom(on);
		rmSync(join(on.fake, "lose-imports"));
		const after = await answer(on, SENDER, [RUNTIME]);

		expect(lost.code, lost.said).toBe(1);
		expect(lost.said).toContain("lost nix-offload-more while its nix took");
		expect(kept).toHaveLength(1);
		expect(after.code, after.said).toBe(0);
		expect(logged(on, "uploads")).toHaveLength(uploaded);
		expect(held(on)).toContain(RUNTIME);
	});

	it("keeps the pieces there when the lender's nix fails for a reason the next run may not meet", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "broken"), "");

		const failed = await answer(on, SENDER, [RUNTIME]);
		const uploaded = logged(on, "uploads").length;
		const sum = onlySent(on);
		const left = readdirSync(join(on.fake, "lender", "pi-host-send", ME, sum));
		const after = await answer(on, SENDER, [RUNTIME]);

		expect(failed.code, failed.said).toBe(1);
		expect(left).toEqual(["pieces"]);
		expect(failed.said).toContain("cannot connect to socket");
		expect(failed.said).toContain("the pieces are kept for the next run");
		expect(after.code, after.said).toBe(0);
		expect(logged(on, "uploads")).toHaveLength(uploaded);
		expect(logged(on, "copied")).toHaveLength(1);
		expect(held(on)).toContain(RUNTIME);
	});

	it("gives a lender up for the week when its nix refuses the cache's signatures", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "refuse"), "");

		const answered = await answer(on, SENDER, [RUNTIME]);
		const uploaded = logged(on, "uploads").length;
		const again = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(1);
		expect(answered.said).toContain("wouldn't take the cache in");
		expect(logged(on, "imports")).toHaveLength(1);
		expect(held(on)).not.toContain(RUNTIME);
		expect(home(on)).toEqual([]);
		expect(again.code, again.said).toBe(1);
		expect(again.said).toContain("refused this cache's signatures this week");
		expect(logged(on, "uploads")).toHaveLength(uploaded);
	});

	it("checks the lender's host key from its store URI, with no known-hosts file of nix-offload's left", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);

		const answered = await answer(on, SENDER, [RUNTIME]);
		const remade = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(remade.fake, "host-key"), "ssh-ed25519 AAAAremade");
		const refused = await answer(remade, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(held(on)).toContain(RUNTIME);
		expect(refused.code, refused.said).toBe(1);
		expect(refused.said).toContain(
			"couldn't ask nix-offload-more what it lacks",
		);
		expect(held(remade)).not.toContain(RUNTIME);
	});

	it("reads a store URI's %-escaped host key as nix does", async () => {
		const hostKey = Buffer.from("ssh-ed25519 AAAAfake").toString("base64");
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(
			on.store,
			`ssh-ng://nix-offload@nix-offload-more?ssh-key=${join(on.fake, "key")}&base64-ssh-public-host-key=${hostKey.replaceAll("=", "%3D")}\n`,
		);

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(held(on)).toContain(RUNTIME);
	});

	it("refuses a lender whose store URI gives no host key", async () => {
		const on = lender([BASE, RUNTIME], [BASE], "ssh-key=/a/key");

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(1);
		expect(answered.said).toContain("gives no host key to check it by");
		expect(logged(on, "hosts")).toEqual([]);
	});

	it("refuses a path that isn't a store path, before reaching any lender", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);

		const answered = await answer(on, SENDER, ["/nix/store/x;rm -rf ~"]);

		expect(answered.code, answered.said).toBe(64);
		expect(answered.said).toContain("isn't a store path");
		expect(logged(on, "hosts")).toEqual([]);
	});

	it("sends a piece again when its copy was cut short", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "cut-once"), "");

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(readdirSync(on.fake)).not.toContain("cut-once");
		expect(held(on)).toContain(RUNTIME);
		const uploads = logged(on, "uploads");
		expect(uploads.filter((name) => name === "p.aaaa")).toHaveLength(2);
	});

	it("sends a piece once when the link drops after it landed whole", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "lose-once"), "");

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		const uploads = logged(on, "uploads");
		expect(new Set(uploads).size).toBe(uploads.length);
		expect(held(on)).toContain(RUNTIME);
	});

	it("leaves the copy to nix-offload when no lender stands", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);

		const answered = await answer(on, SENDER, [RUNTIME], {
			NIX_OFFLOAD_STORES: join(on.fake, "none"),
		});

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).toContain("no lender stands");
		expect(logged(on, "hosts")).toEqual([]);
	});
});

/**
 * host-test-there.sh run against a lender lacking the runtime, with a
 * stand-in nix-offload that notes in $FAKE/there whether the lender had
 * it by the time it ran; `refusing` has the lender's nix refuse it.
 */
async function runner(refusing: boolean) {
	const store = folder(made, "store");
	const runtime = join(store, "1run-runtime");
	mkdirSync(join(runtime, "lib", "node_modules", "pi-monorepo"), {
		recursive: true,
	});
	const profile = folder(made, "profile");
	const tools: string[] = [];
	for (const [at, tool] of TOOLS.entries()) {
		const bin = join(store, `${at}tool-${tool}`, "bin");
		mkdirSync(bin, { recursive: true });
		program(bin, tool, "");
		symlinkSync(join(bin, tool), join(profile, tool));
		tools.push(join(store, `${at}tool-${tool}`));
	}
	const on = lender([BASE, runtime, ...tools], [BASE, ...tools]);
	program(
		on.bin,
		"nix-offload",
		`#!/usr/bin/env bash
grep -qxF "${runtime}" "$FAKE/lender-store" && echo had >> "$FAKE/there" || echo lacked >> "$FAKE/there"
`,
	);
	const key = join(on.fake, ".local", "state", "nix-offload");
	mkdirSync(key, { recursive: true });
	writeFileSync(join(key, "store_ed25519"), "a key\n");
	const checkout = folder(made, "checkout");
	// The machine's own git may sign every commit with a key this throwaway
	// repository has no business using.
	const who = [
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"-c",
		"commit.gpgsign=false",
	];
	await run("git", ["init", "-q"], { cwd: checkout });
	await run("git", [...who, "commit", "-q", "--allow-empty", "-m", "start"], {
		cwd: checkout,
	});
	if (refusing) writeFileSync(join(on.fake, "refuse"), "");

	const answered = await answer(
		on,
		RUNNER,
		[],
		{
			PI_HOST_RUNTIME: runtime,
			HOST_TEST_PROFILES: profile,
			NIX_STORE_DIR: store,
		},
		checkout,
	);
	const there = readFileSync(join(on.fake, "there"), "utf8");
	return { ...answered, there };
}

describe("host-test-there.sh", { timeout: 60_000 }, () => {
	it("sends the runtime to a lender lacking it before nix-offload runs there", async () => {
		const ran = await runner(false);

		expect(ran.code, ran.said).toBe(0);
		expect(ran.there).toBe("had\n");
	});

	it("still runs nix-offload, to copy the runtime itself, when the send fails", async () => {
		const ran = await runner(true);

		expect(ran.code, ran.said).toBe(0);
		expect(ran.said).toContain("nix-offload copies what's left");
		expect(ran.there).toBe("lacked\n");
	});
});
