#!/usr/bin/env python3
"""Run the project verification suite."""

from __future__ import annotations

import shutil
import subprocess
import sys
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"


def main() -> int:
    cargo = require("cargo")
    npm = require("npm")
    e2e_env = playwright_env()
    stop_frontend_tooling_processes()

    commands = [
        ("rustfmt", [cargo, "fmt", "--check"], ROOT),
        ("clippy", [cargo, "clippy", "--all-targets", "--no-deps", "--", "-D", "warnings"], ROOT),
        ("rust tests", [cargo, "test"], ROOT),
        ("frontend deps", [npm, "ci"], FRONTEND),
        ("frontend tests", [npm, "test"], FRONTEND),
        *playwright_browser_command(),
        ("frontend e2e", [npm, "run", "test:e2e"], FRONTEND, e2e_env),
        ("frontend build", [npm, "run", "build"], FRONTEND),
    ]

    for item in commands:
        label, command, cwd, *rest = item
        env = rest[0] if rest else None
        print(f"\n== {label} ==", flush=True)
        print(f"+ {' '.join(command)}", flush=True)
        completed = subprocess.run(command, cwd=cwd, env=env)
        if completed.returncode != 0:
            return completed.returncode

    return 0


def require(command: str) -> str:
    resolved = shutil.which(command)
    if not resolved:
        raise SystemExit(f"required command not found: {command}")
    return resolved


def playwright_browser_command() -> list[tuple[str, list[str], Path]]:
    if local_browser_channel():
        return []
    return [("playwright browser", [require("npx"), "playwright", "install", "chromium"], FRONTEND)]


def playwright_env() -> dict[str, str] | None:
    channel = local_browser_channel()
    if not channel:
        return None
    env = dict(os.environ)
    env.setdefault("PW_CHANNEL", channel)
    return env


def local_browser_channel() -> str | None:
    if sys.platform != "win32":
        return None
    candidates = [
        ("chrome", Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")),
        ("msedge", Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")),
        ("msedge", Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")),
    ]
    for channel, path in candidates:
        if path.exists():
            return channel
    return None


def stop_frontend_tooling_processes() -> None:
    if sys.platform != "win32":
        return
    frontend = str(FRONTEND)
    command = (
        "$frontend = '" + frontend + "'; "
        "$procs = Get-CimInstance Win32_Process | "
        "Where-Object { "
        "($_.Name -in @('node.exe','esbuild.exe')) -and "
        "($_.CommandLine -like \"*$frontend*\") "
        "}; "
        "foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", command], check=False)


if __name__ == "__main__":
    sys.exit(main())
