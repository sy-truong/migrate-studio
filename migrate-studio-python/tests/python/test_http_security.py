# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Exercise actual HTTP boundaries without touching user data."""
import http.client
import threading
import pytest
import migrate_studio as studio


# Start a throwaway server on an ephemeral port with isolated paths.
@pytest.fixture
def server(tmp_path, monkeypatch):
    public = tmp_path / "www"
    public.mkdir()
    (public / "index.html").write_text("public page")
    outside = tmp_path / "private.txt"
    outside.write_text("private sentinel")
    # Add a symlink that points outside the web root to test escapes.
    (public / "link.txt").symlink_to(outside)
    # Redirect server paths into the temp directory.
    monkeypatch.setattr(studio, "WEB_ROOT", public)
    monkeypatch.setattr(studio, "ROOT", tmp_path)
    monkeypatch.setattr(studio, "HISTORY", tmp_path / "history.json")
    monkeypatch.setattr(studio, "SELECTIONS", tmp_path / "selection.json")
    # Serve from a background thread and shut down after the test.
    with studio.Server(("127.0.0.1", 0), studio.Handler) as srv:
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        yield srv
        srv.shutdown()
        thread.join()


# Send one HTTP request and return the status and body.
def request(server, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        return response.status, response.read()
    finally:
        conn.close()


# Verify traversal and symlink paths return 404 without leaking files.
@pytest.mark.parametrize("path", ["/link.txt", "/docs/%2e%2e/private.txt", "/rules/../private.txt", "/rules/%2e%2e%5cprivate.txt", "/%00"])
def test_static_paths_do_not_escape(server, path):
    status, body = request(server, "GET", path)
    assert status == 404
    assert b"private sentinel" not in body


# Verify the index loads and directory listings are blocked.
def test_page_and_no_directory_listing(server):
    assert request(server, "GET", "/")[0] == 200
    assert request(server, "GET", "/docs/")[0] == 404


# Verify a foreign Host header is rejected to block DNS rebinding.
@pytest.mark.parametrize("method", ["GET", "HEAD", "POST"])
def test_rebinding_host_rejected(server, method):
    assert request(server, method, "/api/history", headers={"Host": "attacker.example"})[0] == 403


# Verify cross-site writes are rejected and nothing is saved.
@pytest.mark.parametrize("headers", [{"Origin": "https://attacker.example"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}])
def test_cross_site_writes_rejected(server, headers):
    assert request(server, "POST", "/api/history", '{"runId":"attack"}', headers)[0] == 403
    assert not studio.HISTORY.exists()


# Verify malformed bodies and Content-Length values return 400.
@pytest.mark.parametrize("body,headers", [("[]", {}), ("{", {}), ("", {"Content-Length": "-1"}), ("", {"Content-Length": "8388609"}), ("", {"Content-Length": "invalid"}), ("", {"Transfer-Encoding": "chunked"})])
def test_invalid_input_rejected(server, body, headers):
    assert request(server, "POST", "/api/history", body, headers)[0] == 400


# Verify a same-origin write succeeds and persists history.
def test_same_origin_write_works(server):
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    assert request(server, "POST", "/api/history", '{"runId":"safe"}', {"Origin": origin})[0] == 200
    assert studio.HISTORY.exists()
