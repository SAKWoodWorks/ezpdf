"""Validated, shell-free PDF processing primitives for one job directory."""

from __future__ import annotations

import re
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import zlib

from PIL import Image, UnidentifiedImageError

from app.config import MAX_INPUT_BYTES, TOOL_TIMEOUT_SECONDS
from app.contracts import JobPayload, Operation
from app.thumbnails import generate_thumbnails


PDF_OPERATIONS = {
    Operation.PDF_TO_IMAGE,
    Operation.MERGE_PDF,
    Operation.SPLIT_PDF,
    Operation.COMPRESS_PDF,
}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}
IMAGE_FORMAT_SUFFIXES = {"JPEG": {".jpg", ".jpeg"}, "PNG": {".png"}}
PDF_SUFFIX = ".pdf"
PAGE_SPEC_PATTERN = re.compile(r"^(?:all|\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$)")
GS_PRESETS = {"balanced": "/ebook", "smallest": "/screen"}


class InvalidPageRange(ValueError):
    """Raised only for a client-supplied page range that is malformed."""


@dataclass(frozen=True)
class ProcessingResult:
    output_path: Path | None = None
    error_code: str | None = None

    @property
    def succeeded(self) -> bool:
        return self.output_path is not None and self.error_code is None


def run_tool(args: list[str], timeout_seconds: int = TOOL_TIMEOUT_SECONDS) -> None:
    """Run one native utility without a shell or inherited command parsing."""
    subprocess.run(
        args,
        shell=False,
        check=True,
        timeout=timeout_seconds,
        capture_output=True,
        text=True,
    )


def validate_input_file(input_file: Path, operation: str | Operation) -> str | None:
    """Return a stable client error code, or ``None`` when the file is usable."""
    if not input_file.is_file():
        return "processing_failed"
    if input_file.stat().st_size > MAX_INPUT_BYTES:
        return "input_too_large"

    try:
        selected_operation = Operation(operation)
    except ValueError:
        return "unsupported_type"

    with input_file.open("rb") as source:
        is_pdf = source.read(5) == b"%PDF-"
    suffix = input_file.suffix.lower()

    if selected_operation is Operation.IMAGE_TO_PDF:
        if is_pdf:
            return "mime_mismatch"
        if suffix and suffix not in IMAGE_SUFFIXES:
            return "unsupported_type"
        try:
            with Image.open(input_file) as image:
                detected_format = image.format
                image.verify()
        except (
            OSError,
            SyntaxError,
            ValueError,
            zlib.error,
            UnidentifiedImageError,
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
        ):
            return "mime_mismatch"
        if detected_format not in IMAGE_FORMAT_SUFFIXES:
            return "unsupported_type"
        if suffix and suffix not in IMAGE_FORMAT_SUFFIXES[detected_format]:
            return "mime_mismatch"
        return None

    if selected_operation in PDF_OPERATIONS:
        if suffix in IMAGE_SUFFIXES:
            return "mime_mismatch"
        if suffix and suffix != PDF_SUFFIX:
            return "unsupported_type"
        return None if is_pdf else "mime_mismatch"

    return "unsupported_type"


