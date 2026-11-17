/**
 * Drain one of the realm's hosts for a restart, or lift its drain
 * (host/service/README.md): while drained each conversation parks as
 * soon as its park rule holds, a wake by file or steer waits for the
 * lift or for the host's own restart to pass its settle ceiling, and a
 * heavy run (a build, a check, a suite) holds the host's
 * restart. Node runs it as it stands, stripping the types:
 *
 *   node scripts/host-drain.ts (attended|background) (on|off) [--by NAME]
 *
 * Prints how the conversations stand and the heavy runs going, so a
 * hand restart waits until it says none. Exits 0 once the host answered.
 */

import { parseArgs } from "node:util";
import { hostRealm, hostSocketPath } from "../host/service/address.ts";
import { drainHost } from "../host/service/client.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { by: { type: "string", default: "scripts/host-drain.ts" } },
});
const [kind, switched] = positionals;
if (
	(kind !== "attended" && kind !== "background") ||
	(switched !== "on" && switched !== "off")
)
	throw new Error(
		"Usage: node scripts/host-drain.ts (attended|background) (on|off) [--by NAME]",
	);

const result = await drainHost(
	hostSocketPath(hostRealm(process.env), kind),
	switched === "on",
	values.by,
);
console.log(JSON.stringify(result, null, 2));
