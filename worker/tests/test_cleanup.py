from datetime import UTC, datetime, timedelta

import pytest

from app.cleanup import cleanup_jobs, expired_job_directories, recover_processing_jobs

KEY = "550e8400-e29b-41d4-a716-446655440000"
NOW = datetime(2026, 9, 22, tzinfo=UTC)


class Metadata:
    def __init__(self, records):
        self.records = records
        self.updates = []

    def list_jobs(self, status=None):
        return [r.copy() for r in self.records if status is None or r["status"] == status]

    def update_job(self, record_id, **changes):
        self.updates.append((record_id, changes))
        record = next(r for r in self.records if r["id"] == record_id)
        record.update(changes)


def record(status="ready", **changes):
    return {"id": "record000000001", "jobKey": KEY, "status": status,
            "createdAt": (NOW - timedelta(minutes=30)).isoformat(),
            "expiresAt": (NOW + timedelta(minutes=30)).isoformat(), **changes}


def test_only_metadata_named_expired_directories_are_selected(tmp_path):
    expired = tmp_path / KEY
    expired.mkdir()
    (tmp_path / "untracked").mkdir()
    assert expired_job_directories(tmp_path, {KEY: NOW - timedelta(seconds=3601)}, 3600, now=NOW) == [expired]
    assert expired_job_directories(tmp_path, {KEY: NOW}, 3600, now=NOW) == []


@pytest.mark.parametrize("key", ["..", ".", "../outside", "nested/child", "C:\\", ""])
def test_cleanup_rejects_unsafe_metadata_paths(tmp_path, key):
    metadata = Metadata([record("downloaded", jobKey=key)])
    cleanup_jobs(tmp_path, metadata, 3600, now=NOW)
    assert tmp_path.exists()
    assert metadata.updates == []


@pytest.mark.parametrize("status", ["downloaded", "ready", "failed", "queued", "expired"])
def test_downloaded_or_expired_files_are_removed_and_record_expired(tmp_path, status):
    folder = tmp_path / KEY / "input"
    folder.mkdir(parents=True)
    (folder / "0001").write_bytes(b"private content")
    metadata = Metadata([record(status, expiresAt=(NOW - timedelta(seconds=1)).isoformat())])
    cleanup_jobs(tmp_path, metadata, 3600, now=NOW)
    assert not (tmp_path / KEY).exists()
    assert metadata.records[0]["status"] == "expired"


def test_downloaded_is_removed_before_ttl(tmp_path):
    (tmp_path / KEY).mkdir()
    metadata = Metadata([record("downloaded")])
    cleanup_jobs(tmp_path, metadata, 3600, now=NOW)
    assert not (tmp_path / KEY).exists()
    assert metadata.records[0]["status"] == "expired"


def test_live_and_untracked_jobs_survive_cleanup(tmp_path):
    (tmp_path / KEY).mkdir()
    (tmp_path / "untracked").mkdir()
    metadata = Metadata([record()])
    cleanup_jobs(tmp_path, metadata, 3600, now=NOW)
    assert (tmp_path / KEY).is_dir()
    assert (tmp_path / "untracked").is_dir()
    assert metadata.updates == []


def test_expired_processing_job_is_not_deleted_during_conversion(tmp_path):
    (tmp_path / KEY).mkdir()
    metadata = Metadata([record("processing", expiresAt=(NOW - timedelta(seconds=1)).isoformat())])
    cleanup_jobs(tmp_path, metadata, 3600, now=NOW)
    assert (tmp_path / KEY).exists()


def test_missing_folder_still_marks_downloaded_record_expired(tmp_path):
    metadata = Metadata([record("downloaded")])
    cleanup_jobs(tmp_path, metadata, 3600, now=NOW)
    assert metadata.records[0]["status"] == "expired"


def test_startup_recovery_marks_interrupted_job_failed_and_removes_folder(tmp_path):
    (tmp_path / KEY).mkdir()
    metadata = Metadata([record("processing")])
    recover_processing_jobs(tmp_path, metadata)
    assert metadata.records[0]["status"] == "failed"
    assert metadata.records[0]["errorCode"] == "processing_failed"
    assert not (tmp_path / KEY).exists()


def test_symlink_to_external_directory_is_never_followed(tmp_path):
    root = tmp_path / "jobs"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    protected = outside / "private.txt"
    protected.write_text("keep")
    try:
        (root / KEY).symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("OS does not allow unprivileged symlinks")
    metadata = Metadata([record("downloaded")])
    cleanup_jobs(root, metadata, 3600, now=NOW)
    assert protected.read_text() == "keep"
    assert metadata.updates == []


def test_delete_failure_does_not_claim_expiry(tmp_path, monkeypatch):
    (tmp_path / KEY).mkdir()
    metadata = Metadata([record("downloaded")])
    def denied(_path):
        raise PermissionError("locked")
    monkeypatch.setattr("app.cleanup.shutil.rmtree", denied)
    cleanup_jobs(tmp_path, metadata, 3600, now=NOW)
    assert metadata.records[0]["status"] == "downloaded"
