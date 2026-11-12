/**
 * Records one parity scenario on one side, plain pi or the host, in a
 * folder of its own: a home, runtime folder, temp folder and working
 * folder, the scripted provider's requests, and every event the probe
 * heard. The process gets only the environment written here, so nothing of
 * the session running the test reaches it.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type MockProvider,
	mockProvider,
	type ProviderRequest,
	type Scenario,
} from "./mock-provider.ts";
import { type Launch, rpcClient } from "./rpc-client.ts";

/** Which side a recording is of. */
export type Side = "pi" | "hosted";

/** What a recording saw. */
export interface Recording {
	readonly dir: string;
	readonly requests: readonly ProviderRequest[];
	readonly trace: readonly Readonly<Record<string, unknown>>[];
}

const PROBE = fileURLToPath(new URL("parity-probe.mts", import.meta.url));
const HOSTED = fileURLToPath(new URL("hosted-rpc.mts", import.meta.url));

/** The settings both sides start with: no automatic compaction or retry, so every request is the script's. */
const SETTINGS = {
	compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 0 },
	retry: { enabled: false },
};

/** Record `scenario` on `side` under `root`, loading `extensions` from pi's install at `packageDir`. */
export async function record(options: {
	readonly root: string;
	readonly side: Side;
	readonly scenario: Scenario;
	readonly packageDir: string;
	readonly extensions: readonly string[];
}): Promise<Recording> {
	const { side, scenario } = options;
	const dir = join(options.root, side, scenario);
	const home = join(dir, "home");
	const cwd = join(dir, "repo");
	const tmp = join(dir, "tmp");
	for (const path of [
		cwd,
		tmp,
		join(dir, "runtime"),
		join(home, ".pi", "agent"),
	])
		mkdirSync(path, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(home, ".pi", "agent", "settings.json"),
		JSON.stringify(SETTINGS),
	);
	writeFileSync(join(cwd, "fixture.txt"), "Parity fixture.\n");
	const probe = join(dir, "probe.ts");
	copyFileSync(PROBE, probe);
	const trace = join(dir, "trace.ndjson");
	const mock = await mockProvider(join(dir, "requests.ndjson"), scenario);
	writeFileSync(
		join(cwd, "parity.json"),
		JSON.stringify({ endpoint: mock.endpoint, trace }),
	);
	const env = {
		HOME: home,
		XDG_RUNTIME_DIR: join(dir, "runtime"),
		TMPDIR: tmp,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PATH: process.env.PATH ?? "",
		LANG: "C.UTF-8",
		WORKTRAIL_LEDGER: join(dir, "ledger.ndjson"),
	};
	const extensions = [...options.extensions, probe];
	const launch =
		side === "pi"
			? piLaunch(options.packageDir, join(dir, "sessions"), extensions)
			: hostedLaunch(
					options.packageDir,
					cwd,
					join(tmp, "host-state"),
					extensions,
				);
	const rpc = rpcClient(launch, cwd, env, join(dir, "rpc.ndjson"));
	try {
		await drive(scenario, rpc, mock);
	} finally {
		await rpc.close();
		await mock.close();
	}
	return {
		dir,
		requests: mock.requests,
		trace: readFileSync(trace, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
	};
}

/** Play the scenario's part: the prompts, steers, aborts and commands a person would send. */
async function drive(
	scenario: Scenario,
	rpc: ReturnType<typeof rpcClient>,
	mock: MockProvider,
): Promise<void> {
	await rpc.request({ type: "get_state" });
	if (scenario === "command") {
		await rpc.request({ type: "prompt", message: "/parity-ping fixture" });
		return;
	}
	if (scenario === "steer" || scenario === "abort") {
		const settled = rpc.wait((event) => event.type === "agent_settled");
		// Awaited below; a refusal before then is the requests' to report.
		settled.catch(() => undefined);
		await rpc.request({ type: "prompt", message: "Record parity fixture." });
		await mock.held();
		await rpc.request(
			scenario === "steer"
				? { type: "steer", message: "Steering instruction: retain fixture." }
				: { type: "abort" },
		);
		mock.release();
		await settled;
		return;
	}
	await rpc.prompt("Record parity fixture.");
	if (scenario === "compaction") {
		await rpc.request({
			type: "compact",
			customInstructions: "Retain the fixture.",
		});
		await rpc.prompt("Continue after compaction.");
	}
}

/** Plain pi from the install, on the same resource profile as the host: these extensions alone, nothing discovered. */
function piLaunch(
	packageDir: string,
	sessionDir: string,
	extensions: readonly string[],
): Launch {
	return {
		command: process.execPath,
		args: [
			piCommand(packageDir),
			"--mode",
			"rpc",
			"--no-extensions",
			"-ns",
			"-np",
			"-nc",
			"--no-mcp",
			"--model",
			"parity/mock",
			"--thinking",
			"off",
			"--session-dir",
			sessionDir,
			...extensions.flatMap((path) => ["-e", path]),
		],
	};
}

/** The host over the same install, its one conversation shown through pi's RPC mode. */
function hostedLaunch(
	packageDir: string,
	cwd: string,
	stateDir: string,
	extensions: readonly string[],
): Launch {
	return {
		command: process.execPath,
		args: [
			"--no-warnings",
			HOSTED,
			JSON.stringify({ packageDir, stateDir, cwd, extensions }),
		],
	};
}

/** The install's pi command, as its package names it. */
function piCommand(packageDir: string): string {
	const manifest: unknown = JSON.parse(
		readFileSync(join(packageDir, "package.json"), "utf8"),
	);
	const bin =
		manifest !== null && typeof manifest === "object"
			? Reflect.get(manifest, "bin")
			: undefined;
	const pi =
		bin !== null && typeof bin === "object"
			? Reflect.get(bin, "pi")
			: undefined;
	if (typeof pi !== "string")
		throw new Error(`${packageDir}'s package names no pi command`);
	return join(packageDir, pi);
}
