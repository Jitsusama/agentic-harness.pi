// pi-fence's child as pi-fence runs it and ends with it, run by node for tests/scripts/pi-fence.test.ts.
import {
	endAs,
	runForwarding,
} from "../../../lib/internal/fence/fence-child.ts";

const [text = "true"] = process.argv.slice(2);
endAs(await runForwarding(text, process.cwd()));
