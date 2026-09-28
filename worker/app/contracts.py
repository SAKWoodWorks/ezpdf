from dataclasses import dataclass
from enum import Enum
import re
from typing import Mapping
from uuid import UUID


class Operation(str, Enum):
    IMAGE_TO_PDF = "image_to_pdf"
    PDF_TO_IMAGE = "pdf_to_image"
    MERGE_PDF = "merge_pdf"
    SPLIT_PDF = "split_pdf"
    COMPRESS_PDF = "compress_pdf"


@dataclass(frozen=True)
class JobPayload:
    record_id: str
    job_key: str
    owner_id: str
    operation: Operation
    input_names: list[str]
    options: dict[str, object]

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "JobPayload":
        required_keys = ("recordId", "jobKey", "ownerId", "operation", "inputNames", "options")
        missing_keys = [key for key in required_keys if key not in payload]
        if missing_keys:
            raise ValueError(f"Missing required keys: {', '.join(missing_keys)}")

        record_id = payload["recordId"]
        if not isinstance(record_id, str) or not re.fullmatch(r"[a-zA-Z0-9]{15}", record_id):
            raise ValueError("recordId must be a PocketBase record ID")
        job_key = payload["jobKey"]
        if not isinstance(job_key, str) or str(UUID(job_key)) != job_key:
            raise ValueError("jobKey must be a canonical UUID")

        owner_id = payload["ownerId"]
        if not isinstance(owner_id, str) or not owner_id:
            raise ValueError("ownerId must be a non-empty string")

        input_names = payload["inputNames"]
        if not isinstance(input_names, list) or not all(
            isinstance(name, str) for name in input_names
        ):
            raise ValueError("inputNames must be a list of strings")

        options = payload["options"]
        if not isinstance(options, dict):
            raise ValueError("options must be an object")

        try:
            operation = Operation(payload["operation"])
        except ValueError as error:
            raise ValueError(f"Unsupported operation: {payload['operation']}") from error

        return cls(
            record_id=record_id,
            job_key=job_key,
            owner_id=owner_id,
            operation=operation,
            input_names=input_names,
            options=options,
        )
