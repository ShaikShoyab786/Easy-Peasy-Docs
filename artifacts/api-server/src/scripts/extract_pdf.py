from __future__ import annotations

import base64
import contextlib
import json
import mimetypes
import re
import sys
from pathlib import Path
from typing import Any

import pymupdf as fitz

MAX_PAGES = 100
MAX_TEXT_CHARACTERS = 1_000_000
MAX_EXTRACTED_IMAGE_BYTES = 12 * 1024 * 1024
MAX_IMAGES = 200
MAX_TABLES = 150

INDEX_HEADING = re.compile(
    r"^(?:table of contents|contents|index|subject index|contents and index)$",
    re.IGNORECASE,
)
INDEX_ENTRY = re.compile(r"(?:\.{2,}\s*\d{1,4}|\s{2,}\d{1,4})$")
PAGE_NUMBER = re.compile(
    r"^(?:page\s*)?\d{1,5}(?:\s*(?:of|/)\s*\d{1,5})?\.?$"
    r"|^(?:[-–—]\s*)?\(?[ivxlcdm]{1,8}\)?(?:\s*[-–—])?$",
    re.IGNORECASE,
)
BYLINE_PREFIX = re.compile(
    r"^(?:by|written by|prepared by|authored by|author(?:s)?|"
    r"contributor(?:s)?|research(?:ed)? by)\s*[:\-–]?\s*\S",
    re.IGNORECASE,
)
PERSON_WORD = re.compile(r"^(?:[A-Z][A-Za-z'’.-]+|[A-Z]\.)$")
NON_PERSON_TITLE_WORDS = {
    "annual",
    "chapter",
    "conditions",
    "contents",
    "document",
    "guide",
    "handbook",
    "index",
    "introduction",
    "manual",
    "overview",
    "policy",
    "preface",
    "procedure",
    "program",
    "report",
    "review",
    "section",
    "summary",
    "terms",
}
AFFILIATION_WORDS = re.compile(
    r"\b(?:university|department|institute|institution|foundation|"
    r"organization|organisation|center|centre|agency|laboratory|lab)\b",
    re.IGNORECASE,
)


