# Scripts

Programs run by hand, by `pnpm`, by a user's merge gate or by the
host or a user timer: the load check, the merge and host gates, the
sensors, the host rollout tools, the work-tree sweep a timer runs
outside the hosts, and one-shot migrators of the quest store. One folder,
`ssh-guard/`, holds the stand-ins an agent's shell finds before ssh
while the ssh guard is on, which its own README describes.

Many entries because each is run by its path from somewhere outside
this folder: `package.json`, a user's merge-gate setting, the docs and
skills that name them, and the host gate's own match on `scripts/host-*`,
so a subfolder would move what every one of those names.
