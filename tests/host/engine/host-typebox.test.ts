/**
 * The host's protocol, checked by the TypeBox its pi holds. The harness's
 * sources are copied where none of the harness's node_modules can be
 * found and run under plain node with the resolve hook pi-host.ts
 * registers. With a bundle, every typebox module they load must be the
 * bundle's host module, the very copy pi hands its extensions, and never
 * a node_modules copy, pi's own included; without one, pi's own copy.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hostPiBundle } from "../../../host/engine/host-pi.ts";
import { hostPiFor } from "../end-to-end/support/host-pi.ts";

const HARNESS = resolve(import.meta.dirname, "../../..");
/** A node process loading the protocol, given a while on a loaded machine. */
const ONE_PROCESS_MS = 60_000;

/** The host's pi, found again for each case, which skips or fails without one. */
let packageDir = "";
/** The harness's sources, copied outside its tree. */
let copy = "";
beforeEach(({ skip }) => {
	packageDir = hostPiFor(skip);
	copy = mkdtempSync(join(tmpdir(), "host-protocol-"));
	for (const part of ["host", "lib", "data", "package.json"])
		cpSync(join(HARNESS, part), join(copy, part), { recursive: true });
});
afterEach(() => {
	rmSync(copy, { recursive: true, force: true });
});

/** What a plain node process saw, loading the copied protocol with the host's hook or without it. */
function loadProtocol(hooked: boolean) {
	const script = `
		import { registerHooks } from "node:module";
		import { pathToFileURL } from "node:url";
		const { COPY, PI, HOOKED, BUNDLED } = process.env;
		const loaded = [];
		registerHooks({
			load(url, context, next) {
				loaded.push(url);
				return next(url, context);
			},
		});
		if (HOOKED) {
			const { piFromHost } = await import(pathToFileURL(COPY + "/host/service/pi-resolution.ts").href);
			registerHooks({ resolve: piFromHost(PI) });
		}
		const protocol = await import(pathToFileURL(COPY + "/host/service/protocol.ts").href);
		const refusal = (parse, value) => {
			try {
				parse(value);
				return "accepted";
			} catch (error) {
				return error.message;
			}
		};
		const close = { v: 1, id: "c", op: "close", sessionId: "11111111-1111-4111-8111-111111111111" };
		const accepted = protocol.parseControl(close).op;
		const refused = [
			refusal(protocol.parseControl, { ...close, id: "" }),
			refusal(protocol.parseWatchLine, { type: "nothing" }),
		];
		// The checker the protocol compiled, against the compiler pi hands extensions.
		const handedCompile = BUNDLED
			? (await import(pathToFileURL(PI + "/dist/bundle/host.js").href)).VIRTUAL_MODULES["typebox/compile"]
			: await import(pathToFileURL(PI + "/node_modules/typebox/build/compile/index.mjs").href);
		const pi = pathToFileURL(PI).href;
		const typeboxLoaded = loaded.filter((url) => url.includes("/typebox"));
		console.log(JSON.stringify({
			accepted,
			refused,
			piCompiled: protocol.checkerOf(protocol.identities.host) instanceof handedCompile.Validator,
			hostModules: typeboxLoaded.filter((url) => url.startsWith(pi + "/dist/bundle/host-modules/")).length > 0,
			piTypebox: typeboxLoaded.filter((url) => url.startsWith(pi + "/node_modules/typebox/")).length > 0,
			typeboxOutside: typeboxLoaded.filter((url) => !url.startsWith(pi)),
			packagesOutside: loaded.filter((url) => url.includes("/node_modules/") && !url.startsWith(pi)),
		}));
	`;
	return spawnSync(
		process.execPath,
		["--no-warnings", "--input-type=module", "-e", script],
		{
			cwd: copy,
			encoding: "utf8",
			timeout: ONE_PROCESS_MS,
			env: {
				PATH: process.env.PATH,
				HOME: copy,
				COPY: copy,
				PI: packageDir,
				...(hooked ? { HOOKED: "1" } : {}),
				...(existsSync(hostPiBundle(packageDir)) ? { BUNDLED: "1" } : {}),
			},
		},
	);
}

it(
	"checks the host's protocol with the TypeBox its pi hands extensions, loading no other copy",
	() => {
		const bundled = existsSync(hostPiBundle(packageDir));
		const run = loadProtocol(true);
		expect(run.status, run.stderr).toBe(0);
		expect(JSON.parse(run.stdout)).toEqual({
			accepted: "close",
			refused: ["Invalid host control request", "Invalid child watch line"],
			piCompiled: true,
			hostModules: bundled,
			piTypebox: !bundled,
			typeboxOutside: [],
			packagesOutside: [],
		});
	},
	ONE_PROCESS_MS,
);

it(
	"finds no typebox in the copy without the host's hook, so the hook is what gave it one",
	() => {
		const run = loadProtocol(false);
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("Cannot find package 'typebox'");
	},
	ONE_PROCESS_MS,
);
