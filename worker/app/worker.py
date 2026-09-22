"""Temporary worker bootstrap until the Redis consumer is implemented."""

import signal
from threading import Event


shutdown_requested = Event()


def request_shutdown(_signal_number, _frame) -> None:
    shutdown_requested.set()


def main() -> None:
    signal.signal(signal.SIGINT, request_shutdown)
    signal.signal(signal.SIGTERM, request_shutdown)
    shutdown_requested.wait()


if __name__ == "__main__":
    main()
