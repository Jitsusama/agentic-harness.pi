/**
 * The host's protocol, checked by the TypeBox its pi's bundle holds. The
 * harness's sources are copied where none of the harness's node_modules
 * can be found, as an install's are, and run under plain node with the
 * resolve hook pi-host.ts registers: every typebox module they load must
 * be the bundle's, the very one pi hands its extensions, and nothing may
 * load from a node_modules outside the host's pi.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
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
		const { COPY, PI, HOOKED } = process.env;
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
		const close = { v: 1, id: "c", op: "close", sessionId: "11111111-1111-4111-8111-111111111111" };
		let refused = "";
		try {
			protocol.parseControl({ ...close, id: "" });
		} catch (error) {
			refused = error.message;
		}
		const { VIRTUAL_MODULES: handed } = await import(pathToFileURL(PI + "/dist/bundle/host.js").href);
		const { Type } = await import("typebox");
		const { Value } = await import("typebox/value");
		const { Compile } = await import("typebox/compile");
		const pi = pathToFileURL(PI).href;
		console.log(JSON.stringify({
			accepted: protocol.parseControl(close).op,
			refused,
			bundles:
				Type === handed.typebox.Type &&
				Value === handed["typebox/value"].Value &&
				Compile === handed["typebox/compile"].Compile,
			typeboxOutside: loaded.filter((url) => url.includes("/typebox") && !url.startsWith(pi)),
			packagesOutside: loaded.filter((url) => url.includes("/node_modules/") && !url.startsWith(pi)),
		}));
	`;
	const run = spawnSync(
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
			},
		},
	);
	return run;
}

it(
	"checks the host's protocol with the TypeBox its pi's bundle hands extensions, loading none of the harness's",
	() => {
		const run = loadProtocol(true);
		expect(run.status, run.stderr).toBe(0);
		expect(JSON.parse(run.stdout)).toEqual({
			accepted: "close",
			refused: "Invalid host control request",
			bundles: true,
			typeboxOutside: [],
			packagesOutside: [],
		});
	},
	ONE_PROCESS_MS,
);

it(
	"finds no typebox at all without the host's hook, so nothing beside the host's pi supplies one",
	() => {
		const run = loadProtocol(false);
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("Cannot find package 'typebox'");
	},
	ONE_PROCESS_MS,
);
