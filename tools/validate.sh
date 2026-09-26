#!/bin/sh
# `claude plugin validate .` checks only the marketplace manifest once one exists, so the mod's own
# code is validated from a copy without it.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
cp -R "$root/.claude-plugin" "$root/hooks" "$tmp/"
rm -f "$tmp/.claude-plugin/marketplace.json"
claude plugin validate "$root"
claude plugin validate "$tmp"
rm -rf "$tmp"
