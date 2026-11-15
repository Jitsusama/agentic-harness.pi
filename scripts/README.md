# Scripts

Programs run by hand, by `pnpm`, by a user's merge gate or by the
host: the load check, the merge and host gates, the sensors, the host
rollout tools and one-shot migrators of the quest store.

Many entries because each is run by its path from somewhere outside
this folder: `package.json`, a user's merge-gate setting, the docs and
skills that name them, and the host gate's own match on `scripts/host-*`,
so a subfolder would move what every one of those names.
