// A keyring call that answers with a line that isn't JSON.
for await (const _ of process.stdin);
process.stdout.write("not an answer\n");
