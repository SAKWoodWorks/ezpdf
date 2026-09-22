import pytest

from app.contracts import JobPayload, Operation


def test_payload_accepts_known_operation():
    job = JobPayload.from_dict(
        {
            "id": "j1",
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
                "id": "j1",
                "ownerId": "u1",
                "operation": "edit_pdf",
                "inputNames": [],
                "options": {},
            }
        )
