"""Værkstedet's server (run 9): 127.0.0.1 only, the guards of API.md, the built page and its
assets, report pages with their own CSP, one server per work folder, and a clean stop on
SIGTERM, SIGINT or when the launcher is gone."""

import json
import os
import signal
import subprocess
import sys

import pytest

from fake_studio import get, post, request, start_server, stop_server, write_places
from wt_train.studio import server as studio_server
from wt_train.studio.server import CSP, REPORT_CSP, inside


@pytest.fixture
def places(tmp_path, monkeypatch):
    return write_places(tmp_path, monkeypatch)


@pytest.fixture
def server(places):
    srv = start_server(places)
    yield srv
    stop_server(srv)


def test_binds_127_0_0_1_only(server):
    assert server.server_address[0] == "127.0.0.1"


def test_there_is_no_option_to_listen_elsewhere(capsys):
    with pytest.raises(SystemExit):
        studio_server.parse(["--help"])
    out = capsys.readouterr().out
    assert "--host" not in out and "--bind" not in out
    for flag in ("--port", "--no-browser", "--no-build", "--parent-pid", "--install-app", "--recordings",
                 "--pilot-dir", "--sentences", "--plan", "--exam-file", "--pilot-sentences", "--configs", "--journal",
                 "--dist", "--app-bin", "--app-url-file"):
        assert flag in out, flag


def test_the_page_and_its_routes_are_the_built_index(server):
    status, headers, body = request(server, "GET", "/")
    assert status == 200 and headers["Content-Type"].startswith("text/html") and b'lang="da"' in body
    assert headers["Content-Security-Policy"] == CSP
    for route in ("/optag", "/data", "/journal/2026-10-27-x"):
        status, headers, again = request(server, "GET", route)
        assert status == 200 and again == body, route


def test_assets_and_files_with_their_types(server):
    status, headers, body = request(server, "GET", "/assets/index-abc123.js")
    assert status == 200 and headers["Content-Type"].startswith("text/javascript") and b"page" in body
    assert "immutable" in headers["Cache-Control"]
    assert request(server, "GET", "/assets/font.woff2")[1]["Content-Type"] == "font/woff2"
    assert request(server, "GET", "/favicon.svg")[1]["Content-Type"] == "image/svg+xml"
    assert request(server, "GET", "/assets/missing.js")[0] == 404


def test_the_csp_lets_the_page_talk_to_this_server_only():
    for part in ("default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-src 'self'",
                 "frame-ancestors 'none'", "form-action 'none'", "base-uri 'none'"):
        assert part in CSP
    assert "frame-ancestors 'self'" in REPORT_CSP and "media-src data:" in REPORT_CSP
    assert "connect-src" not in REPORT_CSP


@pytest.mark.parametrize("path", [
    "/../pyproject.toml", "/%2e%2e/pyproject.toml", "/assets/../index.html", "/assets/%2e%2e/%2e%2e/x",
    "/.source-hash", "/reports/../x.html", "/reports/nope.html", "/files/journal/../secret.md",
    "/files/journal/%2e%2e/secret.md", "/files/other/x", "/api/takes/phone-whisper/../s0001.wav",
    "/api/takes/nope/s0001.wav", "/api/takes/phone-whisper/s0001.json", "/api/nope", "/app/v1/nope",
])
def test_nothing_else_is_served(server, path):
    status, headers, body = request(server, "GET", path)
    assert status in (401, 403, 404) or (status == 200 and b'lang="da"' in body), path
    assert b"secret" not in body


def test_the_dot_files_of_the_build_are_not_served(server):
    status, _, body = request(server, "GET", "/.source-hash")
    assert body != b"x\n"


def test_inside_refuses_anything_outside(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "f.png").write_bytes(b"png")
    (tmp_path / "secret").write_text("no")
    assert inside(tmp_path / "a", "f.png") == (tmp_path / "a" / "f.png").resolve()
    for bad in ("../secret", "%2e%2e/secret", ".hidden", "", "/", "x/../../secret"):
        assert inside(tmp_path / "a", bad) is None, bad


