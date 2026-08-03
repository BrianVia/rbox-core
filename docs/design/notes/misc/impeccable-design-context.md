## Design Context

### Users

rbox serves developers and GitHub-capable non-developers who want their working
directories to stay continuously available across computers without learning
sync-engine, Git-internals, or encryption terminology. They are usually setting
up from a terminal and want to reach the first successful cross-machine sync
quickly. The onboarding “aha moment” is seeing a real workspace arrive safely
on another machine while understanding that only they hold the recovery key.

### Brand Personality

Calm, direct, and trustworthy. rbox should feel technically capable without
being intimidating, and security-conscious without using fear as motivation.
Copy should explain consequences at the point of decision in plain language.

### Aesthetic Direction

Use a restrained, native-terminal presentation that feels fast and familiar.
Prefer concise prompts, clear keyboard hints, progressive disclosure, and
specific success or recovery messages. ANSI styling should reinforce hierarchy
and state while every flow remains understandable without color.

### Design Principles

1. Optimize the shortest path to a successful first sync; optional hardening
   must not become an onboarding blocker.
2. Translate implementation details into concrete user choices and recovery
   actions.
3. Explain security at the decision point, including what rbox cannot recover,
   without alarmist language.
4. Design defaults and terminology for GitHub-capable non-developers while
   preserving efficient paths for experienced terminal users.
5. Treat accessibility and non-interactive behavior as contracts: never rely on
   color alone, keep keyboard behavior explicit, and preserve script-safe output.
