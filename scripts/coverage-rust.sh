#!/usr/bin/env sh
set -eu

if ! cargo llvm-cov --version >/dev/null 2>&1; then
  echo "cargo-llvm-cov is required for Rust coverage."
  echo "Install it with: cargo install cargo-llvm-cov --locked"
  exit 1
fi

if [ "$#" -eq 0 ]; then
  set -- --summary-only
fi

cargo llvm-cov \
  --workspace \
  --all-features \
  --ignore-filename-regex '(/target/|/reference/)' \
  "$@"
