// A host's store in miniature, run as module source by threads-as-source.test.ts.
//
// Opened as chord opens one, written past the checkpointer's pages and
// kept, then it says whether the thread copied it back or reported a
// failure, whichever comes first. Its arguments are the checkpointer's
// module and the store.
import { DatabaseSync } from "node:sqlite";

const [checkpoints, store] = process.argv.slice(-2);
if (checkpoints === undefined || store === undefined) {
	throw new Error("usage: checkpoint-as-source.mjs CHECKPOINTS STORE");
}
const { checkpointing } = await import(checkpoints);
const db = new DatabaseSync(store);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA wal_autocheckpoint = 0");
db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY, record TEXT)");
const insert = db.prepare("INSERT INTO entry (record) VALUES (?)");
for (let row = 0; row < 40; row++) {
	insert.run("x".repeat(4096));
}
/** @param {Record<string, string>} answer */
const said = (answer) => {
	process.stdout.write(`${JSON.stringify(answer)}\n`);
	process.exit(0);
};
const kept = checkpointing({
	every: 20,
	pages: 8,
	report: (/** @type {unknown} */ error) => said({ reported: String(error) }),
	observe: (/** @type {{ op: string, path: string }} */ event) => {
		if (event.op === "checkpointed") {
			said({ checkpointed: event.path });
		}
	},
}).keep(store);
// Holds the process open until the thread answers; the test's own limit ends a silent one.
setInterval(() => kept, 1000);
