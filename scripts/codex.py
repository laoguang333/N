#!/usr/bin/env python3
"""Codex task entrypoint for build, run, checks, and local HTTPS setup."""

from __future__ import annotations

import argparse
import shutil
import socket
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
CERTS = ROOT / "certs"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)

    subcommands.add_parser("build-frontend")
    subcommands.add_parser("build-backend")
    subcommands.add_parser("build-all")
    subcommands.add_parser("start-backend")
    subcommands.add_parser("dev")
    subcommands.add_parser("check")
    subcommands.add_parser("setup-https")
    subcommands.add_parser("port")

    args = parser.parse_args()

    match args.command:
        case "build-frontend":
            build_frontend()
        case "build-backend":
            build_backend()
        case "build-all":
            build_frontend()
            build_backend()
        case "start-backend":
            run([require("cargo"), "run"], ROOT)
        case "dev":
            run([sys.executable, str(ROOT / "scripts" / "dev.py")], ROOT)
        case "check":
            run([sys.executable, str(ROOT / "scripts" / "check.py")], ROOT)
        case "setup-https":
            setup_https()
        case "port":
            check_port()
        case _:
            raise AssertionError(args.command)

    return 0


def build_frontend() -> None:
    npm = require("npm")
    run([npm, "ci"], FRONTEND)
    run([npm, "run", "build"], FRONTEND)


def build_backend() -> None:
    run([require("cargo"), "build"], ROOT)


def setup_https() -> None:
    openssl = require("openssl")
    CERTS.mkdir(exist_ok=True)

    ca_key = CERTS / "local-ca-key.pem"
    ca_pem = CERTS / "local-ca.pem"
    ca_cer = CERTS / "local-ca.cer"
    ca_srl = CERTS / "local-ca.srl"
    server_key = CERTS / "server-key.pem"
    server_csr = CERTS / "server.csr"
    server_cert = CERTS / "server-cert.pem"
    server_conf = CERTS / "server-openssl.cnf"

    ips = local_ipv4_addresses()
    names = ["localhost", "txt-reader.local", socket.gethostname()]
    names.append(f"{socket.gethostname()}.local")

    san_lines = []
    for index, name in enumerate(dict.fromkeys(names), start=1):
        san_lines.append(f"DNS.{index} = {name}")
    for index, ip in enumerate(["127.0.0.1", *ips], start=1):
        san_lines.append(f"IP.{index} = {ip}")

    server_conf.write_text(
        "\n".join(
            [
                "[ req ]",
                "default_bits = 2048",
                "prompt = no",
                "default_md = sha256",
                "distinguished_name = dn",
                "req_extensions = v3_req",
                "",
                "[ dn ]",
                "CN = txt-reader.local",
                "",
                "[ v3_req ]",
                "basicConstraints = critical,CA:FALSE",
                "keyUsage = critical,digitalSignature,keyEncipherment",
                "extendedKeyUsage = serverAuth",
                "subjectAltName = @alt_names",
                "",
                "[ alt_names ]",
                *san_lines,
                "",
            ]
        ),
        encoding="utf-8",
    )

    run([openssl, "genrsa", "-out", str(ca_key), "4096"], ROOT)
    run(
        [
            openssl,
            "req",
            "-x509",
            "-new",
            "-nodes",
            "-key",
            str(ca_key),
            "-sha256",
            "-days",
            "36500",
            "-out",
            str(ca_pem),
            "-subj",
            "/CN=TXT Reader Local CA",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,keyCertSign,cRLSign",
        ],
        ROOT,
    )
    run([openssl, "x509", "-outform", "der", "-in", str(ca_pem), "-out", str(ca_cer)], ROOT)
    run([openssl, "genrsa", "-out", str(server_key), "2048"], ROOT)
    run(
        [
            openssl,
            "req",
            "-new",
            "-key",
            str(server_key),
            "-out",
            str(server_csr),
            "-config",
            str(server_conf),
        ],
        ROOT,
    )
    run(
        [
            openssl,
            "x509",
            "-req",
            "-in",
            str(server_csr),
            "-CA",
            str(ca_pem),
            "-CAkey",
            str(ca_key),
            "-CAcreateserial",
            "-out",
            str(server_cert),
            "-days",
            "825",
            "-sha256",
            "-extfile",
            str(server_conf),
            "-extensions",
            "v3_req",
        ],
        ROOT,
    )

    certutil = shutil.which("certutil")
    if certutil:
        run([certutil, "-user", "-addstore", "Root", str(ca_cer)], ROOT)
        print("Trusted the CA in the current Windows user's Root store.")
    else:
        print("certutil was not found; install local-ca.cer manually on this device.")

    print("Created:")
    print(f"  CA certificate:     {ca_cer}")
    print(f"  CA PEM for mobile:  {ca_pem}")
    print(f"  Server certificate: {server_cert}")
    print(f"  Server key:         {server_key}")
    print("Certificate URLs:")
    for ip in ips:
        print(f"  https://{ip}:234")

    if ca_srl.exists():
        ca_srl.unlink()
    if server_csr.exists():
        server_csr.unlink()


def check_port() -> None:
    if sys.platform == "win32":
        run(["netstat", "-ano"], ROOT)
    else:
        run(["sh", "-c", "lsof -nP -iTCP:234 -sTCP:LISTEN || true"], ROOT)


def local_ipv4_addresses() -> list[str]:
    addresses = []
    for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
        ip = info[4][0]
        if ip != "127.0.0.1" and not ip.startswith("169.254.") and ip not in addresses:
            addresses.append(ip)
    return addresses


def require(command: str) -> str:
    resolved = shutil.which(command)
    if not resolved:
        raise SystemExit(f"required command not found: {command}")
    return resolved


def run(command: list[str], cwd: Path) -> None:
    print(f"+ {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=cwd, check=True)


if __name__ == "__main__":
    sys.exit(main())
