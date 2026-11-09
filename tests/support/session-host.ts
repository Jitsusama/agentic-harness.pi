/** A two-conversation host for tests of reload-safe session state. */
import {
	type Host,
	installHost,
	releaseSession,
	type SessionEnvironment,
} from "../../lib/core/session/index.ts";

/** Install an in-process host; closing a conversation releases only its slots. */
export function installTestHost() {
	const open = new Set(["a", "b"]);
	const environments = new Map<string, SessionEnvironment>();
	const host: Host = {
		kind: "pi-durable",
		key: "test-host",
		owner: { pid: process.pid, startedAt: Date.now() },
		holds: (id) => (open.has(id) ? "idle" : undefined),
		env(id) {
			let env = environments.get(id);
			if (!env) {
				const values: NodeJS.ProcessEnv = {};
				env = {
					get: (name) => values[name],
					set(name, value) {
						values[name] = value;
					},
					delete(name) {
						delete values[name];
					},
					snapshot: () => ({ ...values }),
				};
				environments.set(id, env);
			}
			return env;
		},
		hints: () => ({}),
		close(id) {
			open.delete(id);
			environments.delete(id);
			releaseSession(id);
		},
		stamp: () => {},
	};
	const uninstall = installHost(host);
	return {
		host,
		dispose() {
			host.close("a", "test cleanup");
			host.close("b", "test cleanup");
			uninstall();
		},
	};
}
