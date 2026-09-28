from datetime import UTC, datetime, timedelta
import json
from threading import Event

import httpx
import pytest

from app.contracts import JobPayload
from app.pocketbase_client import PocketBaseClient
from app.processor import ProcessingResult
from app.worker import handle_message, run_worker

KEY = "550e8400-e29b-41d4-a716-446655440000"
RECORD_ID = "record000000001"


def payload(**changes):
    return {"recordId": RECORD_ID, "jobKey": KEY, "ownerId": "user1",
            "operation": "image_to_pdf", "inputNames": ["ภาพ.png"], "options": {}, **changes}


class PocketBaseAPI:
    def __init__(self, **changes):
        self.record = {"id": RECORD_ID, "jobKey": KEY, "owner": "user1", "status": "queued",
                       "operation": "image_to_pdf", "inputNames": ["ภาพ.png"], "options": {},
                       "createdAt": datetime.now(UTC).isoformat(),
                       "expiresAt": (datetime.now(UTC) + timedelta(hours=1)).isoformat(), **changes}
        self.states = []
        self.auth_count = 0

    def request(self, request):
        if request.url.path.endswith("auth-with-password"):
            assert json.loads(request.content) == {"identity": "worker@example.test", "password": "test-password"}
            self.auth_count += 1
            return httpx.Response(200, json={"token": "secret-token", "record": {"id": "admin"}})
        assert request.headers["Authorization"] == "secret-token"
        if request.method == "PATCH":
            assert request.url.path.endswith("/" + RECORD_ID)
            self.record.update(json.loads(request.content))
            self.states.append(self.record["status"])
        if request.url.path.endswith("/records"):
            status_filter = request.url.params.get("filter")
            if not status_filter:
                records = [self.record]
            elif status_filter == f'status = "{self.record["status"]}"':
                records = [self.record]
            else:
                records = []
            return httpx.Response(200, json={"page": 1, "perPage": 200, "totalPages": 1,
                                           "totalItems": len(records), "items": records})
        return httpx.Response(200, json=self.record)

    def client(self):
        return PocketBaseClient("http://pocketbase", "worker@example.test", "test-password",
                                transport=httpx.MockTransport(self.request))


def test_payload_separates_record_id_and_canonical_job_key():
    job = JobPayload.from_dict(payload())
    assert job.record_id == RECORD_ID
    assert job.job_key == KEY


@pytest.mark.parametrize("changes", [{"jobKey": "../other"}, {"jobKey": KEY.upper()}, {"recordId": "../other"}])
def test_payload_rejects_unsafe_identifiers(changes):
    with pytest.raises(ValueError):
        JobPayload.from_dict(payload(**changes))


def test_worker_decodes_utf8_and_transitions_processing_to_ready(tmp_path):
    api = PocketBaseAPI()
    def process(job, root):
        assert api.record["status"] == "processing"
        assert job.record_id == RECORD_ID and job.job_key == KEY
        assert job.input_names == ["ภาพ.png"]
        output = root / KEY / "output" / "result.pdf"
        output.parent.mkdir(parents=True)
        output.write_bytes(b"%PDF-1.7")
        return ProcessingResult(output_path=output)
    with api.client() as client:
        handle_message(json.dumps(payload(), ensure_ascii=False).encode(), client, tmp_path, processor=process)
    assert api.states == ["processing", "ready"]
    assert api.record["outputName"] == "result.pdf"
    assert api.auth_count == 1


def test_republished_upload_message_processes_exactly_once(tmp_path):
    api = PocketBaseAPI()
    processed = []

    def process(job, root):
        processed.append(job.job_key)
        return ProcessingResult(output_path=root / KEY / "output" / "result.pdf")

    message = json.dumps(payload()).encode()
    with api.client() as client:
        assert handle_message(message, client, tmp_path, processor=process) is True
        assert handle_message(message, client, tmp_path, processor=process) is False
    assert processed == [KEY]
    assert api.states == ["processing", "ready"]


@pytest.mark.parametrize("failure", ["tool_timeout", "mime_mismatch", "password_protected"])
def test_handled_failure_records_stable_error(tmp_path, failure):
    api = PocketBaseAPI()
    with api.client() as client:
        handle_message(json.dumps(payload()), client, tmp_path,
                       processor=lambda *_: ProcessingResult(error_code=failure))
    assert api.states == ["processing", "failed"]
    assert api.record["errorCode"] == failure


def test_unexpected_processor_failure_does_not_expose_details(tmp_path):
    api = PocketBaseAPI()
    def broken(*_):
        raise RuntimeError("private input filename")
    with api.client() as client:
        handle_message(json.dumps(payload()), client, tmp_path, processor=broken)
    assert api.record["errorCode"] == "processing_failed"


@pytest.mark.parametrize("changes", [{"owner": "other-user"}, {"jobKey": "other-key"},
                                     {"status": "ready"}, {"status": "downloaded"},
                                     {"status": "processing"},
                                     {"operation": "merge_pdf"}])
