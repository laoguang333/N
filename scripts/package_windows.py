#!/usr/bin/env python3
"""Build the Windows release installer with Inno Setup."""

from __future__ import annotations

import argparse
import json
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
    parser.add_argument(
        "--bump-patch",
        action="store_true",
        help="increment the patch version before packaging, for example 0.1.0 -> 0.1.1",
    )
    parser.add_argument("--inno-setup", type=Path, help="path to ISCC.exe")
    args = parser.parse_args()

    npm = require("npm")
    cargo = require("cargo")
    iscc = resolve_inno_setup(args.inno_setup)
    version = bump_patch_version() if args.bump_patch else cargo_package_version()

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
    react = FRONTEND / "node_modules" / "react" / "index.js"
    react_dom = FRONTEND / "node_modules" / "react-dom" / "index.js"
    plugin_react = FRONTEND / "node_modules" / "@vitejs" / "plugin-react" / "dist" / "index.js"
    if vite.exists() and react.exists() and react_dom.exists() and plugin_react.exists():
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


def bump_patch_version() -> str:
    current = cargo_package_version()
    parts = current.split(".")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        raise SystemExit(f"cannot bump non-semver package version: {current}")

    parts[2] = str(int(parts[2]) + 1)
    next_version = ".".join(parts)
    update_cargo_version(next_version)
    update_frontend_versions(next_version)
    update_inno_default_version(next_version)
    print(f"Bumped package version: {current} -> {next_version}")
    return next_version


def update_cargo_version(version: str) -> None:
    cargo_toml = ROOT / "Cargo.toml"
    text = cargo_toml.read_text(encoding="utf-8")
    next_text, count = re.subn(
        r'(?ms)^(\[package\].*?^version\s*=\s*")[^"]+(")',
        rf"\g<1>{version}\2",
        text,
        count=1,
    )
    if count != 1:
        raise SystemExit(f"failed to update package version in {cargo_toml}")
    cargo_toml.write_text(next_text, encoding="utf-8")


def update_frontend_versions(version: str) -> None:
    package_json = FRONTEND / "package.json"
    package_lock = FRONTEND / "package-lock.json"

    package_data = json.loads(package_json.read_text(encoding="utf-8"))
    package_data["version"] = version
    write_json(package_json, package_data)

    lock_data = json.loads(package_lock.read_text(encoding="utf-8"))
    lock_data["version"] = version
    if "" in lock_data.get("packages", {}):
        lock_data["packages"][""]["version"] = version
    write_json(package_lock, lock_data)


def update_inno_default_version(version: str) -> None:
    text = INSTALLER_SCRIPT.read_text(encoding="utf-8")
    next_text, count = re.subn(
        r'(#define AppVersion ")[^"]+(")',
        rf"\g<1>{version}\2",
        text,
        count=1,
    )
    if count != 1:
        raise SystemExit(f"failed to update default AppVersion in {INSTALLER_SCRIPT}")
    INSTALLER_SCRIPT.write_text(next_text, encoding="utf-8")


def write_json(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


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
