from __future__ import annotations

import subprocess
import sys
import threading
import unittest
from concurrent.futures.thread import BrokenThreadPool
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from babeldoc.utils.priority_thread_pool_executor import PriorityThreadPoolExecutor


class PriorityThreadPoolTests(unittest.TestCase):
    def test_priority_ties_and_cancelled_calls(self):
        started = threading.Event()
        release = threading.Event()
        calls = []

        def block_worker():
            started.set()
            if not release.wait(5):
                raise TimeoutError("Worker was not released")

        def record(value, *, suffix):
            calls.append(value + suffix)
            return value + suffix

        with PriorityThreadPoolExecutor(max_workers=1) as executor:
            try:
                blocker = executor.submit(block_worker)
                self.assertTrue(started.wait(5))
                low = executor.submit(record, "low", suffix="!", priority=20)
                first = executor.submit(record, "first", suffix="!", priority=1)
                second = executor.submit(record, "second", suffix="!", priority=1)
                cancelled = executor.submit(record, "cancelled", suffix="!", priority=0)
                self.assertTrue(cancelled.cancel())
            finally:
                release.set()
            blocker.result(timeout=5)
            self.assertEqual(first.result(timeout=5), "first!")
            self.assertEqual(second.result(timeout=5), "second!")
            self.assertEqual(low.result(timeout=5), "low!")
        self.assertEqual(calls, ["first!", "second!", "low!"])
        self.assertTrue(cancelled.cancelled())
        with self.assertRaises(RuntimeError):
            executor.submit(lambda: None)

    def test_initializer_and_task_exception(self):
        state = threading.local()

        def initialize(value):
            state.value = value

        def fail():
            raise ValueError("task failed")

        with PriorityThreadPoolExecutor(1, "test", initialize, (42,)) as executor:
            self.assertEqual(executor.submit(lambda: state.value).result(timeout=5), 42)
            failed = executor.submit(fail)
            with self.assertRaisesRegex(ValueError, "task failed"):
                failed.result(timeout=5)
            self.assertEqual(executor.submit(lambda: "still working").result(timeout=5), "still working")

    def test_shutdown_cancels_queued_calls(self):
        started = threading.Event()
        release = threading.Event()

        def block_worker():
            started.set()
            if not release.wait(5):
                raise TimeoutError("Worker was not released")

        executor = PriorityThreadPoolExecutor(max_workers=1)
        try:
            running = executor.submit(block_worker)
            self.assertTrue(started.wait(5))
            queued = executor.submit(lambda: "must not run", priority=1)
            executor.shutdown(wait=False, cancel_futures=True)
            self.assertTrue(queued.cancelled())
        finally:
            release.set()
            executor.shutdown(wait=True)
        running.result(timeout=5)

    def test_initializer_failure_breaks_pending_futures(self):
        release = threading.Event()

        def fail_initializer():
            if not release.wait(5):
                raise TimeoutError("Initializer was not released")
            raise ValueError("initializer failed")

        with self.assertLogs("concurrent.futures", level="CRITICAL"):
            with PriorityThreadPoolExecutor(1, initializer=fail_initializer) as executor:
                try:
                    first = executor.submit(lambda: None)
                    second = executor.submit(lambda: None)
                finally:
                    release.set()
                for future in (first, second):
                    with self.assertRaises(BrokenThreadPool):
                        future.result(timeout=5)
                with self.assertRaises(BrokenThreadPool):
                    executor.submit(lambda: None)

    def test_interpreter_exit_drains_priority_queue(self):
        script = """
import threading
from concurrent.futures import ThreadPoolExecutor
from babeldoc.utils.priority_thread_pool_executor import PriorityThreadPoolExecutor

started = threading.Event()
release = threading.Event()
def block():
    started.set()
    assert release.wait(5)

pool = PriorityThreadPoolExecutor(max_workers=1)
pool.submit(block)
assert started.wait(5)
pool.submit(print, 'last', priority=10**30)
pool.submit(print, 'first', priority=1)
ThreadPoolExecutor(1).submit(lambda: None)
release.set()
"""
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=SERVER_DIR,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ["first", "last"])


if __name__ == "__main__":
    unittest.main()
