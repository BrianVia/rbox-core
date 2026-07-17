# rig device image (design 56 §5) — arm64-native Linux guest, built once and reused
# (Apple `container` has no snapshot/clone verb, so the image IS the repeatability
# primitive). Only deps are baked; the repo's src/ + scripts/ are bind-mounted
# read-only at runtime so module resolution walks up to THIS image's linux
# node_modules (native @parcel/watcher), never the host's macOS ones.
FROM docker.io/library/ubuntu:24.04

# Pin bun so the image is reproducible + staleness-hashable. `.bun-version` is empty
# and package.json declares no engines.bun, so this pins to the version in use.
ARG BUN_VERSION=1.3.5

# git >= 2.46 (transactional symref-update) is a product floor since design 118;
# ubuntu 24.04 ships 2.43, so pull git from the git-core PPA like the fleet does.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg software-properties-common \
    && add-apt-repository -y ppa:git-core/ppa \
    && apt-get update \
    && apt-get install -y --no-install-recommends git git-lfs tmux unzip tini \
    && rm -rf /var/lib/apt/lists/*

# Official installer, pinned. BUN_INSTALL=/usr/local → bun lands on PATH at /usr/local/bin.
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"

WORKDIR /app

# Bake linux-arm64 node_modules (incl. the @parcel/watcher native module) into the
# image from the exact lockfile. src/ + scripts/ are NOT copied — they mount at runtime.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# The UX walkthrough harness reuses this image and the rig's mounted-source CLI
# path. Keep the human-facing command as `rbox` without installing a released
# binary, so walkthroughs always exercise the candidate checkout.
RUN printf '%s\n' '#!/bin/sh' 'exec bun /app/src/cli/index.ts "$@"' > /usr/local/bin/rbox \
    && chmod 0755 /usr/local/bin/rbox

# Long-lived guest; all real work happens via `container exec`. tini as PID 1
# reaps orphaned daemons — a bare `sleep infinity` PID 1 leaves dead daemons as
# zombies, which still pass pid-liveness lock probes and wedge every later sync.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
