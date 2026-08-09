#!/bin/sh
set -eu

# Source archives and production package installs may not include Git metadata.
if ! command -v git >/dev/null 2>&1 ||
  ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

git config core.hooksPath .githooks
