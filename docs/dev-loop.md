# Local dev loop

Use `rbox-dev` when you want to test this checkout as a real compiled CLI on
your own machine:

```sh
<edit code>
bun run dev:install
rbox-dev stop && rbox-dev start  # in the workspace
```

The installer builds only the host target and writes `~/.local/bin/rbox-dev` by
default. Use `bun run dev:install -- --outfile ./rbox-dev-test` when you want a
temporary binary somewhere else.

For a zero-build loop, run the CLI from source:

```sh
bun run src/cli/index.ts <cmd>
```

That path also spawns daemons correctly: under `bun run`, `process.execPath` is
Bun, so daemon startup keeps the script path in the child argv.

You still need a real release build when testing second-machine installs through
`install.sh`, testing `rbox upgrade` itself, or validating the signed release
manifest and published artifacts.
