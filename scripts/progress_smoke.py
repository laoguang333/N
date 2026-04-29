#!/usr/bin/env python3
"""Smoke-test reading progress saves against a running TXT Reader service."""

from __future__ import annotations

import argparse
import json
import ssl
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="https://127.0.0.1:234")
    parser.add_argument("--book-id", type=int)
    args = parser.parse_args()

    client = Client(args.base_url)
    book_id = args.book_id or first_book_id(client)
    original = client.get(f"/api/books/{book_id}/progress")

    print(f"testing book {book_id}")
    print(f"original: {compact(original)}")

    first = client.put_progress(book_id, 100, 0.21, original.get("version") if original else None, "smoke_first")
    second = client.put_progress(book_id, 500, 0.77, first["version"], "smoke_second")
    stale = client.put_progress(book_id, 10, 0.05, first["version"], "smoke_stale")
    zero_reset = client.put_progress(book_id, 0, 0.0, second["version"], "smoke_zero_reset")
    near_start = client.put_progress(book_id, 20, 0.01, second["version"], "smoke_near_start")

    if stale["version"] != second["version"] or abs(stale["percent"] - second["percent"]) > 0.0001:
        raise SystemExit(f"stale backward write overwrote progress: {compact(stale)}")
    if zero_reset["version"] != second["version"] or abs(zero_reset["percent"] - second["percent"]) > 0.0001:
        raise SystemExit(f"implicit zero reset overwrote progress: {compact(zero_reset)}")
    if near_start["version"] != second["version"] or abs(near_start["percent"] - second["percent"]) > 0.0001:
        raise SystemExit(f"implicit near-start reset overwrote progress: {compact(near_start)}")

    restore_base = near_start["version"]
    if original:
        restored = client.put_progress(
            book_id,
            original["char_offset"],
            original["percent"],
            restore_base,
            "smoke_restore",
            allow_backward=True,
        )
    else:
        restored = client.put_progress(book_id, 0, 0, restore_base, "smoke_restore", allow_backward=True)

    print(f"first:    {compact(first)}")
    print(f"second:   {compact(second)}")
    print(f"stale:    {compact(stale)}")
    print(f"zero:     {compact(zero_reset)}")
    print(f"near:     {compact(near_start)}")
    print(f"restored: {compact(restored)}")
    print("ok")
    return 0


def first_book_id(client: "Client") -> int:
    books = client.get("/api/books")
    if not books:
        raise SystemExit("no books found; scan the library or pass --book-id")
    return books[0]["id"]


def compact(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class Client:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.context = ssl._create_unverified_context()

    def get(self, path: str):
        return self.request("GET", path)

    def put_progress(
        self,
        book_id: int,
        char_offset: int,
        percent: float,
        base_version: int | None,
        source: str,
        allow_backward: bool = False,
    ):
        return self.request(
            "PUT",
            f"/api/books/{book_id}/progress",
            {
                "char_offset": char_offset,
                "percent": percent,
                "base_version": base_version,
                "source": source,
                "client_id": "progress-smoke",
                "session_id": "progress-smoke",
                "allow_backward": allow_backward,
            },
        )

    def request(self, method: str, path: str, body: object | None = None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urlopen(request, context=self.context, timeout=10) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise SystemExit(f"{method} {path} failed: {error.code} {detail}") from error


if __name__ == "__main__":
    sys.exit(main())
