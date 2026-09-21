import asyncio
import io
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException, UploadFile
from starlette.requests import Request
from starlette.responses import Response

from backend import gpu, main
from backend.private_files import write_private_json


class JsonRequest:
    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


class PrivacyContractTests(unittest.TestCase):
    def test_private_json_ignores_permissive_umask(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text("{}", encoding="utf-8")
            path.chmod(0o644)
            previous = os.umask(0o022)
            try:
                write_private_json(path, {"path": "/private/workspace"})
            finally:
                os.umask(previous)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_gpu_probe_does_not_collect_full_argv(self):
        self.assertIn("comm=", gpu._SCRIPT)
        self.assertNotIn("args=", gpu._SCRIPT)

    def test_inline_preview_rejects_active_html(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(main.config, "ROOTS", [tmp]):
            path = Path(tmp) / "untrusted.html"
            path.write_text("<script>fetch('/api/sessions')</script>", encoding="utf-8")
            with self.assertRaises(HTTPException) as raised:
                main.fs_download(str(path), inline=1, _=True)
            self.assertEqual(raised.exception.status_code, 415)

    def test_inline_media_has_sandbox_headers(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(main.config, "ROOTS", [tmp]):
            path = Path(tmp) / "preview.svg"
            path.write_text("<svg xmlns='http://www.w3.org/2000/svg'/>", encoding="utf-8")
            response = main.fs_download(str(path), inline=1, _=True)
            self.assertEqual(response.headers["content-security-policy"], "sandbox; default-src 'none'")
            self.assertEqual(response.headers["cross-origin-resource-policy"], "same-origin")

    def test_pasted_images_are_private(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(main.config, "ROOTS", [tmp]):
            upload = UploadFile(io.BytesIO(b"not-a-real-png"), filename="clipboard.png")
            previous = os.umask(0o022)
            try:
                result = asyncio.run(main.term_image(cwd=tmp, file=upload, _=True))
            finally:
                os.umask(previous)
            image = Path(result["path"])
            self.assertEqual(stat.S_IMODE(image.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(image.stat().st_mode), 0o600)

    def test_path_allowlist_uses_real_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "root"
            inside = root / "project"
            outside = base / "outside"
            inside.mkdir(parents=True)
            outside.mkdir()
            (root / "outside-link").symlink_to(outside, target_is_directory=True)

            with patch.object(main.config, "ROOTS", [str(root)]):
                self.assertEqual(main.safe_resolve(str(inside)), inside)
                with self.assertRaises(HTTPException) as escaped:
                    main.safe_resolve(str(outside))
                self.assertEqual(escaped.exception.status_code, 403)
                with self.assertRaises(HTTPException) as linked:
                    main.safe_resolve(str(root / "outside-link"))
                self.assertEqual(linked.exception.status_code, 403)

    def test_delete_removes_outside_pointing_symlink_not_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "root"
            root.mkdir()
            outside = base / "outside.txt"
            outside.write_text("keep", encoding="utf-8")
            link = root / "outside-link"
            link.symlink_to(outside)

            with patch.object(main.config, "ROOTS", [str(root)]):
                asyncio.run(main.fs_delete(JsonRequest({"path": str(link)}), _=True))

            self.assertFalse(link.exists())
            self.assertEqual(outside.read_text(encoding="utf-8"), "keep")

    def test_upload_does_not_follow_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "root"
            root.mkdir()
            outside = base / "outside.txt"
            outside.write_text("keep", encoding="utf-8")
            (root / "upload.txt").symlink_to(outside)
            upload = UploadFile(io.BytesIO(b"replace"), filename="upload.txt")

            with patch.object(main.config, "ROOTS", [str(root)]):
                with self.assertRaises(HTTPException):
                    asyncio.run(main.fs_upload(parent=str(root), file=upload, _=True))

            self.assertEqual(outside.read_text(encoding="utf-8"), "keep")

    def test_created_files_are_private_and_reject_dangling_links(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(main.config, "ROOTS", [tmp]):
            previous = os.umask(0o022)
            try:
                result = asyncio.run(main.fs_touch(JsonRequest({"parent": tmp, "name": "note.txt"}), _=True))
            finally:
                os.umask(previous)
            self.assertEqual(stat.S_IMODE(Path(result["path"]).stat().st_mode), 0o600)

            dangling = Path(tmp) / "dangling.txt"
            dangling.symlink_to(Path(tmp).parent / "missing.txt")
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(main.fs_touch(JsonRequest({"parent": tmp, "name": dangling.name}), _=True))
            self.assertEqual(raised.exception.status_code, 400)

    def test_api_responses_are_not_cacheable(self):
        request = Request({
            "type": "http",
            "method": "GET",
            "path": "/api/config",
            "headers": [],
            "query_string": b"",
            "scheme": "https",
            "server": ("example.test", 443),
            "client": ("192.0.2.1", 1234),
        })

        async def call_next(_request):
            return Response()

        response = asyncio.run(main.privacy_headers(request, call_next))
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertEqual(response.headers["referrer-policy"], "no-referrer")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")

    def test_launch_script_hides_configured_token(self):
        script = Path("run.sh").read_text(encoding="utf-8")
        self.assertIn("<set via CC_WEB_TOKEN; hidden>", script)
        self.assertIn('[ -t 1 ]', script)
        self.assertIn('mktemp "${token_file}.XXXXXX"', script)
        self.assertIn('chmod 600 "$token_tmp"', script)
        self.assertIn("--no-access-log", script)

        service = Path("deploy/easy-web-vibecoding.service.example").read_text(encoding="utf-8")
        self.assertIn("--no-access-log", service)


if __name__ == "__main__":
    unittest.main()
