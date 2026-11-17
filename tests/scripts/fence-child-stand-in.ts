// pi-fence's child as pi-fence runs it, for tests/scripts/pi-fence.test.ts.
import { runForwarding } from "../../lib/internal/fence/fence-child.ts";

const [text = "true"] = process.argv.slice(2);
const end = await runForwarding(text, process.cwd());
if ("error" in end) process.stderr.write(`${end.error}\n`);
process.exit("error" in end ? 126 : end.code);
