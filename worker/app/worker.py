"""Single Redis JSON-list consumer with metadata transitions and recovery."""

import json
import logging
import os
from pathlib import Path
import signal
from threading import Event

import httpx
from redis import Redis, RedisError

from app.cleanup import (
    cleanup_jobs, expire_job, job_is_expired, recover_processing_jobs,
    remove_job_directory,
)
from app.contracts import JobPayload
from app.pocketbase_client import PocketBaseClient
from app.processor import ProcessingResult, process_job

logger = logging.getLogger(__name__)
QUEUE_NAME = "pdf-jobs"
ERROR_CODES = {"processing_failed", "input_too_large", "unsupported_type", "mime_mismatch",
               "invalid_page_range", "password_protected", "tool_timeout"}


class PendingResultWrite(Exception):
    """Retain the completed result while PocketBase is temporarily unavailable."""

    def __init__(self, record_id, job_key, changes):
        super().__init__("Result metadata update is pending")
        self.record_id = record_id
        self.job_key = job_key
        self.changes = changes


class PendingClaimWrite(Exception):
    """The claim request may have committed, but processing has not started."""

    def __init__(self, job):
        super().__init__("Processing claim needs reconciliation")
        self.job = job


def handle_message(message, metadata, jobs_dir, *, processor=process_job,
                   ttl_seconds=3600, pending_claim=None):
    try:
        data = json.loads(message)
        if not isinstance(data, dict):
            raise ValueError("payload must be an object")
        job = JobPayload.from_dict(data)
    except (ValueError, TypeError, UnicodeError):
        logger.warning("Discarded malformed queue message")
        return False

    try:
        record = metadata.get_job(job.record_id)
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 404:
            return False
        raise
    resuming_claim = pending_claim == job and record.get("status") == "processing"
    if ((record.get("status") != "queued" and not resuming_claim) or record.get("owner") != job.owner_id
            or record.get("jobKey") != job.job_key or record.get("operation") != job.operation.value
            or record.get("inputNames") != job.input_names):
        logger.warning("Discarded duplicate or mismatched queue message")
        return False
    if job_is_expired(record, ttl_seconds):
        expire_job(jobs_dir, metadata, record)
        return False
    if not resuming_claim:
        try:
            metadata.update_job(job.record_id, status="processing", errorCode="", outputName="")
        except httpx.HTTPError as error:
            raise PendingClaimWrite(job) from error
    try:
        result = processor(job, jobs_dir)
    except Exception:
        # Never put exception text or input names into client-visible errors.
        logger.error("Processor raised an unexpected exception")
        result = ProcessingResult(error_code="processing_failed")
    if result.succeeded:
        changes = dict(status="ready", outputName=result.output_path.name, errorCode="")
    else:
        error_code = result.error_code if result.error_code in ERROR_CODES else "processing_failed"
        changes = dict(status="failed", errorCode=error_code, outputName="")
    try:
        metadata.update_job(job.record_id, **changes)
    except httpx.HTTPError as error:
        raise PendingResultWrite(job.record_id, job.job_key, changes) from error
    return True


def run_worker(queue, metadata, jobs_dir, ttl_seconds, stop):
    recover_processing_jobs(jobs_dir, metadata)
    pending_message = None
    pending_result = None
    pending_claim = None
    orphaned_job_keys = set()
    while not stop.is_set():
        try:
            if pending_result is not None:
                try:
                    metadata.update_job(pending_result.record_id, **pending_result.changes)
                except httpx.HTTPStatusError as error:
                    if error.response.status_code != 404:
                        raise
                    # This key was matched to PocketBase before the job ran.
                    # A deleted record cannot accept any later result write.
                    orphaned_job_keys.add(pending_result.job_key)
                pending_result = None
                pending_message = None
                pending_claim = None
            for job_key in tuple(orphaned_job_keys):
                try:
                    remove_job_directory(jobs_dir, job_key)
                    orphaned_job_keys.remove(job_key)
                except (OSError, ValueError):
                    logger.warning("Deleted record folder cleanup deferred")
            cleanup_jobs(jobs_dir, metadata, ttl_seconds)
            if pending_message is None:
                item = queue.brpop(QUEUE_NAME, timeout=5)
                if item is None:
                    continue
                pending_message = item[1]
            handle_message(pending_message, metadata, jobs_dir, ttl_seconds=ttl_seconds,
                           pending_claim=pending_claim)
            pending_message = None
            pending_claim = None
        except PendingClaimWrite as error:
            pending_claim = error.job
            logger.warning("Processing claim response unavailable; reconciling")
            stop.wait(5)
        except PendingResultWrite as error:
            pending_result = error
            logger.warning("Result metadata update deferred; retrying")
            stop.wait(5)
        except (httpx.HTTPError, RedisError, OSError, ValueError, KeyError):
            logger.warning("Worker dependency unavailable; retrying")
            # Keep a popped item in memory until its metadata write succeeds.
            stop.wait(5)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    stop = Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    ttl_seconds = int(os.environ.get("JOB_TTL_SECONDS", "3600"))
    if ttl_seconds <= 0:
        raise ValueError("JOB_TTL_SECONDS must be positive")
    jobs_dir = Path(os.environ.get("JOBS_DIR", "/jobs"))
    with PocketBaseClient(os.environ.get("POCKETBASE_URL", "http://pocketbase:8090"),
                          os.environ.get("POCKETBASE_SUPERUSER_EMAIL", ""),
                          os.environ.get("POCKETBASE_SUPERUSER_PASSWORD", "")) as metadata:
        with Redis.from_url(os.environ.get("REDIS_URL", "redis://redis:6379/0")) as queue:
            while not stop.is_set():
                try:
                    run_worker(queue, metadata, jobs_dir, ttl_seconds, stop)
                except (httpx.HTTPError, RedisError):
                    logger.warning("Worker startup waiting for dependencies")
                    stop.wait(5)


if __name__ == "__main__":
    main()