def process_image_to_pdf(inputs: list[Path], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    run_tool(["img2pdf", "--output", str(output), *(str(item) for item in inputs)])


def process_pdf_to_images(input_pdf: Path, output_dir: Path, image_format: str) -> Path:
    normalized_format = _normalize_image_format(image_format)
    output_dir.mkdir(parents=True, exist_ok=True)
    prefix = output_dir / "page"
    run_tool(["pdftoppm", f"-{normalized_format}", str(input_pdf), str(prefix)])

    extension = "jpg" if normalized_format == "jpeg" else normalized_format
    images = sorted(output_dir.glob(f"page-*.{extension}"))
    if not images:
        raise RuntimeError("pdftoppm produced no image files")
    output = output_dir / "result.zip"
    _write_zip(output, images, "page", extension)
    _remove_files(images)
    return output


def process_merge(inputs: list[Path], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    run_tool(["qpdf", "--empty", "--pages", *(str(item) for item in inputs), "--", str(output)])


def process_split(input_pdf: Path, output_dir: Path, page_spec: str) -> Path:
    _validate_page_spec(page_spec)
    output_dir.mkdir(parents=True, exist_ok=True)
    selected_pdf = output_dir / "selected.pdf"
    source = input_pdf
    if page_spec != "all":
        run_tool(
            [
                "qpdf",
                "--empty",
                "--pages",
                str(input_pdf),
                page_spec,
                "--",
                str(selected_pdf),
            ]
        )
        source = selected_pdf

    try:
        run_tool(
            ["qpdf", "--split-pages", str(source), str(output_dir / "split-%d.pdf")]
        )
        pages = sorted(output_dir.glob("split-*.pdf"))
        if not pages:
            raise RuntimeError("qpdf produced no split PDF files")
        output = output_dir / "result.zip"
        _write_zip(output, pages, "split", "pdf")
        _remove_files(pages)
        return output
    finally:
        selected_pdf.unlink(missing_ok=True)


def process_compress(input_pdf: Path, output: Path, preset: str) -> None:
    if preset not in GS_PRESETS:
        raise ValueError("unsupported compression preset")
    output.parent.mkdir(parents=True, exist_ok=True)
    run_tool(
        [
            "gs",
            "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.4",
            f"-dPDFSETTINGS={GS_PRESETS[preset]}",
            "-dNOPAUSE",
            "-dQUIET",
            "-dBATCH",
            f"-sOutputFile={output}",
            str(input_pdf),
        ]
    )


def process_job(job: JobPayload, jobs_dir: Path) -> ProcessingResult:
    """Process server-numbered input files within exactly one UUID job directory."""
    try:
        job_dir = _job_directory(jobs_dir, job.job_key)
        inputs = _numbered_input_files(job_dir, len(job.input_names))
        if not inputs:
            return ProcessingResult(error_code="processing_failed")
        if sum(item.stat().st_size for item in inputs) > MAX_INPUT_BYTES:
            return ProcessingResult(error_code="input_too_large")
        for input_file in inputs:
            error_code = validate_input_file(input_file, job.operation)
            if error_code:
                return ProcessingResult(error_code=error_code)
        if job.operation is Operation.SPLIT_PDF:
            _validate_page_spec(str(job.options.get("pageRange", "all")))
        if job.operation in PDF_OPERATIONS and any(
            _requires_password(input_file) for input_file in inputs
        ):
            return ProcessingResult(error_code="password_protected")

        output_dir = _output_directory(job_dir)
        if job.operation is Operation.IMAGE_TO_PDF:
            output = output_dir / "result.pdf"
            process_image_to_pdf(inputs, output)
        elif job.operation is Operation.PDF_TO_IMAGE:
            image_format = str(job.options.get("imageFormat", "png"))
            output = process_pdf_to_images(inputs[0], output_dir, image_format)
        elif job.operation is Operation.MERGE_PDF:
            output = output_dir / "result.pdf"
            process_merge(inputs, output)
        elif job.operation is Operation.SPLIT_PDF:
            page_spec = str(job.options.get("pageRange", "all"))
            output = process_split(inputs[0], output_dir, page_spec)
        elif job.operation is Operation.COMPRESS_PDF:
            output = output_dir / "result.pdf"
            preset = str(job.options.get("preset", "balanced"))
            process_compress(inputs[0], output, preset)
        else:
            return ProcessingResult(error_code="unsupported_type")
        try:
            generate_thumbnails(output, output_dir)
        except Exception:
            # Previews are best-effort and never fail a finished job.
            pass
        return ProcessingResult(output_path=output)
    except InvalidPageRange:
        return ProcessingResult(error_code="invalid_page_range")
    except ValueError:
        return ProcessingResult(error_code="processing_failed")
    except subprocess.TimeoutExpired:
        return ProcessingResult(error_code="tool_timeout")
    except subprocess.CalledProcessError as error:
        if "password" in _tool_error_text(error).lower():
            return ProcessingResult(error_code="password_protected")
        return ProcessingResult(error_code="processing_failed")
    except (FileNotFoundError, OSError, RuntimeError):
        return ProcessingResult(error_code="processing_failed")


def _job_directory(jobs_dir: Path, job_id: str) -> Path:
    parsed_id = uuid.UUID(job_id)
    if str(parsed_id) != job_id:
        raise ValueError("job id must be a canonical UUID")
    root = jobs_dir.resolve()
    requested_job_dir = root / job_id
    if requested_job_dir.is_symlink():
        raise ValueError("job directory must not be a symlink")
    job_dir = requested_job_dir.resolve()
    if not _is_within(job_dir, root) or not job_dir.is_dir():
        raise ValueError("job directory is outside jobs root")
    return job_dir


def _numbered_input_files(job_dir: Path, expected_count: int) -> list[Path]:
    input_dir = job_dir / "input"
    if input_dir.is_symlink() or not input_dir.is_dir():
        raise ValueError("job input directory is missing")
    resolved_input_dir = input_dir.resolve()
    files = sorted(
        (item for item in input_dir.iterdir() if item.is_file() and not item.is_symlink()),
        key=lambda item: item.name,
    )
    if len(files) != expected_count:
        raise ValueError("job input count does not match payload")
    for input_file in files:
        if not _is_within(input_file.resolve(), resolved_input_dir):
            raise ValueError("input file is outside the job directory")
    return files


def _output_directory(job_dir: Path) -> Path:
    output_dir = job_dir / "output"
    if output_dir.is_symlink():
        raise ValueError("job output directory must not be a symlink")
    output_dir.mkdir(exist_ok=True)
    resolved_output_dir = output_dir.resolve()
    if not _is_within(resolved_output_dir, job_dir):
        raise ValueError("job output directory is outside the job directory")
    return resolved_output_dir


def _requires_password(input_pdf: Path) -> bool:
    try:
        run_tool(["qpdf", "--requires-password", str(input_pdf)])
    except subprocess.CalledProcessError:
        return False
    return True


def _normalize_image_format(image_format: str) -> str:
    normalized = image_format.lower()
    if normalized == "jpg":
        normalized = "jpeg"
    if normalized not in {"png", "jpeg"}:
        raise ValueError("unsupported image format")
    return normalized


def _validate_page_spec(page_spec: str) -> None:
    if not PAGE_SPEC_PATTERN.fullmatch(page_spec):
        raise InvalidPageRange("invalid page range")
    if page_spec == "all":
        return
    for item in page_spec.split(","):
        if "-" in item:
            start, end = (int(value) for value in item.split("-"))
            if start < 1 or start > end:
                raise InvalidPageRange("invalid page range")
        elif int(item) < 1:
            raise InvalidPageRange("invalid page range")


def _write_zip(output: Path, files: list[Path], prefix: str, extension: str) -> None:
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for index, file_path in enumerate(files, start=1):
            archive.write(file_path, arcname=f"{prefix}-{index:04d}.{extension}")


def _remove_files(files: list[Path]) -> None:
    for file_path in files:
        file_path.unlink(missing_ok=True)


def _tool_error_text(error: subprocess.CalledProcessError) -> str:
    return " ".join(
        value for value in (error.stdout, error.stderr, str(error)) if value
    )


def _is_within(path: Path, parent: Path) -> bool:
    return path.is_relative_to(parent)
