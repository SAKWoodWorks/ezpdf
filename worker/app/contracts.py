from dataclasses import dataclass
from enum import Enum
from typing import Mapping


class Operation(str, Enum):
    IMAGE_TO_PDF = "image_to_pdf"
    PDF_TO_IMAGE = "pdf_to_image"
    MERGE_PDF = "merge_pdf"
    SPLIT_PDF = "split_pdf"
    COMPRESS_PDF = "compress_pdf"


@dataclass(frozen=True)
class JobPayload:
    id: str
    owner_id: str
    operation: Operation
    input_names: list[str]
    options: dict[str, object]

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "JobPayload":
        required_keys = ("id", "ownerId", "operation", "inputNames", "options")
        missing_keys = [key for key in required_keys if key not in payload]
        if missing_keys:
            raise ValueError(f"Missing required keys: {', '.join(missing_keys)}")

        try:
            operation = Operation(payload["operation"])
        except ValueError as error:
            raise ValueError(f"Unsupported operation: {payload['operation']}") from error

        return cls(
            id=str(payload["id"]),
            owner_id=str(payload["ownerId"]),
            operation=operation,
            input_names=list(payload["inputNames"]),
            options=dict(payload["options"]),
        )