def test_mismatched_or_duplicate_message_does_not_process(tmp_path, changes):
    api = PocketBaseAPI(**changes)
    def forbidden(*_):
        pytest.fail("processor must not run")
    with api.client() as client:
        handle_message(json.dumps(payload()), client, tmp_path, processor=forbidden)
    assert api.states == []


@pytest.mark.parametrize("message", [b"not-json", b"\xff", b"[]", b"null",
                                      json.dumps(payload(jobKey="../outside")).encode()])
def test_malformed_queue_message_is_discarded(tmp_path, message):
    api = PocketBaseAPI()
    with api.client() as client:
        assert handle_message(message, client, tmp_path) is False
    assert api.auth_count == 0


def test_expired_queued_job_is_cleaned_without_processing(tmp_path):
    (tmp_path / KEY).mkdir()
    api = PocketBaseAPI(expiresAt="2000-01-01 00:00:00.000Z")
    with api.client() as client:
        handle_message(json.dumps(payload()), client, tmp_path)
    assert api.record["status"] == "expired"
    assert not (tmp_path / KEY).exists()


def test_client_fetches_every_page_before_cleanup_changes_records():
    pages = []
    api = PocketBaseAPI()
    def request(req):
        if req.url.path.endswith("/records"):
            page = int(req.url.params["page"])
            pages.append(page)
            return httpx.Response(200, json={"totalPages": 2, "items": [{"id": str(page)}]})
        return api.request(req)
    with PocketBaseClient("http://pocketbase", "worker@example.test", "test-password",
                          transport=httpx.MockTransport(request)) as client:
        assert client.list_jobs() == [{"id": "1"}, {"id": "2"}]
    assert pages == [1, 2]


def test_client_reauthenticates_once_when_token_expires():
    api = PocketBaseAPI()
    attempts = []
    def request(req):
        if req.method == "GET":
            attempts.append(1)
            if len(attempts) == 1:
                return httpx.Response(401, json={"message": "expired"})
        return api.request(req)
    with PocketBaseClient("http://pocketbase", "worker@example.test", "test-password",
                          transport=httpx.MockTransport(request)) as client:
        assert client.get_job(RECORD_ID)["id"] == RECORD_ID
    assert api.auth_count == 2


def test_consumer_uses_brpop_and_cleans_idle_downloads(tmp_path):
    (tmp_path / KEY).mkdir()
    api = PocketBaseAPI(status="downloaded")
    stop = Event()
    class Queue:
        def brpop(self, name, timeout):
            assert name == "pdf-jobs" and timeout > 0
            stop.set()
            return None
    with api.client() as client:
        run_worker(Queue(), client, tmp_path, 3600, stop)
    assert not (tmp_path / KEY).exists()
    assert api.record["status"] == "expired"


def test_consumer_retries_final_status_write_without_reprocessing(tmp_path):
    api = PocketBaseAPI()
    patch_failures = []
    def request(req):
        if req.method == "PATCH" and json.loads(req.content)["status"] == "failed" and not patch_failures:
            patch_failures.append(1)
            return httpx.Response(503, json={"message": "temporarily unavailable"})
        return api.request(req)
    class Stop:
        stopped = False
        def is_set(self):
            return self.stopped
        def wait(self, _seconds):
            return self.stopped
    stop = Stop()
    class Queue:
        calls = 0
        def brpop(self, name, timeout):
            self.calls += 1
            if self.calls == 1:
                return (b"pdf-jobs", json.dumps(payload()).encode())
            stop.stopped = True
            return None
    with PocketBaseClient("http://pocketbase", "worker@example.test", "test-password",
                          transport=httpx.MockTransport(request)) as client:
        run_worker(Queue(), client, tmp_path, 3600, stop)
    assert api.states == ["processing", "failed"]
    assert api.record["errorCode"] == "processing_failed"


class BoundedStop:
    def __init__(self):
        self.stopped = False
        self.waits = 0

    def is_set(self):
        return self.stopped

    def wait(self, _seconds):
        self.waits += 1
        assert self.waits <= 5, "retry loop blocked queue progress"
        return self.stopped


class Messages:
    def __init__(self, stop, *messages):
        self.stop = stop
        self.messages = list(messages)

    def brpop(self, name, timeout):
        assert name == "pdf-jobs"
        if self.messages:
            return (b"pdf-jobs", json.dumps(self.messages.pop(0)).encode())
        self.stop.stopped = True
        return None


def test_ambiguous_processing_patch_reconciles_claim_and_finishes(tmp_path):
    api = PocketBaseAPI()
    folder = tmp_path / KEY
    folder.mkdir()
    timed_out = []

    def request(req):
        response = api.request(req)
        if req.method == "PATCH" and json.loads(req.content)["status"] == "processing" and not timed_out:
            timed_out.append(True)
            raise httpx.ReadTimeout("response lost after commit", request=req)
        return response

    stop = BoundedStop()
    with PocketBaseClient("http://pocketbase", "worker@example.test", "test-password",
                          transport=httpx.MockTransport(request)) as client:
        run_worker(Messages(stop, payload()), client, tmp_path, 3600, stop)
        assert api.states == ["processing", "failed"]
        assert api.record["errorCode"] == "processing_failed"
        # A reconciled claim is terminal and eligible for normal TTL cleanup.
        api.record["expiresAt"] = "2000-01-01 00:00:00.000Z"
        from app.cleanup import cleanup_jobs
        cleanup_jobs(tmp_path, client, 3600)
    assert api.record["status"] == "expired"
    assert not folder.exists()


