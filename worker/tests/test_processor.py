from pathlib import Path
from zipfile import ZipFile

import pytest
from PIL import Image

from app.contracts import JobPayload
from app.processor import (
    process_compress,
    process_image_to_pdf,
    process_merge,
    process_pdf_to_images,
    process_split,
    process_job,
    validate_input_file,
)


@pytest.fixture
def one_page_pdf(tmp_path: Path) -> Path:
    pdf = tmp_path / "source.pdf"
    Image.new("RGB", (48, 48), "white").save(pdf, "PDF")
    return pdf


@pytest.fixture
def png_image(tmp_path: Path) -> Path:
    image = tmp_path / "source.png"
    Image.new("RGB", (48, 48), "blue").save(image, "PNG")
    return image


def test_rejects_pdf_named_as_image(tmp_path: Path):
    fake = tmp_path / "photo.png"
    fake.write_bytes(b"%PDF-1.7")
    assert validate_input_file(fake, "image_to_pdf") == "mime_mismatch"


def test_job_directory_is_uuid_scoped(tmp_path: Path):
    job = JobPayload.from_dict(
        {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "ownerId": "u",
            "operation": "merge_pdf",
            "inputNames": ["a.pdf"],
            "options": {},
        }
    )
    assert (tmp_path / job.id).name == job.id


def test_process_job_returns_a_validation_error_for_numbered_input(tmp_path: Path):
    job = JobPayload.from_dict(
        {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "ownerId": "u",
            "operation": "merge_pdf",
            "inputNames": ["untrusted-name.pdf"],
            "options": {},
        }
    )
    input_dir = tmp_path / job.id / "input"
    input_dir.mkdir(parents=True)
    (input_dir / "0001").write_bytes(b"not a PDF")

    result = process_job(job, tmp_path)

    assert result.output_path is None
    assert result.error_code == "mime_mismatch"


def test_process_job_rejects_an_invalid_page_range_before_running_tools(tmp_path: Path):
    job = JobPayload.from_dict(
        {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "ownerId": "u",
            "operation": "split_pdf",
            "inputNames": ["untrusted-name.pdf"],
            "options": {"pageRange": "4-2"},
        }
    )
    input_dir = tmp_path / job.id / "input"
    input_dir.mkdir(parents=True)
    (input_dir / "0001").write_bytes(b"%PDF-1.7")

    result = process_job(job, tmp_path)

    assert result.output_path is None
    assert result.error_code == "invalid_page_range"


def test_image_to_pdf_writes_a_pdf(png_image: Path, tmp_path: Path):
    output = tmp_path / "result.pdf"

    process_image_to_pdf([png_image], output)

    assert output.read_bytes().startswith(b"%PDF-")


def test_merge_writes_a_pdf(one_page_pdf: Path, tmp_path: Path):
    output = tmp_path / "result.pdf"

    process_merge([one_page_pdf, one_page_pdf], output)

    assert output.read_bytes().startswith(b"%PDF-")


def test_split_writes_a_deterministic_archive(one_page_pdf: Path, tmp_path: Path):
    output = process_split(one_page_pdf, tmp_path / "split", "1")

    assert output.name == "result.zip"
    with ZipFile(output) as archive:
        assert archive.namelist() == ["split-0001.pdf"]


def test_pdf_to_images_writes_a_zip(one_page_pdf: Path, tmp_path: Path):
    output = process_pdf_to_images(one_page_pdf, tmp_path / "images", "png")

    assert output.name == "result.zip"
    with ZipFile(output) as archive:
        assert archive.namelist() == ["page-0001.png"]


@pytest.mark.parametrize("preset", ["balanced", "smallest"])
def test_compress_writes_a_pdf(one_page_pdf: Path, tmp_path: Path, preset: str):
    output = tmp_path / "result.pdf"

    process_compress(one_page_pdf, output, preset)

    assert output.read_bytes().startswith(b"%PDF-")
