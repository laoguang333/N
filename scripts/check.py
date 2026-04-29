#!/usr/bin/env python3
"""Run the project verification suite."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"


def main() -> int:
    cargo = require("cargo")
    npm = require("npm")

    commands = [
        ("rustfmt", [cargo, "fmt", "--check"], ROOT),
        ("clippy", [cargo, "clippy", "--all-targets", "--no-deps", "--", "-D", "warnings"], ROOT),
        ("rust tests", [cargo, "test"], ROOT),
        ("frontend deps", [npm, "ci"], FRONTEND),
        ("frontend tests", [npm, "test"], FRONTEND),
        ("playwright browser", [require("npx"), "playwright", "install", "chromium"], FRONTEND),
        ("frontend e2e", [npm, "run", "test:e2e"], FRONTEND),
        ("frontend build", [npm, "run", "build"], FRONTEND),
    ]

    for label, command, cwd in commands:
        print(f"\n== {label} ==", flush=True)
        print(f"+ {' '.join(command)}", flush=True)
        completed = subprocess.run(command, cwd=cwd)
        if completed.returncode != 0:
            return completed.returncode

    return 0


def require(command: str) -> str:
    resolved = shutil.which(command)
    if not resolved:
        raise SystemExit(f"required command not found: {command}")
    return resolved


if __name__ == "__main__":
    sys.exit(main())