def test_requests_must_name_this_server(server):
    port = server.server_address[1]
    assert get(server, "/api/overview", {"Host": "evil.example"})[0] == 403
    assert request(server, "GET", "/", headers={"Host": f"evil.example:{port}"})[0] == 403
    assert get(server, "/api/ping", {"Host": f"localhost:{port}"})[0] == 200


@pytest.mark.parametrize("headers", [
    {"X-WT-Studio": ""},  # a plain form post from another page cannot set it
    {"Origin": "https://example.com"},
    {"Host": "evil.example:80"},
])
def test_page_posts_from_elsewhere_are_refused(server, headers):
    status, body = post(server, "/api/recording/stop", {}, headers)
    assert status == 403 and body["error"] == "forbidden"


def test_page_posts_from_this_origin_are_fine(server):
    port = server.server_address[1]
    status, _ = post(server, "/api/recording/stop", {}, {"Origin": f"http://127.0.0.1:{port}"})
    assert status == 200
    status, _ = post(server, "/api/recording/stop", {},
                     {"Host": f"localhost:{port}", "Origin": f"http://localhost:{port}"})
    assert status == 200


def test_bodies_are_json_objects_of_at_most_64_kib(server):
    h = {"X-WT-Studio": "1"}
    assert request(server, "POST", "/api/recording/stop", b"[1]", h)[0] == 400
    assert request(server, "POST", "/api/recording/stop", b"{nope", h)[0] == 400
    big = json.dumps({"x": "a" * 70_000}).encode()
    assert request(server, "POST", "/api/recording/stop", big, h)[0] == 413


def test_the_app_api_refuses_browsers_and_wrong_tokens(server, places):
    post(server, "/api/recording/start", {"kind": "condition", "id": "phone-whisper"})
    token = places.app_url_file.read_text().strip().split("#")[1]
    port = server.server_address[1]
    auth = {"Authorization": f"Bearer {token}"}
    assert request(server, "GET", "/app/v1/next?after=0&wait=0", headers=auth)[0] == 200
    assert request(server, "GET", "/app/v1/next?after=0&wait=0", headers={"Authorization": "Bearer x"})[0] == 401
    assert request(server, "GET", "/app/v1/next?after=0&wait=0")[0] == 401
    assert request(server, "GET", "/app/v1/next?after=0&wait=0",
                   headers={**auth, "Origin": f"http://127.0.0.1:{port}"})[0] == 403
    assert request(server, "POST", "/app/v1/hello", b"{}", {**auth, "Host": "evil.example"})[0] == 403
    assert oct(places.app_url_file.stat().st_mode & 0o777) == "0o600"


def test_the_app_api_needs_a_session(server):
    assert request(server, "GET", "/app/v1/next?after=0", headers={"Authorization": "Bearer x"})[0] == 401


def test_errors_carry_a_code_and_a_message(server):
    status, body = post(server, "/api/recording/skip")
    assert status == 409 and body == {"error": "no-pick", "message": "nothing is picked to record"}
    status, body = get(server, "/api/jobs/j999")
    assert status == 404 and body["error"] == "unknown"


def test_report_pages_get_their_own_csp(server, places):
    places.reports.mkdir(parents=True)
    (places.reports / "20261026-x.html").write_text("<style>b{}</style><audio src='data:audio/mp3;base64,AA'>")
    status, headers, body = request(server, "GET", "/reports/20261026-x.html")
    assert status == 200 and headers["Content-Security-Policy"] == REPORT_CSP and b"<style>" in body


def test_a_missing_report_is_a_page_the_iframe_can_show(server):
    # Under the page's own CSP (frame-ancestors 'none') the browser would show its block message.
    status, headers, body = request(server, "GET", "/reports/20261026-nope.html")
    assert status == 404 and headers["Content-Security-Policy"] == REPORT_CSP
    assert b"Rapporten findes ikke" in body


