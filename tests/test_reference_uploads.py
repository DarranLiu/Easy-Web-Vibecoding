import asyncio
from contextlib import ExitStack
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import quote

from fastapi import HTTPException
from starlette.requests import ClientDisconnect
from backend import config, main, reference_uploads


class ReferenceUploadTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix="webcc-reference-")))
        self.directory = self.root / ".uploads"
        for name, value in (("ROOTS", [str(self.root)]), ("REFERENCE_UPLOAD_DIR", self.directory),
                            ("AUTH_ENABLED", True), ("TOKEN", "unit-test-token")):
            self.stack.enter_context(patch.object(config, name, value))

    async def request(self, chunks, *, name="example.md", token="unit-test-token", media="application/octet-stream", length=None):
        headers = [(b'content-type', media.encode()), (b'x-file-name', quote(name, safe='').encode())]
        if token is not None:
            headers.append((b'authorization', ('Bearer ' + token).encode()))
        if length is not None:
            headers.append((b'content-length', str(length).encode()))
        scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': 'POST',
                 'scheme': 'https', 'path': '/api/term/reference', 'raw_path': b'/api/term/reference',
                 'query_string': b'', 'root_path': '', 'headers': headers,
                 'client': ('127.0.0.1', 1234), 'server': ('localhost', 443)}
        messages = [{'type': 'http.request', 'body': chunk, 'more_body': i < len(chunks) - 1}
                    for i, chunk in enumerate(chunks)] or [{'type': 'http.request', 'body': b'', 'more_body': False}]
        output = []
        async def receive():
            return messages.pop(0) if messages else {'type': 'http.disconnect'}
        async def send(message): output.append(message)
        await main.app(scope, receive, send)
        status = next(message['status'] for message in output if message['type'] == 'http.response.start')
        body = b''.join(message.get('body', b'') for message in output if message['type'] == 'http.response.body')
        return status, json.loads(body)

    async def test_authenticated_upload_preserves_bytes_and_private_permissions(self):
        value = b'first\x00second\xff' + '中文'.encode()
        status, result = await self.request([value[:5], value[5:]], name='项目 参考.pdf', length=len(value))
        self.assertEqual(status, 200)
        file = Path(result['path'])
        self.assertEqual(file.parent, self.directory)
        self.assertEqual(file.read_bytes(), value)
        self.assertTrue(file.name.endswith('项目_参考.pdf'))
        self.assertEqual(result['size'], len(value))
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(main.fs_resolve(str(file))['path'], str(file))

    async def test_authentication_and_content_type_before_any_filesystem_write(self):
        for token, media, expected in ((None, 'application/octet-stream', 401),
                                       ('wrong', 'application/octet-stream', 401),
                                       ('unit-test-token', 'text/plain', 415),
                                       ('unit-test-token', 'multipart/form-data', 415)):
            with self.subTest(token=token, media=media):
                status, _ = await self.request([b'data'], token=token, media=media)
                self.assertEqual(status, expected)
                self.assertFalse(self.directory.exists())

    async def test_length_rejected_before_directory_creation_and_stream_limit_cleans_up(self):
        with patch.object(reference_uploads, 'MAX_BYTES', 8):
            status, _ = await self.request([b''], length=9)
            self.assertEqual(status, 413)
            self.assertFalse(self.directory.exists())
            status, _ = await self.request([b'12345', b'6789'])
            self.assertEqual(status, 413)
            self.assertEqual(list(self.directory.iterdir()), [])
            status, _ = await self.request([b'abc'], length=4)
            self.assertEqual(status, 400)
            self.assertEqual(list(self.directory.iterdir()), [])

    async def test_traversal_unicode_special_characters_and_collisions_are_safe(self):
        names = ['../../target.txt', '..\\target.txt', '报告;$(bad)\n空 格.md', '..', 'a' * 300 + '.txt']
        results = await asyncio.gather(*(self.request([name.encode()], name=name) for name in names * 2))
        self.assertTrue(all(status == 200 for status, _ in results))
        paths = [Path(result['path']) for _, result in results]
        self.assertEqual(len(set(paths)), len(paths))
        self.assertTrue(all(p.parent == self.directory and p.is_file() and len(p.name.encode()) < 240 for p in paths))
        self.assertFalse(any(any(char in p.name for char in "\n/\\$() ;") for p in paths))
        self.assertFalse((self.root / 'target.txt').exists())

    async def test_symlink_and_insecure_existing_directory_are_rejected(self):
        other = self.root / 'other'
        other.mkdir()
        self.directory.symlink_to(other, target_is_directory=True)
        status, _ = await self.request([b'data'])
        self.assertEqual(status, 403)
        self.assertEqual(list(other.iterdir()), [])
        self.directory.unlink()
        self.directory.mkdir(mode=0o755)
        self.directory.chmod(0o755)
        status, _ = await self.request([b'data'])
        self.assertEqual(status, 403)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o755)

    async def test_cache_must_be_within_configured_roots(self):
        with patch.object(config, 'REFERENCE_UPLOAD_DIR', self.root.parent / 'unapproved-cache'):
            status, _ = await self.request([b'data'])
        self.assertEqual(status, 403)
        self.assertFalse((self.root.parent / 'unapproved-cache').exists())

    async def test_disconnected_and_cancelled_uploads_remove_partial_files(self):
        class Interrupted:
            headers = {'content-type': 'application/octet-stream', 'x-file-name': 'file.txt'}
            def __init__(self, error): self.error = error
            async def stream(self):
                yield b'partial'
                raise self.error
        for error in (ClientDisconnect(), asyncio.CancelledError()):
            with self.subTest(error=type(error).__name__):
                with self.assertRaises(type(error)):
                    await reference_uploads.store(Interrupted(error), self.directory, main.safe_resolve)
                self.assertEqual(list(self.directory.iterdir()), [])

    async def test_storage_failure_never_leaves_a_partial_file(self):
        with patch.object(reference_uploads, '_write', side_effect=OSError('private details')):
            status, response = await self.request([b'example'])
        self.assertEqual(status, 500)
        self.assertNotIn('private', response['detail'])
        self.assertEqual(list(self.directory.iterdir()), [])

    async def test_collision_never_overwrites_existing_file(self):
        with patch.object(reference_uploads.secrets, 'token_hex', return_value='a' * 32):
            status, first = await self.request([b'first'])
            status2, _ = await self.request([b'second'])
        self.assertEqual((status, status2), (200, 500))
        self.assertEqual(Path(first['path']).read_bytes(), b'first')
        self.assertEqual(len(list(self.directory.iterdir())), 1)


if __name__ == '__main__':
    unittest.main()