class ExtractionError(Exception):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def clean_cell(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def line_text(line: dict[str, Any]) -> str:
    return "".join(span.get("text", "") for span in line.get("spans", [])).strip()


def line_size(line: dict[str, Any]) -> float:
    return max(
        (float(span.get("size", 0)) for span in line.get("spans", [])),
        default=0.0,
    )


def line_font(line: dict[str, Any]) -> str:
    return " ".join(str(span.get("font", "")) for span in line.get("spans", []))


def page_layout(page: fitz.Page) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    data = page.get_text("dict", sort=True)
    text_lines: list[dict[str, Any]] = []
    image_blocks: list[dict[str, Any]] = []

    for block_index, block in enumerate(data.get("blocks", [])):
        if block.get("type") == 0:
            for line in block.get("lines", []):
                text = line_text(line)
                if not text:
                    continue
                text_lines.append(
                    {
                        "text": text,
                        "bbox": [float(value) for value in line.get("bbox", [])],
                        "size": line_size(line),
                        "font": line_font(line),
                        "blockIndex": block_index,
                    }
                )
        elif block.get("type") == 1 and block.get("image"):
            image = dict(block)
            image["bbox"] = [float(value) for value in block.get("bbox", [])]
            image_blocks.append(image)

    text_lines.sort(key=lambda item: (item["bbox"][1], item["bbox"][0]))
    return text_lines, image_blocks


def is_index_page(lines: list[dict[str, Any]]) -> bool:
    populated = [line["text"] for line in lines if line["text"].strip()]
    if not populated:
        return False

    heading_index = next(
        (
            index
            for index, text in enumerate(populated[:4])
            if INDEX_HEADING.fullmatch(text.strip().rstrip(":"))
        ),
        None,
    )
    if heading_index is None:
        return False

    following_lines = populated[heading_index + 1 :]
    index_entries = sum(bool(INDEX_ENTRY.search(text)) for text in following_lines)
    return index_entries >= 2 or (
        len(following_lines) >= 8 and heading_index == 0
    )


def is_page_number_line(line: dict[str, Any], page: fitz.Page) -> bool:
    text = re.sub(r"\s+", " ", line["text"]).strip()
    bbox = line["bbox"]
    if len(bbox) != 4 or not PAGE_NUMBER.fullmatch(text):
        return False
    return bbox[1] <= page.rect.height * 0.1 or bbox[3] >= page.rect.height * 0.9


def is_person_name(text: str) -> bool:
    normalized = re.sub(r"[,;]", " ", text)
    tokens = [token.strip() for token in normalized.split() if token.strip()]
    if not 2 <= len(tokens) <= 5:
        return False
    if any(token.rstrip(".").lower() in NON_PERSON_TITLE_WORDS for token in tokens):
        return False
    return all(PERSON_WORD.fullmatch(token) for token in tokens)


def is_author_byline(
    line: dict[str, Any],
    lines: list[dict[str, Any]],
    line_index: int,
    page: fitz.Page,
    page_index: int,
    page_count: int,
) -> bool:
    text = re.sub(r"\s+", " ", line["text"]).strip()
    if not text or (page_index != 0 and page_index != page_count - 1):
        return False
    if BYLINE_PREFIX.match(text):
        return True

    if (
        len(text) > 64
        or line["size"] > 15.5
        or not is_person_name(text)
        or AFFILIATION_WORDS.search(text)
    ):
        return False

    bbox = line["bbox"]
    if len(bbox) != 4:
        return False
    nearby = lines[max(0, line_index - 2) : line_index + 3]
    has_affiliation_context = any(
        AFFILIATION_WORDS.search(nearby_line["text"]) for nearby_line in nearby
    )
    horizontal_center = (bbox[0] + bbox[2]) / 2
    is_centered = abs(horizontal_center - page.rect.width / 2) <= page.rect.width * 0.22
    is_small = line["size"] > 0 and line["size"] <= 11.5
    return has_affiliation_context or is_centered or is_small


def boxes_overlap(
    first: list[float], second: tuple[float, float, float, float], threshold: float = 0.3
) -> bool:
    if len(first) != 4:
        return False
    x0 = max(first[0], second[0])
    y0 = max(first[1], second[1])
    x1 = min(first[2], second[2])
    y1 = min(first[3], second[3])
    intersection = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    line_area = max(0.0, first[2] - first[0]) * max(0.0, first[3] - first[1])
    return line_area > 0 and intersection / line_area >= threshold


def supported_image_bytes(block: dict[str, Any]) -> tuple[bytes, str]:
    image_bytes = bytes(block.get("image", b""))
    extension = str(block.get("ext", "")).lower().lstrip(".")
    mime_type = {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "jpe": "image/jpeg",
        "png": "image/png",
        "gif": "image/gif",
        "bmp": "image/bmp",
        "webp": "image/webp",
        "tif": "image/tiff",
        "tiff": "image/tiff",
        "jp2": "image/jp2",
        "jpx": "image/jp2",
        "jbig2": "image/jbig2",
    }.get(extension)
    if not mime_type:
        mime_type = mimetypes.guess_type(f"image.{extension}")[0] or "application/octet-stream"
    return image_bytes, mime_type


def extract_document(pdf_path: Path) -> dict[str, Any]:
    try:
        document = fitz.open(pdf_path)
    except Exception as error:
        raise ExtractionError("This file is not a valid PDF.", 400) from error

    with document:
        if document.needs_pass:
            raise ExtractionError("Password-protected PDFs are not supported yet.")
        page_count = document.page_count
        if page_count == 0:
            raise ExtractionError("This PDF has no pages.", 400)
        if page_count > MAX_PAGES:
            raise ExtractionError(
                f"This PDF has {page_count} pages. The current limit is {MAX_PAGES}.",
                413,
            )

        blocks: list[dict[str, Any]] = []
        extracted_text_parts: list[str] = []
        extracted_text_characters = 0
        extracted_image_bytes = 0
        removed_page_numbers = 0
        removed_author_bylines = 0
        skipped_index_pages = 0
        image_count = 0
        table_count = 0
        sequence = 0

        for page_index, page in enumerate(document):
            lines, image_blocks = page_layout(page)
            if is_index_page(lines):
                skipped_index_pages += 1
                continue

            tables: list[tuple[tuple[float, float, float, float], list[list[str]]]] = []
            try:
                detected_tables = page.find_tables()
                for table in detected_tables.tables:
                    rows = [
                        [clean_cell(cell) for cell in row]
                        for row in (table.extract() or [])
                    ]
                    rows = [row for row in rows if any(cell for cell in row)]
                    if rows:
                        tables.append((tuple(float(v) for v in table.bbox), rows))
            except Exception as error:
                raise ExtractionError(
                    "A page could not be inspected completely. Try another PDF."
                ) from error

            if table_count + len(tables) > MAX_TABLES:
                raise ExtractionError(
                    f"This PDF contains more than {MAX_TABLES} extractable tables.",
                    413,
                )

            page_items: list[tuple[float, float, dict[str, Any]]] = []
            grouped_lines: dict[int, list[dict[str, Any]]] = {}
            for line_index, line in enumerate(lines):
                if is_page_number_line(line, page):
                    removed_page_numbers += 1
                    continue
                if is_author_byline(
                    line, lines, line_index, page, page_index, page_count
                ):
                    removed_author_bylines += 1
                    continue
                if any(boxes_overlap(line["bbox"], bbox) for bbox, _ in tables):
                    continue
                grouped_lines.setdefault(line["blockIndex"], []).append(line)

            for kept_lines in grouped_lines.values():
                text = "\n".join(line["text"] for line in kept_lines).strip()
                if not text:
                    continue
                kept_boxes = [line["bbox"] for line in kept_lines]
                bbox = [
                    min(box[0] for box in kept_boxes),
                    min(box[1] for box in kept_boxes),
                    max(box[2] for box in kept_boxes),
                    max(box[3] for box in kept_boxes),
                ]
                page_items.append(
                    (
                        bbox[1],
                        bbox[0],
                        {
                            "type": "text",
                            "pageIndex": page_index,
                            "text": text,
                            "bbox": bbox,
                        },
                    )
                )

            for block in image_blocks:
                image_bytes, mime_type = supported_image_bytes(block)
                if not image_bytes:
                    continue
                extracted_image_bytes += len(image_bytes)
                image_count += 1
                if extracted_image_bytes > MAX_EXTRACTED_IMAGE_BYTES:
                    raise ExtractionError(
                        "The PDF contains more than 12 MB of extracted images; it cannot be previewed in one request.",
                        413,
                    )
                if image_count > MAX_IMAGES:
                    raise ExtractionError(
                        f"This PDF contains more than {MAX_IMAGES} extractable images.",
                        413,
                    )
                bbox = block.get("bbox", [])
                if len(bbox) != 4:
                    continue
                page_items.append(
                    (
                        bbox[1],
                        bbox[0],
                        {
                            "type": "image",
                            "pageIndex": page_index,
                            "imageDataUrl": (
                                f"data:{mime_type};base64,"
                                f"{base64.b64encode(image_bytes).decode('ascii')}"
                            ),
                            "imageMimeType": mime_type,
                            "imageWidth": int(block.get("width", 0)),
                            "imageHeight": int(block.get("height", 0)),
                            "bbox": bbox,
                        },
                    )
                )

            for bbox, rows in tables:
                page_items.append(
                    (
                        bbox[1],
                        bbox[0],
                        {
                            "type": "table",
                            "pageIndex": page_index,
                            "rows": rows,
                            "bbox": list(bbox),
                        },
                    )
                )

            page_items.sort(key=lambda item: (item[0], item[1]))
            for _, _, block in page_items:
                sequence += 1
                block["sequence"] = sequence
                blocks.append(block)
                if block["type"] == "text":
                    extracted_text_parts.append(block["text"])
                    extracted_text_characters += len(block["text"])
                    if extracted_text_characters > MAX_TEXT_CHARACTERS:
                        raise ExtractionError(
                            "This PDF contains too much text to preview at once.",
                            413,
                        )
                elif block["type"] == "table":
                    table_count += 1

        extracted_text = "\n\n".join(extracted_text_parts).strip()
        if not extracted_text:
            raise ExtractionError(
                "No selectable text was found. Scanned PDFs are not supported in this phase."
            )

        return {
            "pageCount": page_count,
            "extractedText": extracted_text,
            "blocks": blocks,
            "summary": {
                "skippedIndexPages": skipped_index_pages,
                "removedPageNumberLines": removed_page_numbers,
                "removedAuthorBylines": removed_author_bylines,
                "imageCount": image_count,
                "tableCount": table_count,
            },
        }


def main() -> None:
    try:
        if len(sys.argv) != 2:
            raise ExtractionError("An input PDF path is required.", 400)
        with contextlib.redirect_stdout(sys.stderr):
            result = extract_document(Path(sys.argv[1]))
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    except ExtractionError as error:
        print(
            json.dumps(
                {"error": str(error), "status": error.status},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
    except Exception:
        print(
            json.dumps(
                {
                    "error": "This PDF could not be processed. Try another text-based PDF.",
                    "status": 422,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )


if __name__ == "__main__":
    main()
