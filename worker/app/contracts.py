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

        id_value = payload["id"]
        if not isinstance(id_value, str) or not id_value:
            raise ValueError("id must be a non-empty string")

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
            id=id_value,
            owner_id=owner_id,
            operation=operation,
            input_names=input_names,
            options=options,
        )
