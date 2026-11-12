# Codemode Workflow

Stops a codemode script from holding the session. A script still
running after a minute moves to the background: the agent gets its turn
back, hears the person and the mesh again, and the script's result
arrives later as a message of its own.

## Why

pi lets the person's words and the mesh's messages in only between tool
calls. On 11 November 270 codemode scripts held their sessions for more
than a minute, at the median for two and a half minutes and the longest
for seven and a half hours. Most were loops of short bash calls and mesh
reads waiting on something, which slip past
[shell-workflow](../shell-workflow/)'s hand-off, since a call a script
makes has to answer the script.

## How It Works

The tool is pi's own codemode, built the way pi's built-in extension
builds it, so its sandbox, loadout, description and rendering are pi's.
It is registered under the name `codemode` from this package, which
loads before pi's built-in extensions, and pi takes the first tool
registered under a name.

What it adds is the wait. A script that ends within a minute answers as
it always did. One still running then becomes a job of kind `codemode`
(see [job-workflow](../job-workflow/)): the call answers with its job's
id and the script's last output, and the job says how the script ended,
its last lines and where the rest is kept. `/jobs` or the jobs tool
stops it, and so does its session ending.

A run that ends with its prompts (`pi -p` and JSON mode, as subagents
run) never hands off, since nobody would be there to hear the result.

While handed off, the script's own calls keep running beside the
session's next turn, as a background command's do. The model is told
not to run anything that changes what the script is working on. A
handed-off script keeps its sandbox worker, and pi runs at most two in
a process (`PI_CODEMODE_MAX_WORKERS` raises it), so a third script
waits for one to end, failing if none frees within a minute.
