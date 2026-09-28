"""Worker limits that are safe to share with the web upload service."""

import os


def _max_input_bytes() -> int:
    default = 200 * 1024 * 1024
    raw = os.environ.get("MAX_UPLOAD_BYTES")
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


MAX_INPUT_BYTES = _max_input_bytes()
TOOL_TIMEOUT_SECONDS = 300