def test_journal_files_are_served_from_the_journal_only(server, places):
    (places.journal / "2026-10-27-run").mkdir(parents=True)
    (places.journal / "2026-10-27-run" / "metrics.png").write_bytes(b"\x89PNG")
    (places.journal.parent / "secret.md").write_text("secret")
    status, headers, body = request(server, "GET", "/files/journal/2026-10-27-run/metrics.png")
    assert status == 200 and headers["Content-Type"] == "image/png" and body == b"\x89PNG"
    assert request(server, "GET", "/files/journal/../secret.md")[0] == 404


def test_the_overview(server, places):
    status, body = get(server, "/api/overview")
    assert status == 200
    assert body["app"] == {"found": False, "path": None, "version": None, "batch": False, "connected": False}
    assert body["work"] == str(places.work) and body["jobs"] == []
    assert body["recording"] == {"active": False, "paused": False, "label": None}
    assert body["training"] == {"running": False, "config": None}
    post(server, "/api/recording/start", {"kind": "condition", "id": "phone-whisper"})
    assert get(server, "/api/overview")[1]["recording"] == {"active": True, "paused": False,
                                                            "label": "Telefonen, hvisket"}
    post(server, "/api/recording/pause")
    assert get(server, "/api/overview")[1]["recording"]["paused"] is True


def test_the_overview_names_the_app_and_its_version(places, tmp_path, monkeypatch):
    import plistlib

    import fake_app
    from wt_train.app import App

    bundle = tmp_path / "WalkieTalkey.app" / "Contents"
    (bundle / "MacOS").mkdir(parents=True)
    binary, _ = fake_app.install(bundle / "MacOS", monkeypatch, batch=True)
    with (bundle / "Info.plist").open("wb") as f:
        plistlib.dump({"CFBundleShortVersionString": "0.2.2"}, f)
    srv = start_server(places, find_app=lambda: App(binary))
    try:
        app = get(srv, "/api/overview")[1]["app"]
        assert app == {"found": True, "path": str(binary), "version": "0.2.2", "batch": True, "connected": False}
    finally:
        stop_server(srv)


# --- starting and stopping the real thing ---------------------------------------------------


def studio_argv(places, *extra):
    return [sys.executable, "-m", "wt_train", "studio", "--no-browser", "--no-build",
            "--recordings", str(places.recordings), "--pilot-dir", str(places.pilot),
            "--sentences", str(places.sentences), "--plan", str(places.plan), "--exam-file", str(places.exam),
            "--pilot-sentences", str(places.pilot_sentences), "--spelling", str(places.spelling),
            "--configs", str(places.configs), "--journal", str(places.journal), "--dist", str(places.dist),
            "--app-bin", str(places.app_bin), "--app-url-file", str(places.app_url_file), *extra]


def launch(places, *extra):
    proc = subprocess.Popen(studio_argv(places, *extra), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env={**os.environ, "PYTHONUNBUFFERED": "1"}, cwd=places.configs.parent)
    line = proc.stdout.readline().decode("utf-8")
    assert line.startswith("Værkstedet: http://127.0.0.1:"), line
    return proc, line.split()[1]


def free_port():
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_it_starts_says_where_and_stops_cleanly_on_sigterm(places):
    port = free_port()
    proc, url = launch(places, "--port", str(port))
    try:
        assert url == f"http://127.0.0.1:{port}/"
        server_json = places.work / "studio" / "server.json"
        assert json.loads(server_json.read_text())["pid"] == proc.pid
        # A second start opens the running one and exits.
        again = subprocess.run(studio_argv(places), capture_output=True, timeout=60)
        assert again.returncode == 0 and again.stdout.decode("utf-8") == f"Værkstedet: {url}\n"
        # A phone session runs; SIGTERM ends it (the app gets "end") and the server exits 0.
        import urllib.request

        req = urllib.request.Request(url + "api/recording/start", method="POST",
                                     data=json.dumps({"kind": "condition", "id": "phone-whisper"}).encode(),
                                     headers={"X-WT-Studio": "1"})
        urllib.request.urlopen(req, timeout=10).read()
        token = places.app_url_file.read_text().strip().split("#")[1]
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(30) == 0
        assert not server_json.exists()
        log = (places.recordings / "sessions.jsonl").read_text().splitlines()
        assert [json.loads(line)["event"] for line in log] == ["start", "end"]
        assert token
    finally:
        if proc.poll() is None:
            proc.kill()


