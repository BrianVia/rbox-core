# CLI fixes implementation notes

## Fix 1: `rbox track --name`

- Found: the create-new path in `src/cli/track-cmd.ts` forwarded the remote URL,
  token, and project to `createRemoteWorkspace`, but omitted its existing optional
  `name` argument. No sibling flag was dropped on that call path.
- Changed: forward `flags.name` to the remote workspace-create boundary.
- Tested: `src/cli/track-untrack.test.ts` now drives the non-interactive create-new
  path with environment credentials and asserts the exact encoded request URL.
