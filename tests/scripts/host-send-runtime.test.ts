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
	readFileSync,
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

/** ssh, running what it's given in the lender's home. */
const SSH = `#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  case $1 in -o|-i|-O) shift 2 ;; -*) shift ;; *) break ;; esac
done
echo "$1" >> "$FAKE/hosts"; shift
if [[ $* == *"cat > "* && -e $FAKE/cut-once ]]; then
  rm "$FAKE/cut-once"
  piece=$(sed -E 's/.*cat > ([^ ]+).*/\\1/' <<< "$*")
  head -c 10 > "$FAKE/lender/$piece"
  exit 255
fi
cd "$FAKE/lender" && HOME="$FAKE/lender" PATH="$FAKE/lender-bin:$PATH" exec bash -c "$*"
`;

/** The lender's nix-store, answering which paths its store lacks. */
const LENDER_NIX_STORE = `#!/usr/bin/env bash
[[ "$1 $2" == "--check-validity --print-invalid" ]] || exit 64
shift 2
for p; do grep -qxF "$p" "$FAKE/lender-store" || echo "$p"; done
`;

/** The lender's nix, taking in a path only from a cache that holds it. */
const LENDER_NIX = `#!/usr/bin/env bash
case $1 in
copy)
  [[ $2 == --from && $4 == --no-recursive ]] || exit 64
  dir=\${3#file://}; shift 4
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
path-info) cat "$FAKE/closure" ;;
copy)
  [[ $2 == --to && $4 == --no-recursive ]] || exit 64
  dir=\${3#file://}; dir=\${dir%%\\?*}; shift 4
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
	const hostKey = Buffer.from("ssh-ed25519 AAAAfake").toString("base64");
	const store = join(fake, "store");
	writeFileSync(
		store,
		`ssh-ng://nix-offload@nix-offload-more?ssh-key=${join(fake, "key")}&base64-ssh-public-host-key=${hostKey}\n`,
	);
	return { fake, bin, store };
}

type Lender = ReturnType<typeof lender>;

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
		NIX_OFFLOAD_STORES: on.store,
		HOST_SEND_PIECE_BYTES: "1000",
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

describe("host-send-runtime.sh", () => {
	it("sends nothing to a lender that already holds the runtime", async () => {
		const on = lender([BASE, RUNTIME], [BASE, RUNTIME]);

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).toContain("nix-offload-more already holds");
		expect(existsSync(join(on.fake, "copied"))).toBe(false);
	});

	it("sends a lender only the paths it lacks, in pieces, and has its nix take them in", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(held(on)).toContain(RUNTIME);
		const copied = readFileSync(join(on.fake, "copied"), "utf8");
		expect(copied).toContain(RUNTIME);
		expect(copied).not.toContain(BASE);
		expect(answered.said).toContain(`nix-offload-more holds ${RUNTIME}`);
		expect(existsSync(join(on.fake, "lender", "pi-host-send"))).toBe(false);
	});

	it("sends a piece again when its copy was cut short", async () => {
		const on = lender([BASE, RUNTIME], [BASE]);
		writeFileSync(join(on.fake, "cut-once"), "");

		const answered = await answer(on, SENDER, [RUNTIME]);

		expect(answered.code, answered.said).toBe(0);
		expect(existsSync(join(on.fake, "cut-once"))).toBe(false);
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

describe("host-test-there.sh", () => {
	it("sends the runtime to a lender lacking it before nix-offload runs there", async () => {
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
		for (const words of [
			["init", "-q"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start"],
		]) {
			await run("git", words, { cwd: checkout });
		}

		const answered = await answer(
			on,
			RUNNER,
			[],
			{ PI_HOST_RUNTIME: runtime, HOST_TEST_PROFILES: profile },
			checkout,
		);

		expect(answered.code, answered.said).toBe(0);
		expect(readFileSync(join(on.fake, "there"), "utf8")).toBe("had\n");
	});
});