def test_sigint_stops_it_too(places):
    proc, _ = launch(places, "--port", str(free_port()))
    try:
        proc.send_signal(signal.SIGINT)
        assert proc.wait(30) == 0
        assert not (places.work / "studio" / "server.json").exists()
    finally:
        if proc.poll() is None:
            proc.kill()


def test_sighup_stops_it_like_sigterm(places):
    # The terminal it runs in closes.
    proc, _ = launch(places, "--port", str(free_port()))
    try:
        proc.send_signal(signal.SIGHUP)
        assert proc.wait(30) == 0
        assert not (places.work / "studio" / "server.json").exists()
    finally:
        if proc.poll() is None:
            proc.kill()


def test_an_unexpected_error_is_a_json_500_and_the_server_goes_on(server, monkeypatch, capsys):
    def broken():
        raise RuntimeError("something nobody expected")

    monkeypatch.setattr(server.recorder, "options", broken)
    status, body = get(server, "/api/recording/options")
    assert status == 500 and body == {"error": "internal", "message": "RuntimeError: something nobody expected"}
    assert "Traceback" in capsys.readouterr().err
    monkeypatch.setattr(server.recorder, "state", broken)
    status, body = get(server, "/api/recording/state")
    assert status == 500 and body["error"] == "internal"
    assert get(server, "/api/ping")[0] == 200


def test_it_stops_when_the_launcher_is_gone(places):
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    proc, _ = launch(places, "--port", str(free_port()), "--parent-pid", str(parent.pid))
    try:
        parent.kill()
        parent.wait()
        assert proc.wait(30) == 0
    finally:
        for p in (proc, parent):
            if p.poll() is None:
                p.kill()


def test_it_stops_cleanly_when_the_launcher_crashes_with_the_pipe_it_read(places):
    # Run 9, found with the real launcher: the launcher reads the server's output from a pipe, so
    # when it is killed, every later print of the server (the parent watch, a take's line, the
    # way out) met a closed pipe, the stop was lost, and server.json stayed behind.
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    proc, url = launch(places, "--port", str(free_port()), "--parent-pid", str(parent.pid))
    try:
        proc.stdout.close()
        parent.kill()
        parent.wait()
        assert proc.wait(30) == 0
        assert not (places.work / "studio" / "server.json").exists()
    finally:
        for p in (proc, parent):
            if p.poll() is None:
                p.kill()


def test_a_sigterm_after_the_reader_went_away_still_cleans_up(places):
    proc, _ = launch(places, "--port", str(free_port()))
    try:
        proc.stdout.close()
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(30) == 0
        assert not (places.work / "studio" / "server.json").exists()
    finally:
        if proc.poll() is None:
            proc.kill()


def test_a_given_port_must_be_free(places):
    import socket

    with socket.socket() as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        proc = subprocess.run(studio_argv(places, "--port", str(busy.getsockname()[1])), capture_output=True,
                              timeout=60)
    assert proc.returncode == 1 and b"cannot listen" in proc.stderr


def test_the_default_port_moves_on_when_8780_is_taken(places, monkeypatch):
    import socket

    with socket.socket() as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        monkeypatch.setattr(studio_server, "DEFAULT_PORT", busy.getsockname()[1])
        srv = studio_server.make_server(places, None, transcriber=lambda: None, find_app=lambda: None)
        try:
            assert srv.server_address[1] != busy.getsockname()[1]
        finally:
            srv.reviewer.stop()
            srv.server_close()


def test_install_app_hands_over_to_the_launcher(monkeypatch):
    import types

    seen = {}

    def install(argv):
        seen["argv"] = argv
        return 0

    fake = types.ModuleType("wt_train.studio.launcher")
    fake.install = install
    monkeypatch.setitem(sys.modules, "wt_train.studio.launcher", fake)
    assert studio_server.main(["--install-app", "--port", "8799"]) == 0
    assert seen["argv"] == ["--port", "8799"]
