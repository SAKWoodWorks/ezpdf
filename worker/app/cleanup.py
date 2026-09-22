"""Delete only metadata-authorized UUID folders directly below the jobs root."""

from datetime import UTC, datetime, timedelta
import logging
from pathlib import Path
import shutil
from uuid import UUID

logger = logging.getLogger(__name__)


def parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def job_directory(jobs_dir: Path, job_key: str) -> Path:
    if not isinstance(job_key, str) or str(UUID(job_key)) != job_key:
        raise ValueError("jobKey must be a canonical UUID")
    root = jobs_dir.resolve()
    if root == Path(root.anchor):
        raise ValueError("jobs root cannot be a filesystem root")
    folder = root / job_key
    if folder.is_symlink() or (hasattr(folder, "is_junction") and folder.is_junction()):
        raise ValueError("job folder cannot be a link")
    if folder.resolve().parent != root:
        raise ValueError("job folder is outside the jobs root")
    if folder.exists() and not folder.is_dir():
        raise ValueError("job folder is not a directory")
    return folder


def remove_job_directory(jobs_dir: Path, job_key: str) -> None:
    folder = job_directory(jobs_dir, job_key)
    if folder.exists():
        # Recheck the exact target immediately before recursive removal.
        shutil.rmtree(job_directory(jobs_dir, job_key))


def expired_job_directories(jobs_dir, created_at_by_job, ttl_seconds, *, now=None):
    now = now or datetime.now(UTC)
    folders = []
    for job_key, created_at in created_at_by_job.items():
        if now < created_at + timedelta(seconds=ttl_seconds):
            continue
        try:
            folder = job_directory(jobs_dir, job_key)
            if folder.is_dir():
                folders.append(folder)
        except (ValueError, OSError):
            continue
    return folders


def job_is_expired(record, ttl_seconds, *, now=None):
    now = now or datetime.now(UTC)
    if record.get("expiresAt"):
        return parse_timestamp(record["expiresAt"]) <= now
    return parse_timestamp(record["createdAt"]) + timedelta(seconds=ttl_seconds) <= now


def expire_job(jobs_dir, metadata, record):
    remove_job_directory(jobs_dir, record["jobKey"])
    if record["status"] != "expired":
        metadata.update_job(record["id"], status="expired", outputName="")


def cleanup_jobs(jobs_dir, metadata, ttl_seconds, *, now=None):
    # Materialize all pages before updates to avoid moving paginated records.
    for record in metadata.list_jobs():
        try:
            if record["status"] == "processing":
                continue
            if record["status"] in {"downloaded", "expired"} or job_is_expired(record, ttl_seconds, now=now):
                expire_job(jobs_dir, metadata, record)
        except (ValueError, KeyError, OSError):
            logger.warning("Job cleanup deferred because metadata or filesystem validation failed")


def recover_processing_jobs(jobs_dir, metadata):
    # One consumer runs at a time: every processing record at startup is interrupted.
    for record in metadata.list_jobs(status="processing"):
        metadata.update_job(record["id"], status="failed", errorCode="processing_failed", outputName="")
        try:
            remove_job_directory(jobs_dir, record["jobKey"])
        except (ValueError, KeyError, OSError):
            logger.warning("Interrupted job cleanup deferred")
