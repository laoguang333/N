#!/usr/bin/env python3
"""Build the Windows release installer with Inno Setup."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
INSTALLER_SCRIPT = ROOT / "installer" / "txt-reader.iss"
RELEASE_DIR = ROOT / "release"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true", help="reuse existing build outputs")
    parser.add_argument("--inno-setup", type=Path, help="path to ISCC.exe")
    args = parser.parse_args()

    npm = require("npm")
    cargo = require("cargo")
    iscc = resolve_inno_setup(args.inno_setup)
    version = cargo_package_version()

    if not args.skip_build:
        ensure_frontend_deps(npm)
        run([npm, "run", "build"], FRONTEND)
        run([cargo, "build", "--release"], ROOT)

    exe = ROOT / "target" / "release" / "txt-reader.exe"
    index = ROOT / "frontend" / "dist" / "index.html"
    require_file(exe, "release executable")
    require_file(index, "frontend build")
    require_file(INSTALLER_SCRIPT, "Inno Setup script")

    RELEASE_DIR.mkdir(exist_ok=True)
    run(
        [
            str(iscc),
            f"/DAppVersion={version}",
            f"/DProjectRoot={ROOT}",
            f"/DOutputDir={RELEASE_DIR}",
            str(INSTALLER_SCRIPT),
        ],
        ROOT,
    )

    installer = RELEASE_DIR / f"txt-reader-{version}-setup.exe"
    require_file(installer, "installer")
    print(f"Created installer: {installer}")
    return 0


def ensure_frontend_deps(npm: str) -> None:
    vite = FRONTEND / "node_modules" / "vite" / "bin" / "vite.js"
    vue = FRONTEND / "node_modules" / "vue" / "dist"
    plugin_vue = FRONTEND / "node_modules" / "@vitejs" / "plugin-vue" / "dist" / "index.mjs"
    if vite.exists() and vue.exists() and plugin_vue.exists():
        return
    run([npm, "ci"], FRONTEND)


def cargo_package_version() -> str:
    cargo_toml = ROOT / "Cargo.toml"
    in_package = False
    for line in cargo_toml.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped == "[package]":
            in_package = True
            continue
        if in_package and stripped.startswith("["):
            break
        match = re.match(r'version\s*=\s*"([^"]+)"', stripped)
        if in_package and match:
            return match.group(1)
    raise SystemExit(f"failed to read package version from {cargo_toml}")


def resolve_inno_setup(explicit: Path | None) -> Path:
    if explicit:
        path = explicit.resolve()
        require_file(path, "Inno Setup compiler")
        return path

    from_path = shutil.which("ISCC.exe")
    if from_path:
        return Path(from_path)

    candidates = [
        Path.home() / "AppData" / "Local" / "Programs" / "Inno Setup 6" / "ISCC.exe",
        Path(r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe"),
        Path(r"C:\Program Files\Inno Setup 6\ISCC.exe"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate

    raise SystemExit(
        "Inno Setup 6 compiler was not found. Install JRSoftware.InnoSetup with winget "
        "or pass --inno-setup C:\\path\\to\\ISCC.exe."
    )


def require(command: str) -> str:
    resolved = shutil.which(command)
    if not resolved:
        raise SystemExit(f"required command not found: {command}")
    return resolved


def require_file(path: Path, label: str) -> None:
    if not path.exists():
        raise SystemExit(f"{label} not found: {path}")


def run(command: list[str], cwd: Path) -> None:
    print(f"+ {subprocess.list2cmdline(command)}", flush=True)
    subprocess.run(command, cwd=cwd, check=True)


if __name__ == "__main__":
    raise SystemExit(main())
