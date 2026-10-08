import tempfile
import unittest
from pathlib import Path

import pymupdf as fitz

from extract_pdf import extract_document


class PdfOcrTests(unittest.TestCase):
    def scanned_page(self, text: str) -> fitz.Document:
        source = fitz.open()
        source_page = source.new_page(width=612, height=792)
        source_page.insert_text((48, 90), text, fontsize=20)
        page_image = source_page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)

        scanned = fitz.open()
        scanned_page = scanned.new_page(width=612, height=792)
        scanned_page.insert_image(scanned_page.rect, stream=page_image.tobytes("png"))
        source.close()
        return scanned

    def extract(self, document: fitz.Document) -> dict:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ocr-fixture.pdf"
            document.save(path)
            document.close()
            return extract_document(path)

    def test_scanned_page_text_is_recognized_with_confidence(self) -> None:
        result = self.extract(
            self.scanned_page("Your benefits begin on January 15, 2027.")
        )
        self.assertIn("benefits begin", result["extractedText"].lower())
        self.assertEqual(result["summary"]["ocrPageCount"], 1)
        self.assertEqual(result["summary"]["ocrFailedPageCount"], 0)
        ocr_blocks = [block for block in result["blocks"] if block.get("isOcr")]
        self.assertTrue(ocr_blocks)
        self.assertGreaterEqual(ocr_blocks[0]["ocrConfidence"], 60)

    def test_embedded_image_text_is_added_alongside_selectable_text(self) -> None:
        source = fitz.open()
        page = source.new_page(width=612, height=792)
        page.insert_text((48, 70), "Selectable policy heading", fontsize=18)

        image_source = fitz.open()
        image_page = image_source.new_page(width=500, height=120)
        image_page.insert_text((18, 62), "Image text: submit your claim within 30 days.", fontsize=17)
        image = image_page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).tobytes("png")
        page.insert_image(fitz.Rect(48, 110, 548, 230), stream=image)
        image_source.close()

        result = self.extract(source)
        self.assertIn("Selectable policy heading", result["extractedText"])
        self.assertIn("submit your claim", result["extractedText"].lower())
        self.assertEqual(result["summary"]["ocrPageCount"], 1)

    def test_contents_heading_match_skips_front_matter_for_simplification(self) -> None:
        source = fitz.open()
        page = source.new_page(width=612, height=792)
        page.insert_text((48, 70), "ABSTRACT", fontsize=20)
        page.insert_text((48, 105), "Government order and policy overview.", fontsize=12)

        page = source.new_page(width=612, height=792)
        page.insert_text((48, 80), "ANNEXURE - I", fontsize=22)

        page = source.new_page(width=612, height=792)
        page.insert_text((48, 70), "CONTENTS", fontsize=18)
        page.insert_text(
            (48, 110),
            "ABBREVIATIONS ........................................ 3",
            fontsize=11,
        )
        page.insert_text(
            (48, 140),
            "1. GLOBAL SPACE INDUSTRY TRENDS .................... 4",
            fontsize=11,
        )
        page.insert_text(
            (48, 170),
            "2. POLICY VISION .................................... 5",
            fontsize=11,
        )

        page = source.new_page(width=612, height=792)
        page.insert_text((48, 70), "ABBREVIATIONS", fontsize=20)
        page.insert_text((48, 110), "LEO — Low Earth Orbit", fontsize=12)

        page = source.new_page(width=612, height=792)
        page.insert_text((48, 70), "1. GLOBAL SPACE INDUSTRY TRENDS", fontsize=18)
        page.insert_text((48, 110), "The space economy is changing quickly.", fontsize=12)

        result = self.extract(source)
        start = result["mainContentStart"]
        self.assertEqual(start["confidence"], "high")
        self.assertEqual(start["candidates"][0]["heading"], "1. GLOBAL SPACE INDUSTRY TRENDS")
        self.assertEqual(start["candidates"][0]["pageIndex"], 4)
        self.assertEqual(result["summary"]["skippedIndexPages"], 1)
        self.assertIn("ABBREVIATIONS", result["extractedText"])

    def test_missing_contents_requires_review_of_detected_section(self) -> None:
        source = fitz.open()
        page = source.new_page(width=612, height=792)
        page.insert_text((48, 70), "Policy title", fontsize=22)
        page.insert_text((48, 110), "A short opening page.", fontsize=12)

        page = source.new_page(width=612, height=792)
        page.insert_text((48, 70), "ABBREVIATIONS", fontsize=20)

        page = source.new_page(width=612, height=792)
        page.insert_text((48, 70), "1. MAIN CONTENT", fontsize=18)
        page.insert_text((48, 110), "The main material starts here.", fontsize=12)

        result = self.extract(source)
        start = result["mainContentStart"]
        self.assertEqual(start["confidence"], "review")
        self.assertTrue(start["candidates"])
        self.assertEqual(start["candidates"][0]["heading"], "1. MAIN CONTENT")
        self.assertEqual(start["candidates"][0]["pageIndex"], 2)


if __name__ == "__main__":
    unittest.main()
