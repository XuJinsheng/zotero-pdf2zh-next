"""Exercise dependency APIs used by the bundled PDF runtime without cloud services."""

from __future__ import annotations

import unittest
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

import pymupdf
from pypdf import PdfReader

from babeldoc.format.pdf.document_il import il_version_1
from babeldoc.format.pdf.document_il.xml_converter import XMLConverter
from babeldoc.format.pdf.document_il.utils.mupdf_helper import get_no_rotation_img
from babeldoc.format.pdf.document_il.utils.zstd_helper import (
    zstd_compress,
    zstd_decompress,
)
from babeldoc.pdfminer.high_level import extract_text


class DependencyCompatibilityTests(unittest.TestCase):
    def test_pdf_creation_extraction_rotation_and_rendering(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "sample.pdf"
            with pymupdf.open() as document:
                page = document.new_page(width=200, height=300)
                page.insert_text((20, 40), "Dependency upgrade")
                page.set_rotation(90)
                document.save(path)

            with pymupdf.open(path) as document:
                page = document[0]
                pixmap = get_no_rotation_img(page)
                self.assertEqual((pixmap.width, pixmap.height), (200, 300))
                self.assertEqual(page.rotation, 90)
                self.assertIn("Dependency upgrade", page.get_text())
                self.assertTrue(page.get_texttrace())
                self.assertTrue(document.extract_font(page.get_fonts()[0][0]))

            data = path.read_bytes()
            self.assertIn(
                "Dependency upgrade", PdfReader(BytesIO(data)).pages[0].extract_text()
            )
            self.assertEqual(
                "".join(extract_text(BytesIO(data)).split()), "Dependencyupgrade"
            )

    def test_intermediate_document_xml_and_compression_round_trip(self) -> None:
        document = il_version_1.Document(total_pages=0)
        converter = XMLConverter()
        xml = converter.to_xml(document)
        self.assertEqual(converter.from_xml(xml), document)
        self.assertEqual(zstd_decompress(zstd_compress(xml)), xml)


if __name__ == "__main__":
    unittest.main()
