/**
 * Remote Check Interceptor Extension
 *
 * Sends a session's VM checks of a public repository to the lent
 * builder by commit: a step building `nix build --no-link` of a flake's
 * checks becomes `nix-offload there <flake> <checks>` in its own place,
 * the flake `github:<owner>/<repo>/<rev>` for a clean tree whose HEAD a
 * remote has, and the tree itself for any other where `there` takes
 * one, sending only the commits GitHub lacks. A `run-subtests` step
 * becomes `run-subtests --there` where `there` can build it. The builder
 * fetches the rest itself, so nothing built here is uploaded, and the
 * machine queue gives the step no turn here. Anything else runs as
 * written. Repositories are named in the package config's
 * `remote-checks.repos`; none are by default.
 *
 * Where a call runs is decided once for it in the library (send.ts),
 * which the mesh reads too; this applies it.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { whereItRuns } from "../../lib/internal/priority/send.ts";

export default function remoteCheckInterceptor(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const sent = await whereItRuns(
			event.toolCallId,
			event.input.command,
			ctx.cwd,
			ctx.signal,
		);
		if (sent !== undefined) {
			(event.input as { command: string }).command = sent;
		}
		return undefined;
	});
}
