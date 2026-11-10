// One hosted conversation on this tree's engine, with pi's own RPC mode as its screen, run by node as the host runs: the parity test's other side.
/**
 * Run as `node hosted-rpc.mts <config JSON>`, the config naming the host's
 * pi, a state folder, the working folder and the extensions to load. The
 * engine loads them as pi's `-e` does, with pi's discovery off as the test
 * turns it off for plain pi, and pi's RPC mode binds them as it would in
 * plain pi, so the host implements no RPC command or event of its own.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEngine } from "../../../host/engine/engine.ts";
import { SessionHost } from "../../../host/engine/session-host.ts";

/** What the test passes. */
interface Config {
	readonly packageDir: string;
	readonly stateDir: string;
	readonly cwd: string;
	readonly extensions: readonly string[];
}

/** What the host uses of pi's RPC mode. */
interface RpcMode {
	runRpcMode(runtime: unknown): Promise<never>;
}

const config: Config = JSON.parse(process.argv[2] ?? "{}");
const { runRpcMode } = piModule<RpcMode>(
	await import(pathToFileURL(join(config.packageDir, "dist", "index.js")).href),
);

/** A pi module as this uses it: pi's JavaScript carries no types here, so the shape is declared above. */
function piModule<T>(module: unknown): T {
	return module as T;
}

const host = new SessionHost({
	key: `parity-${process.pid}`,
	owner: { pid: process.pid, startedAt: Date.now() },
	registryDir: join(config.stateDir, "registry"),
});
const engine = await createEngine({
	packageDir: config.packageDir,
	stateDir: config.stateDir,
	host,
	env: Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	),
	resources: {
		extensions: config.extensions,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		disabledBuiltinExtensions: ["mcp"],
	},
	screens: {
		// pi's RPC mode binds the extensions, as a screen does, and never returns.
		opened: (view) => {
			host
				.run(view.sessionId, () => runRpcMode(view.runtime))
				.catch((error: unknown) => {
					process.stderr.write(`${String(error)}\n`);
					process.exit(1);
				});
		},
		rebound: () => undefined,
		closed: () => undefined,
	},
	report: (error) => process.stderr.write(`host: ${String(error)}\n`),
});
const request = {
	v: 1 as const,
	id: "parity-open",
	op: "open" as const,
	cwd: config.cwd,
	attended: false,
	model: { provider: "parity", id: "mock" },
	thinkingLevel: "off" as const,
};
await engine.start(await engine.prepare(request), request);