@pytest.mark.parametrize("deletion_initially_locked", [False, True])
def test_deleted_record_during_result_write_cleans_folder_and_continues_queue(
    tmp_path, monkeypatch, deletion_initially_locked
):
    second_id = "record000000002"
    second_key = "550e8400-e29b-41d4-a716-446655440001"
    downloaded_id = "record000000003"
    downloaded_key = "550e8400-e29b-41d4-a716-446655440002"
    first = PocketBaseAPI()
    records = {
        RECORD_ID: first.record,
        second_id: PocketBaseAPI(id=second_id, jobKey=second_key).record,
        downloaded_id: PocketBaseAPI(id=downloaded_id, jobKey=downloaded_key, status="ready").record,
    }
    for key in (KEY, second_key, downloaded_key):
        (tmp_path / key).mkdir()
    (tmp_path / "untracked").mkdir()
    first_final_attempts = []
    if deletion_initially_locked:
        from app.cleanup import remove_job_directory
        deletion_attempts = []
        def remove_after_unlock(root, key):
            if key == KEY and not deletion_attempts:
                deletion_attempts.append(True)
                raise PermissionError("folder temporarily locked")
            return remove_job_directory(root, key)
        monkeypatch.setattr("app.worker.remove_job_directory", remove_after_unlock)

    def request(req):
        if req.url.path.endswith("auth-with-password"):
            return first.request(req)
        assert req.headers["Authorization"] == "secret-token"
        if req.url.path.endswith("/records"):
            items = list(records.values())
            if req.url.params.get("filter"):
                items = [r for r in items if r["status"] == "processing"]
            return httpx.Response(200, json={"totalPages": 1, "items": items})
        record_id = req.url.path.rsplit("/", 1)[-1]
        if req.method == "PATCH":
            changes = json.loads(req.content)
            if record_id == RECORD_ID and changes["status"] == "failed":
                first_final_attempts.append(True)
                records.pop(RECORD_ID, None)
                records[downloaded_id]["status"] = "downloaded"
                return httpx.Response(404, json={"message": "record deleted"})
            records[record_id].update(changes)
        if record_id not in records:
            return httpx.Response(404, json={"message": "record deleted"})
        return httpx.Response(200, json=records[record_id])

    stop = BoundedStop()
    with PocketBaseClient("http://pocketbase", "worker@example.test", "test-password",
                          transport=httpx.MockTransport(request)) as client:
        run_worker(Messages(stop, payload(), payload(recordId=second_id, jobKey=second_key)),
                   client, tmp_path, 3600, stop)
    assert len(first_final_attempts) <= 2
    assert records[second_id]["status"] == "failed"
    assert records[downloaded_id]["status"] == "expired"
    assert not (tmp_path / KEY).exists()
    assert not (tmp_path / downloaded_key).exists()
    assert (tmp_path / second_key).exists()
    assert (tmp_path / "untracked").exists()


class RecordingQueue:
    def __init__(self, stop, passes=2):
        self.stop = stop
        self.passes = passes
        self.calls = 0
        self.pushed = []

    def lpush(self, name, message):
        self.pushed.append((name, message))

    def brpop(self, name, timeout):
        assert name == "pdf-jobs"
        self.calls += 1
        if self.calls >= self.passes:
            self.stop.stopped = True
        return None


def test_stale_queued_message_is_republished_once_per_process(tmp_path):
    stale = (datetime.now(UTC) - timedelta(minutes=10)).isoformat()
    api = PocketBaseAPI(createdAt=stale)
    stop = BoundedStop()
    queue = RecordingQueue(stop)
    with api.client() as client:
        run_worker(queue, client, tmp_path, 3600, stop)
    expected = json.dumps({"recordId": RECORD_ID, "jobKey": KEY, "ownerId": "user1",
                           "operation": "image_to_pdf", "inputNames": ["ภาพ.png"], "options": {}})
    assert queue.pushed == [("pdf-jobs", expected)]


def test_fresh_queued_job_is_not_republished(tmp_path):
    api = PocketBaseAPI()
    stop = BoundedStop()
    queue = RecordingQueue(stop)
    with api.client() as client:
        run_worker(queue, client, tmp_path, 3600, stop)
    assert queue.pushed == []


def test_republish_skips_queued_job_without_usable_metadata(tmp_path):
    api = PocketBaseAPI(createdAt=None)
    stop = BoundedStop()
    queue = RecordingQueue(stop)
    with api.client() as client:
        run_worker(queue, client, tmp_path, 3600, stop)
    assert queue.pushed == []
