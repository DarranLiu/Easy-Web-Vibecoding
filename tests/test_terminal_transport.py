import asyncio
from contextlib import ExitStack
import os
import unittest
from unittest.mock import patch

from fastapi import WebSocketDisconnect
from backend import main


class TerminalTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_client_has_bounded_lossless_output_and_only_attachment_is_closed(self):
        read_fd, write_fd = os.pipe()
        os.set_blocking(write_fd, False)
        total = 4 * 1024 * 1024
        original_queue = asyncio.Queue
        queues, errors = [], []

        class TrackingQueue(original_queue):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.peak = 0
                queues.append(self)

            def put_nowait(self, value):
                super().put_nowait(value)
                self.peak = max(self.peak, self.qsize())

        class Socket:
            cookies = {}
            headers = {}
            client = None

            def __init__(self):
                self.closed = asyncio.Event()
                self.received = 0

            async def accept(self):
                pass

            async def send_bytes(self, data):
                await asyncio.sleep(.002)
                self.received += len(data)

            async def receive_text(self):
                await self.closed.wait()
                raise WebSocketDisconnect()

            async def close(self, **kwargs):
                self.closed.set()

        async def producer():
            sent = 0
            try:
                while sent < total:
                    try:
                        sent += os.write(write_fd, b"x" * min(65536, total - sent))
                    except BlockingIOError:
                        await asyncio.sleep(.001)
            finally:
                os.close(write_fd)

        socket = Socket()
        loop = asyncio.get_running_loop()
        previous = loop.get_exception_handler()
        loop.set_exception_handler(lambda loop, context: errors.append(context.get("exception", context.get("message"))))
        self.addCleanup(loop.set_exception_handler, previous)
        with ExitStack() as stack:
            stack.enter_context(patch.object(main.config, "AUTH_ENABLED", False))
            stack.enter_context(patch.object(main.tmux_mgr, "session_exists", return_value=True))
            stack.enter_context(patch.object(main.pty, "fork", return_value=(99999999, read_fd)))
            stack.enter_context(patch.object(main, "_set_winsize"))
            stack.enter_context(patch.object(main, "_client_scheme", return_value="ws"))
            stack.enter_context(patch.object(main.presence_store, "add_ws"))
            stack.enter_context(patch.object(main.presence_store, "drop_ws"))
            stack.enter_context(patch.object(main.asyncio, "Queue", TrackingQueue))
            kill = stack.enter_context(patch.object(main.os, "kill"))
            stack.enter_context(patch.object(main.os, "waitpid"))
            writer = asyncio.create_task(producer())
            try:
                await asyncio.wait_for(main.ws_term(socket, "synthetic_queue"), timeout=10)
                await writer
            finally:
                if not writer.done():
                    writer.cancel()
                    await asyncio.gather(writer, return_exceptions=True)
            kill.assert_called_once_with(99999999, main.signal.SIGKILL)
        self.assertEqual(socket.received, total)
        self.assertEqual(len(queues), 1)
        self.assertEqual(queues[0].maxsize, 16)
        self.assertLessEqual(queues[0].peak, 16)
        self.assertGreater(queues[0].peak, 1)
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
