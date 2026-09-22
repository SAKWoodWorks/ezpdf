import pytest

from app.contracts import JobPayload, Operation


def test_worker_bootstrap_module_imports():
    from app import worker

    assert callable(worker.main)


def test_payload_accepts_known_operation():
    job = JobPayload.from_dict(
        {
            "recordId": "record000000001",
            "jobKey": "550e8400-e29b-41d4-a716-446655440000",
            "ownerId": "u1",
            "operation": "merge_pdf",
            "inputNames": ["a.pdf"],
            "options": {},
        }
    )
    assert job.operation is Operation.MERGE_PDF


def test_payload_rejects_unknown_operation():
    with pytest.raises(ValueError, match="Unsupported operation"):
        JobPayload.from_dict(
            {
                "recordId": "record000000001",
                "jobKey": "550e8400-e29b-41d4-a716-446655440000",
                "ownerId": "u1",
                "operation": "edit_pdf",
                "inputNames": [],
                "options": {},
            }
        )


@pytest.mark.parametrize("field", ["recordId", "ownerId", "jobKey"])
def test_payload_rejects_non_string_identifiers(field):
    payload = {
        "recordId": "record000000001",
        "jobKey": "550e8400-e29b-41d4-a716-446655440000",
        "ownerId": "u1",
        "operation": "merge_pdf",
        "inputNames": ["a.pdf"],
        "options": {},
    }
    payload[field] = 1

    with pytest.raises(ValueError, match=f"{field} must be"):
        JobPayload.from_dict(payload)


def test_payload_rejects_string_input_names():
    with pytest.raises(ValueError, match="inputNames must be a list of strings"):
        JobPayload.from_dict(
            {
                "recordId": "record000000001",
                "jobKey": "550e8400-e29b-41d4-a716-446655440000",
                "ownerId": "u1",
                "operation": "merge_pdf",
                "inputNames": "a.pdf",
                "options": {},
            }
        )


def test_payload_rejects_non_string_input_name():
    with pytest.raises(ValueError, match="inputNames must be a list of strings"):
        JobPayload.from_dict(
            {
                "recordId": "record000000001",
                "jobKey": "550e8400-e29b-41d4-a716-446655440000",
                "ownerId": "u1",
                "operation": "merge_pdf",
                "inputNames": ["a.pdf", 1],
                "options": {},
            }
        )


def test_payload_rejects_non_object_options():
    with pytest.raises(ValueError, match="options must be an object"):
        JobPayload.from_dict(
            {
                "recordId": "record000000001",
                "jobKey": "550e8400-e29b-41d4-a716-446655440000",
                "ownerId": "u1",
                "operation": "merge_pdf",
                "inputNames": ["a.pdf"],
                "options": [],
            }
        )
