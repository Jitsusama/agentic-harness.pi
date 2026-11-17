/**
 * host-send-runtime.sh as host-test-there.sh runs it, against a stand-in
 * lender: ssh runs the remote command in a folder of the test's own, as
 * the lender's home, where a stand-in nix keeps a list as its store and
 * takes a path in only from a cache holding its narinfo. A stand-in nix
 * here answers the closure and writes the cache. The lender is named the
 * way nix-offload names it, by a store URI in a file.
 */

import { execFile } from "node:child_process";
import {
	chmodSync,
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
/** The tools test:host's words name, each a program in a store folder. */
const TOOLS = ["bash", "mycelium", "fd", "rg", "script"] as const;
/** A store path the lender has from the start, as its system's. */
const BASE = "/nix/store/0base-glibc";

const made: string[] = [];
afterEach(() => removeAll(made));

/**
 * ssh, running what it's given in the lender's home, and refusing, as a
 * lender remade with a new host key is refused, unless it's told to check
 * the host key strictly against a file naming the lender's alias with the
 * key its store URI gives: nix-offload removes its own known-hosts file
 * when each run ends, so a send can't lean on that. Each piece it carries
 * is named in $FAKE/uploads. Given $FAKE/allowed, it carries that many
 * pieces and then loses every connection that sends one; given
 * $FAKE/cut-once, it leaves 10 bytes of one piece under its name and says
 * it went; given $FAKE/lose-once, it carries one piece whole and then
 * loses its connection, as a link dropped after the copy; given
 * $FAKE/full, the lender refuses pieces; given $FAKE/slow, each piece
 * takes 3 s; given $FAKE/lose-import, the connection is lost once the
 * lender's nix took the cache in. It's refused unless it's given the
 * store URI's key.
 */
const SSH = `#!/usr/bin/env bash
known= alias= strict= ident=
while [[ $# -gt 0 ]]; do
  case $1 in
  -o)
    case $2 in
    UserKnownHostsFile=*) known=\${2#*=} ;;
    HostKeyAlias=*) alias=\${2#*=} ;;
    StrictHostKeyChecking=yes) strict=1 ;;
    esac
    shift 2 ;;
  -i) ident=$2; shift 2 ;;
  -*) shift ;;
  *) break ;;
  esac
done
if [[ $ident != "$FAKE/key" || -z $strict || -z $alias ]] || ! grep -qxF "$alias $(cat "$FAKE/host-key")" "$known" 2> /dev/null; then
  echo "Host key verification failed." >&2
  exit 255
fi
echo "$1" >> "$FAKE/hosts"; shift
there() { cd "$FAKE/lender" && HOME="$FAKE/lender" PATH="$FAKE/lender-bin:$PATH" bash -c "$*"; }
if [[ $* == *"cat > "* ]]; then
  part=$(sed -E 's/.*cat > ([^ ]+).*/\\1/' <<< "$*")
  if [[ -e $FAKE/allowed ]]; then
    left=$(cat "$FAKE/allowed")
    [[ $left -gt 0 ]] || exit 255
    echo $((left - 1)) > "$FAKE/allowed"
  fi
  piece=\${part##*/}
  echo "\${piece%.part}" >> "$FAKE/uploads"
  [[ ! -e $FAKE/full ]] || { echo "No space left on device" >&2; exit 1; }
  [[ ! -e $FAKE/slow ]] || sleep 3
  if [[ -e $FAKE/cut-once ]]; then
    rm "$FAKE/cut-once"
    head -c 10 > "$FAKE/lender/\${part%.part}"
    exit 0
  fi
  if [[ -e $FAKE/lose-once ]]; then
    rm "$FAKE/lose-once"
    there "$@"
    exit 255
  fi
fi
if [[ $* == *"nix copy --from"* && -e $FAKE/lose-import ]]; then
  rm "$FAKE/lose-import"
  there "$@"
  exit 255
fi
there "$@"
`;

/** The lender's nix-store, answering which paths its store lacks. */
const LENDER_NIX_STORE = `#!/usr/bin/env bash
[[ "$1 $2" == "--check-validity --print-invalid" ]] || exit 64
shift 2
for p; do grep -qxF "$p" "$FAKE/lender-store" || echo "$p"; done
[[ ! -e $FAKE/greedy ]] || echo /nix/store/9secret-keys
`;

/** The lender's nix, taking in a path only from a cache that holds it. */
const LENDER_NIX = `#!/usr/bin/env bash
case $1 in
copy)
  [[ $2 == --from && $4 == --no-recursive ]] || exit 64
  dir=\${3#file://}; shift 4
  echo "$*" >> "$FAKE/imports"
  [[ ! -e $FAKE/refuse ]] || { echo "lacks a signature by a trusted key" >&2; exit 1; }
  for p; do
    h=$(basename "$p"); h=\${h%%-*}
    [[ -s $dir/$h.narinfo ]] || { echo "no $p in $dir" >&2; exit 1; }
    echo "$p" >> "$FAKE/lender-store"
  done ;;
path-info)
  shift
  for p; do grep -qxF "$p" "$FAKE/lender-store" || exit 1; done ;;
*) exit 64 ;;
esac
`;

/** This machine's nix: the closure, and a file cache of the paths given. */
const NIX = `#!/usr/bin/env bash
case $1 in
path-info) echo "$*" >> "$FAKE/asked"; cat "$FAKE/closure" ;;
copy)
  [[ $2 == --to && $4 == --no-recursive ]] || exit 64
  dir=\${3#file://}; dir=\${dir%%\\?*}; shift 4
  [[ $1 != -- ]] || shift
  mkdir -p "$dir/nar"
  echo "StoreDir: /nix/store" > "$dir/nix-cache-info"
  for p; do
    h=$(basename "$p"); h=\${h%%-*}
    echo "StorePath: $p" > "$dir/$h.narinfo"
    head -c 3000 /dev/urandom > "$dir/nar/$h.nar.xz"
  done
  echo "$*" >> "$FAKE/copied" ;;
*) exit 64 ;;
esac
`;

/** Writes `text` to `bin`/`name` as a program. */
function program(bin: string, name: string, text: string): void {
	writeFileSync(join(bin, name), text);
	chmodSync(join(bin, name), 0o755);
}

/**
 * A stand-in lender holding `held`, this machine's closure `closure`, and
 * the store file nix-offload writes while the lender stands.
 */
function lender(closure: string[], held: string[]) {
	const fake = folder(made, "fake");
	mkdirSync(join(fake, "lender"));
	const bin = join(fake, "bin");
	const lenderBin = join(fake, "lender-bin");
	mkdirSync(bin);
	mkdirSync(lenderBin);
	program(bin, "ssh", SSH);
	program(bin, "nix", NIX);
	program(lenderBin, "nix", LENDER_NIX);
	program(lenderBin, "nix-store", LENDER_NIX_STORE);
	writeFileSync(join(fake, "closure"), `${closure.join("\n")}\n`);
	writeFileSync(join(fake, "lender-store"), `${held.join("\n")}\n`);
	writeFileSync(join(fake, "key"), "a key\n");
	writeFileSync(join(fake, "host-key"), "ssh-ed25519 AAAAfake");
	const hostKey = Buffer.from("ssh-ed25519 AAAAfake").toString("base64");
	const store = join(fake, "store");
	writeFileSync(
		store,
		`ssh-ng://nix-offload@nix-offload-more?ssh-key=${join(fake, "key")}&base64-ssh-public-host-key=${hostKey}\n`,
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

const RUNTIME = "/nix/store/1run-pi-host-runtime-1.5.0";

describe("host-send-runtime.sh", { timeout: 60_000 }, () => {
	it("sends nothing to a lender that already holds the runtime", async () => {
		const on = lender([BASE, RUNTIME], [BASE, RUNTIME]);

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).toContain("nix-offload-more already holds");
		expect(existsSync(join(on.fake, "copied"))).toBe(false);
	});

	it("sends a lender only the paths it lacks, in pieces, and has its nix take them in", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		const other = join(on.fake, "lender", "pi-host-send", "0123456789abcdef");
		mkdirSync(join(other, "pieces"), { recursive: true });
		writeFileSync(join(other, "pieces", "p.aaaa"), "x".repeat(1000));

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(held(on)).toContain(RUNTIME);
		const copied = readFileSync(join(on.fake, "copied"), "utf8");
		expect(copied).toContain(RUNTIME);
		expect(copied).not.toContain(BASE);
		expect(answered.said).toContain(`nix-offload-more holds ${RUNTIME}`);
		expect(logged(on, "asked")).toEqual([`--recursive -- ${RUNTIME}`]);
		expect(new Set(logged(on, "hosts"))).toEqual(
			new Set(["nix-offload@nix-offload-more"]),
		);
		expect(existsSync(join(on.fake, "lender", "pi-host-send"))).toBe(false);
		const kept = readdirSync(join(on.fake, "cache", "pi-host", "send"));
		expect(kept.filter((name) => name !== ".lock")).toEqual([]);
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

		const cut = await answer(on, SENDER, [RUNTIME], { HOST_SEND_TRIES: "1" });
		rmSync(join(on.fake, "allowed"));
		const resumed = await answer(on, SENDER, [RUNTIME]);

		expect(cut.code, cut.said).toBe(1);
		expect(cut.said).toContain("the next run takes it up");
		expect(resumed.code, resumed.said).toBe(0);
		expect(held(on)).toContain(RUNTIME);
		const uploads = logged(on, "uploads");
		expect(uploads.length).toBeGreaterThan(2);
		expect(new Set(uploads).size).toBe(uploads.length);
		expect(logged(on, "copied")).toHaveLength(1);
	});

	it("makes and sends the pieces again when those on the lender don't make the cache", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "allowed"), "2");
		await answer(on, SENDER, [RUNTIME], { HOST_SEND_TRIES: "1" });
		const sent = join(on.fake, "lender", "pi-host-send");
		const [sum] = readdirSync(sent);
		writeFileSync(join(sent, sum, "pieces", "p.aaaa"), "x".repeat(1000));
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
		expect(existsSync(join(on.fake, "lender", "pi-host-send"))).toBe(false);
	});

	it("stops at its deadline, leaving the rest to the next run", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "slow"), "");

		const answered = await answer(on, SENDER, [RUNTIME], {
			HOST_SEND_SECONDS: "2",
		});

		expect(answered.code, answered.said).toBe(1);
		expect(answered.said).toContain("the next run takes it up");
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
		expect(existsSync(join(on.fake, "lender", "pi-host-send"))).toBe(false);
	});

	it("gives a lender up at once when its nix refuses the cache", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "refuse"), "");

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(1);
		expect(answered.said).toContain("wouldn't take the cache in");
		expect(logged(on, "imports")).toHaveLength(1);
		expect(held(on)).not.toContain(RUNTIME);
		expect(existsSync(join(on.fake, "lender", "pi-host-send"))).toBe(false);
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
		expect(refused.said).toContain("Host key verification failed");
		expect(refused.said).toContain(
			"couldn't ask nix-offload-more what it lacks",
		);
		expect(held(remade)).not.toContain(RUNTIME);
	});

	it("sends a piece again when its copy was cut short", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "cut-once"), "");

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(existsSync(join(on.fake, "cut-once"))).toBe(false);
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
		expect(existsSync(join(on.fake, "hosts"))).toBe(false);
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
	const who = ["-c", "user.name=t", "-c", "user.email=t@t"];
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
