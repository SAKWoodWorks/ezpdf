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


def test_rejects_gif_disguised_as_png(tmp_path: Path):
    fake = tmp_path / "photo.png"
    Image.new("RGB", (4, 4), "red").save(fake, "GIF")

    assert validate_input_file(fake, "image_to_pdf") == "unsupported_type"


def test_accepts_a_numbered_png_upload_without_a_suffix(tmp_path: Path):
    numbered_upload = tmp_path / "0001"
    Image.new("RGB", (4, 4), "blue").save(numbered_upload, "PNG")

    assert validate_input_file(numbered_upload, "image_to_pdf") is None


def test_rejects_a_png_with_a_jpeg_suffix(tmp_path: Path):
    fake = tmp_path / "photo.jpg"
    Image.new("RGB", (4, 4), "blue").save(fake, "PNG")

    assert validate_input_file(fake, "image_to_pdf") == "mime_mismatch"


def test_job_directory_is_uuid_scoped(tmp_path: Path):
    job = JobPayload.from_dict(
        {
            "recordId": "record000000001",
            "jobKey": "550e8400-e29b-41d4-a716-446655440000",
            "ownerId": "u",
            "operation": "merge_pdf",
            "inputNames": ["a.pdf"],
            "options": {},
        }
    )
    assert (tmp_path / job.job_key).name == job.job_key


def test_process_job_returns_a_validation_error_for_numbered_input(tmp_path: Path):
    job = JobPayload.from_dict(
        {
            "recordId": "record000000001",
            "jobKey": "550e8400-e29b-41d4-a716-446655440000",
            "ownerId": "u",
            "operation": "merge_pdf",
            "inputNames": ["untrusted-name.pdf"],
            "options": {},
        }
    )
    input_dir = tmp_path / job.job_key / "input"
    input_dir.mkdir(parents=True)
    (input_dir / "0001").write_bytes(b"not a PDF")

    result = process_job(job, tmp_path)

    assert result.output_path is None
    assert result.error_code == "mime_mismatch"


def test_process_job_maps_a_pillow_decompression_bomb_to_a_client_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    job = JobPayload.from_dict(
        {
            "recordId": "record000000001",
            "jobKey": "550e8400-e29b-41d4-a716-446655440000",
            "ownerId": "u",
            "operation": "image_to_pdf",
            "inputNames": ["untrusted-name.png"],
            "options": {},
        }
    )
    input_dir = tmp_path / job.job_key / "input"
    input_dir.mkdir(parents=True)
    Image.new("RGB", (4, 4), "green").save(input_dir / "0001", "PNG")
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 1)

    result = process_job(job, tmp_path)

    assert result.output_path is None
    assert result.error_code == "mime_mismatch"


def test_process_job_rejects_an_invalid_page_range_before_running_tools(tmp_path: Path):
    job = JobPayload.from_dict(
        {
            "recordId": "record000000001",
            "jobKey": "550e8400-e29b-41d4-a716-446655440000",
            "ownerId": "u",
            "operation": "split_pdf",
            "inputNames": ["untrusted-name.pdf"],
            "options": {"pageRange": "4-2"},
        }
    )
    input_dir = tmp_path / job.job_key / "input"
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
