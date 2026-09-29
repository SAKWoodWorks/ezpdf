"""Best-effort JPEG page previews generated beside each processed result."""

import subprocess
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

from PIL import Image

MAX_THUMBNAILS = 50
THUMB_EDGE = 800
PDF_OPERATIONS_SUFFIX = ".pdf"


def generate_thumbnails(output: Path, output_dir: Path) -> None:
    """Write up to ``MAX_THUMBNAILS`` numbered JPEGs into ``output_dir/thumbs``.

    Callers treat failures as non-fatal: a job stays ``ready`` without previews.
    """
    thumbs = output_dir / "thumbs"
    thumbs.mkdir(exist_ok=True)
    if output.suffix == PDF_OPERATIONS_SUFFIX:
        _thumbnails_for_pdf(output, thumbs)
        return
    with ZipFile(output) as archive:
        for index, name in enumerate(_sorted_entries(archive), start=1):
            if index > MAX_THUMBNAILS:
                break
            with archive.open(name) as source:
                data = source.read()
            if name.lower().endswith(PDF_OPERATIONS_SUFFIX):
                _thumbnail_from_pdf_bytes(data, thumbs, index)
            else:
                _write_image_thumbnail(data, thumbs / f"thumb-{index}.jpg")


def thumbnail_count(output_dir: Path) -> int:
    """Return the number of previews stored beside one job's output."""
    try:
        return len(list((output_dir / "thumbs").glob("thumb-*.jpg")))
    except OSError:
        return 0


def _sorted_entries(archive: ZipFile) -> list[str]:
    def page_number(name: str) -> tuple[int, str]:
        stem = Path(name).stem.rsplit("-", 1)[-1]
        return (int(stem) if stem.isdigit() else 0, name)

    return sorted(
        (name for name in archive.namelist() if not name.endswith("/")),
        key=page_number,
    )


def _thumbnails_for_pdf(source: Path, thumbs: Path) -> None:
    subprocess.run(
        ["pdftoppm", "-jpeg", "-scale-to", str(THUMB_EDGE), str(source), str(thumbs / "page")],
        shell=False, check=True, timeout=300, capture_output=True, text=True,
    )
    pages = sorted(thumbs.glob("page-*.jpg"), key=lambda path: int(path.stem.rsplit("-", 1)[-1]))
    for index, page in enumerate(pages[:MAX_THUMBNAILS], start=1):
        page.rename(thumbs / f"thumb-{index}.jpg")


def _thumbnail_from_pdf_bytes(data: bytes, thumbs: Path, index: int) -> None:
    single = thumbs / f"part-{index}.pdf"
    single.write_bytes(data)
    try:
        subprocess.run(
            ["pdftoppm", "-jpeg", "-scale-to", str(THUMB_EDGE), "-f", "1", "-l", "1",
             str(single), str(thumbs / f"part-{index}")],
            shell=False, check=True, timeout=300, capture_output=True, text=True,
        )
        produced = sorted(thumbs.glob(f"part-{index}-*.jpg"))
        if produced:
            produced[0].rename(thumbs / f"thumb-{index}.jpg")
    finally:
        single.unlink(missing_ok=True)
        for leftover in thumbs.glob(f"part-{index}-*.jpg"):
            leftover.unlink(missing_ok=True)


def _write_image_thumbnail(data: bytes, target: Path) -> None:
    with Image.open(BytesIO(data)) as image:
        converted = image.convert("RGB")
        converted.thumbnail((THUMB_EDGE, THUMB_EDGE))
        converted.save(target, "JPEG", quality=70)
