# Priority queue adapter for CPython 3.14's ThreadPoolExecutor.
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from itertools import count
from math import inf
from queue import PriorityQueue


class _PriorityWorkQueue(PriorityQueue):
    def __init__(self):
        super().__init__()
        self._sequence = count()

    def _put(self, item):
        # CPython 3.14 work items store (fn, args, kwargs) in task.
        # Shutdown sentinels follow every queued task, regardless of its priority.
        priority = item.task[0].priority if item is not None else inf
        super()._put((priority, next(self._sequence), item))

    def _get(self):
        return super()._get()[2]


class PriorityThreadPoolExecutor(ThreadPoolExecutor):
    """Execute queued calls by ascending priority, FIFO for equal priorities."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._work_queue = _PriorityWorkQueue()

    def submit(self, fn, /, *args, priority=100, **kwargs):
        call = partial(fn, *args, **kwargs)
        call.priority = priority
        return super().submit(call)
