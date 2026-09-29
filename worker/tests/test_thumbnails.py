from pathlib import Path
from zipfile import ZipFile

from PIL import Image

from app.processor import process_image_to_pdf, process_merge, process_pdf_to_images, process_split
from app.thumbnails import MAX_THUMBNAILS, THUMB_EDGE, thumbnail_count, generate_thumbnails


def test_thumbnail_render_size_matches_card_width_display():
    assert THUMB_EDGE == 800


def test_pdf_output_gets_one_jpeg_thumbnail_per_page(tmp_path: Path):
    result = tmp_path / "result.pdf"
    process_image_to_pdf([_png(tmp_path, "a.png"), _png(tmp_path, "b.png")], result)

    generate_thumbnails(result, tmp_path)

    thumbs = sorted((tmp_path / "thumbs").glob("thumb-*.jpg"))
    assert [p.name for p in thumbs] == ["thumb-1.jpg", "thumb-2.jpg"]
    for thumb in thumbs:
        with Image.open(thumb) as image:
            assert image.format == "JPEG"
            assert max(image.size) <= THUMB_EDGE


def test_zip_of_images_gets_thumbnails_without_rerendering(tmp_path: Path):
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    result = process_pdf_to_images([_one_page_pdf(tmp_path)], output_dir, "png")

    generate_thumbnails(result, output_dir)

    thumbs = list((output_dir / "thumbs").glob("thumb-*.jpg"))
    assert len(thumbs) == 1


def test_zip_of_split_pdfs_gets_a_thumbnail_per_part(tmp_path: Path):
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    result = process_split(_two_page_pdf(tmp_path), output_dir, "all")

    generate_thumbnails(result, output_dir)

    thumbs = list((output_dir / "thumbs").glob("thumb-*.jpg"))
    assert len(thumbs) == 2


def test_thumbnail_count_reads_the_generated_directory(tmp_path: Path):
    result = tmp_path / "result.pdf"
    process_image_to_pdf([_png(tmp_path, "a.png")], result)
    generate_thumbnails(result, tmp_path)

    assert thumbnail_count(tmp_path) == 1
    assert thumbnail_count(tmp_path / "missing") == 0


def test_thumbnail_generation_is_capped_for_large_documents(tmp_path: Path):
    pages = Path(tmp_path / "many.pdf")
    Image.new("RGB", (32, 32), "white").save(pages, "PDF", save_all=True, append_images=[
        Image.new("RGB", (32, 32), "white") for _ in range(MAX_THUMBNAILS + 5)
    ])

    generate_thumbnails(pages, tmp_path)

    assert len(list((tmp_path / "thumbs").glob("thumb-*.jpg"))) == MAX_THUMBNAILS


def test_process_job_survives_thumbnail_failures(tmp_path, monkeypatch):
    job_dir = tmp_path / "550e8400-e29b-41d4-a716-446655440000"
    (job_dir / "input").mkdir(parents=True)
    Image.new("RGB", (16, 16), "blue").save(job_dir / "input" / "0001", "PNG")
    monkeypatch.setattr("app.processor.generate_thumbnails", lambda *_: (_ for _ in ()).throw(RuntimeError("renderer missing")))
    from app.contracts import JobPayload
    from app.processor import process_job

    job = JobPayload.from_dict({
        "recordId": "record000000001",
        "jobKey": "550e8400-e29b-41d4-a716-446655440000",
        "ownerId": "user1", "operation": "image_to_pdf",
        "inputNames": ["photo.png"], "options": {},
    })

    result = process_job(job, tmp_path)

    assert result.succeeded
    assert (job_dir / "output" / "result.pdf").is_file()


def _png(tmp_path: Path, name: str) -> Path:
    image = tmp_path / name
    Image.new("RGB", (48, 48), "blue").save(image, "PNG")
    return image


def _one_page_pdf(tmp_path: Path) -> Path:
    pdf = tmp_path / "one.pdf"
    Image.new("RGB", (48, 48), "white").save(pdf, "PDF")
    return pdf


def _two_page_pdf(tmp_path: Path) -> Path:
    pdf = tmp_path / "two.pdf"
    Image.new("RGB", (48, 48), "white").save(pdf, "PDF", save_all=True, append_images=[Image.new("RGB", (48, 48), "red")])
    return pdf
