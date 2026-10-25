"""``wt-train ui``: MLflow's own UI for the local runs, on 127.0.0.1 only.

It first adds the ``training/results.csv`` rows that are not tracked yet as
baseline runs (run 4's FLEURS baselines are the first runs, so the UI is never
empty), then starts ``mlflow ui`` on the store in the work folder with
telemetry off and opens it in the browser. Ctrl-C stops it. Port 5000 belongs
to macOS's AirPlay receiver, so the first free port from 5055 is used.
"""

from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import time
import webbrowser

from . import tracking
from .console import log

HOST = "127.0.0.1"
FIRST_PORT = 5055


def free_port(start: int = FIRST_PORT, tries: int = 50) -> int:
    for port in range(start, start + tries):
        with socket.socket() as s:
            try:
                s.bind((HOST, port))
            except OSError:
                continue
            return port
    raise RuntimeError(f"no free port from {start} to {start + tries - 1}")


def command(port: int) -> list[str]:
    return [sys.executable, "-m", "mlflow", "ui", "--backend-store-uri", tracking.tracking_uri(),
            "--default-artifact-root", tracking.artifact_root().as_uri(), "--no-serve-artifacts",
            "--host", HOST, "--port", str(port)]


def environment() -> dict[str, str]:
    env = dict(os.environ)
    env.update(tracking.ENVIRONMENT)
    return env


def _wait_for(port: int, seconds: float = 60) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        with socket.socket() as s:
            if s.connect_ex((HOST, port)) == 0:
                return True
        time.sleep(0.3)
    return False


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="wt-train ui", description=__doc__.split("\n\n")[0])
    p.add_argument("--port", type=int, help=f"port (default: the first free one from {FIRST_PORT})")
    p.add_argument("--no-browser", action="store_true", help="only start the server")
    args = p.parse_args(argv)
    if not tracking.enabled():
        log("tracking is off (WT_TRACKING=0); nothing to show")
        return 1
    added = tracking.import_results()
    if added:
        log(f"added {added} row(s) from results.csv as baseline runs")
    port = args.port or free_port()
    url = f"http://{HOST}:{port}"
    server = subprocess.Popen(command(port), env=environment())
    try:
        if _wait_for(port) and not args.no_browser:
            webbrowser.open(url)
        log(f"MLflow UI: {url} (store {tracking.store_dir()}; Ctrl-C stops it)")
        return server.wait()
    except KeyboardInterrupt:
        server.terminate()
        server.wait(timeout=10)
        return 0
