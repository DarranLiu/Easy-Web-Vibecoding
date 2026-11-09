import asyncio
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

from backend import main


class PathPreviewTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "allowed"
        self.root.mkdir()
        self.outside = Path(temp.name) / "private.txt"
        self.outside.write_text("private", encoding="utf-8")
        for name, value in (("ROOTS", [str(self.root)]), ("DEFAULT_DIR", str(self.root))):
            p = patch.object(main.config, name, value)
            p.start()
            self.addCleanup(p.stop)

    def file(self, name="note.md", data=b"# Example\n"):
        p = self.root / name
        p.write_bytes(data)
        return p

    def rejects(self, status, value, **kwargs):
        with self.assertRaises(HTTPException) as caught:
            main.fs_resolve(value, **kwargs)
        self.assertEqual(caught.exception.status_code, status)

    def test_absolute_relative_and_quoted_unicode_paths(self):
        p = self.file("\u8bf4\u660e file.md")
        for value in (str(p), p.name, "./" + p.name, '"' + str(p) + '"', " '" + str(p) + "' "):
            with self.subTest(value=value):
                item = main.fs_resolve(value)
                self.assertEqual(item["path"], str(p))
                self.assertEqual(item["type"], "file")
                self.assertEqual(item["parent"], str(self.root))
                self.assertEqual(item["size"], p.stat().st_size)

    def test_directory_and_current_directory(self):
        self.assertIsNone(main.fs_resolve(str(self.root))["parent"])
        sub = self.root / "sub"
        sub.mkdir()
        self.assertEqual(main.fs_resolve(".", base=str(sub))["path"], str(sub))
        self.assertEqual(main.fs_resolve("..", base=str(sub))["path"], str(self.root))

    def test_home_expansion_still_enforces_roots(self):
        p = self.file()
        with patch.object(Path, "home", return_value=self.root):
            self.assertEqual(main.fs_resolve("~/note.md")["path"], str(p))
            self.assertEqual(main.fs_resolve("~")["type"], "dir")
        with patch.object(Path, "home", return_value=self.root.parent):
            self.rejects(403, "~/private.txt")
        self.rejects(400, "~someone/note.md")

    def test_traversal_and_symlink_escape_rejected(self):
        self.rejects(403, str(self.outside))
        self.rejects(403, "../private.txt")
        link = self.root / "escape"
        link.symlink_to(self.outside)
        self.rejects(403, str(link))
        p = self.file()
        inside = self.root / "inside"
        inside.symlink_to(p)
        self.assertEqual(main.fs_resolve(str(inside))["path"], str(p))

    def test_invalid_urls_control_characters_and_local_windows_paths(self):
        for value in ("", "  ", "\"\"", "a\x00b", "a\nb", "a" * 4097,
                      "https://example.invalid/file", "file:/tmp/a", "data:text/html,hi",
                      "javascript:alert(1)", "C:\\Users\\file.txt"):
            with self.subTest(value=value[:60]):
                self.rejects(400, value)

    def test_relative_base_must_be_allowed_directory(self):
        self.rejects(403, "file", base=str(self.root.parent))
        self.rejects(400, "file", base=str(self.file()))

    def test_missing_and_broken_symlink(self):
        self.rejects(404, "missing")
        link = self.root / "broken"
        link.symlink_to(self.root / "missing")
        self.rejects(404, str(link))

    def test_fifo_rejected_without_opening(self):
        fifo = self.root / "pipe"
        os.mkfifo(fifo)
        self.rejects(415, str(fifo))

    def test_permission_error_and_symlink_loop(self):
        with patch.object(Path, "stat", side_effect=PermissionError()):
            self.rejects(403, str(self.root / "denied"))
        link = self.root / "loop"
        link.symlink_to(link)
        self.rejects(400, str(link))

    def test_route_requires_authentication(self):
        for path in ("/api/fs/resolve", "/api/fs/text", "/api/fs/download"):
            route = next(r for r in main.app.routes if r.path == path)
            self.assertIn(main.require_auth, [d.call for d in route.dependant.dependencies])
        request = Request({"type": "http", "headers": [], "query_string": b""})
        with patch.object(main.config, "AUTH_ENABLED", True), patch.object(main.config, "TOKEN", "test-only-token"):
            with self.assertRaises(HTTPException) as caught:
                main.require_auth(request)
            self.assertEqual(caught.exception.status_code, 401)

    def test_utf8_truncation_does_not_misdetect_encoding(self):
        p = self.file(data="A\u4e2d\u6587".encode("utf-8"))
        with patch.object(main, "_TEXT_PREVIEW_MAX", 3):
            value = main.fs_text(str(p))
        self.assertEqual(value["text"], "A")
        self.assertEqual(value["encoding"], "utf-8")
        self.assertTrue(value["truncated"])

    def test_text_encodings_empty_files_and_binary_detection(self):
        p = self.file(data="\u4e2d\u6587".encode("gb18030"))
        self.assertEqual(main.fs_text(str(p))["text"], "\u4e2d\u6587")
        p.write_bytes(b"")
        self.assertEqual(main.fs_text(str(p))["text"], "")
        p.write_bytes(b"data\x00binary")
        with self.assertRaises(HTTPException) as caught:
            main.fs_text(str(p))
        self.assertEqual(caught.exception.status_code, 415)

    def test_download_active_documents_are_not_same_origin_html(self):
        for name in ("page.html", "page.xhtml", "script.js"):
            with self.assertRaises(HTTPException) as caught:
                main.fs_download(str(self.file(name)), inline=1)
            self.assertEqual(caught.exception.status_code, 415)
            response = main.fs_download(str(self.file(name)))
            self.assertIn("attachment", response.headers["content-disposition"])
            self.assertEqual(response.headers["x-content-type-options"], "nosniff")
            self.assertIn("sandbox", response.headers["content-security-policy"])
            self.assertEqual(response.headers["cache-control"], "private, no-store")
        response = main.fs_download(str(self.file("picture.svg")), inline=1)
        self.assertIn("sandbox", response.headers["content-security-policy"])
        self.assertEqual(response.media_type, "image/svg+xml")

    def test_download_attachment_and_media_types(self):
        for name, mime in (("image.png", "image/png"), ("sound.mp3", "audio/mpeg"), ("clip.mp4", "video/mp4"), ("paper.pdf", "application/pdf")):
            p = self.file(name)
            inline = main.fs_download(str(p), inline=1)
            self.assertEqual(inline.media_type, mime)
            self.assertNotIn("content-security-policy", inline.headers)
            self.assertNotIn("content-disposition", inline.headers)
            self.assertIn("attachment", main.fs_download(str(p)).headers["content-disposition"])

    def test_range_download_is_preserved(self):
        path = self.file("clip.mp4", b"0123456789")
        for spec_version in ("2.0", "2.4"):
            with self.subTest(spec_version=spec_version):
                response = main.fs_download(str(path), inline=1)
                messages = []

                async def send(message):
                    messages.append(message)

                async def transfer():
                    request_sent = False
                    disconnected = asyncio.Event()

                    async def receive():
                        nonlocal request_sent
                        if not request_sent:
                            request_sent = True
                            return {"type": "http.request", "body": b"", "more_body": False}
                        # A connected client waits; an immediate response here starves streaming.
                        await disconnected.wait()
                        return {"type": "http.disconnect"}

                    scope = {"type": "http", "method": "GET", "asgi": {"spec_version": spec_version},
                             "headers": [(b"range", b"bytes=2-5")]}
                    await asyncio.wait_for(response(scope, receive, send), timeout=5)

                asyncio.run(transfer())
                start = next(m for m in messages if m["type"] == "http.response.start")
                self.assertEqual(start["status"], 206)
                self.assertEqual(b"".join(m.get("body", b"") for m in messages), b"2345")


if __name__ == "__main__":
    unittest.main()
