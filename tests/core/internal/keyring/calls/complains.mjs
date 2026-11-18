// A keyring call that fails before it can answer, saying why only on stderr, as node does when the program won't run.
for await (const _ of process.stdin);
process.stderr.write("the call could not start\n");
process.exitCode = 3;
