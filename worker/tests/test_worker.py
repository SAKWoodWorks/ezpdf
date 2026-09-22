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
                       "operation": "image_to_pdf", "inputNames": ["ภาพ.png"],
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
            records = [self.record] if not request.url.params.get("filter") or self.record["status"] == "processing" else []
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
