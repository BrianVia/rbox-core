# Incident 2026-07-21 evening: one SIGTERM, five auto-heal failures

Timeline anchors (all UTC, founder's Mac, workspace ~/Development, repo Dfinitiv/savvy-core = main clone + ~8 linked worktrees, Conductor agents active in worktrees all evening):

- 17:34:13 `rbox stop` SIGTERMs the daemon mid-apply. EXACTLY this second, ~140 ref lock files appear: one per branch/tag + stash.lock under savvy-core/.git/refs/. The daemon's own apply was mid-mass-ref-transaction.
- 17:34-23:36: every receiver apply for the savvy-core family defers "git busy" (the busy probe correctly sees the stale locks; nothing ever cleans them). Deferral records accumulate (up to 10 repos incl. worktree repos).
- 23:20:38 push pump halts: "push: too many conflicts, remote is moving faster than we can reconcile" count=13 (base couldn't advance because applies were deferred → pushes perpetually stale-parented → lost 13 races to the peer's echoes → halt).
- 23:37 (operator) stale locks manually deleted. Applies immediately succeed (git-sync followed at 23:39/23:41/23:43).
- 23:45 status STILL shows "sync halted" + "10 git repos need attention".

Founder's standard (verbatim): "shouldn't we more or less be able to auto heal from transient past hiccups if our software is robust... if rbox can't get itself back into a naturally healthy state, why not? That's the ultimate goal."

Evidence files here: mac-daemon-0721.log (full day), mac-activity.json (persisted activity incl. halt record).
