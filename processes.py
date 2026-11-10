"""Whether a process runs, on every OS the plugin supports."""

from __future__ import annotations

import os
from typing import Any


def running(pid: Any) -> bool:
    """Whether process ``pid`` runs. On Windows ``os.kill(pid, 0)`` would end it, so it asks the OS instead."""
    try:
        pid = int(pid)
    except (ValueError, TypeError):
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True  # it runs, as another user
    except OSError:
        return False
