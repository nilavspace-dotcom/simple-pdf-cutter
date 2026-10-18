"""Regenerates the encrypted test PDFs in this folder.

They are made with qpdf (through pikepdf) and pypdf rather than with pdf-lib,
so the tests show that files written by other software can be opened.

Usage:  pip install pikepdf pypdf cryptography
        python3 test/fixtures/make_fixtures.py
"""

from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name
from pypdf import PdfReader, PdfWriter

HERE = Path(__file__).parent
PAGES = 30


def numbered_pdf() -> pikepdf.Pdf:
    """Same convention as makeNumberedPdf() in test/helpers.js:
    page n is (200 + n) points wide and shows "Page n"."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
    )
    for n in range(1, PAGES + 1):
        content = pikepdf.Stream(pdf, f"BT /F1 24 Tf 20 150 Td (Page {n}) Tj ET".encode())
        page = Dictionary(
            Type=Name.Page,
            MediaBox=[0, 0, 200 + n, 300],
            Contents=pdf.make_indirect(content),
            Resources=Dictionary(Font=Dictionary(F1=font)),
        )
        pdf.pages.append(pikepdf.Page(page))
    return pdf


def main() -> None:
    plain = HERE / "numbered-plain.tmp.pdf"
    numbered_pdf().save(plain)

    # Restricted but viewable without a password, like many published e-books.
    with pikepdf.open(plain) as pdf:
        pdf.save(
            HERE / "qpdf-aes256-objstreams.pdf",
            encryption=pikepdf.Encryption(owner="owner-secret", user="", R=6),
            object_stream_mode=pikepdf.ObjectStreamMode.generate,
        )
    for algorithm, name in (("RC4-40", "pypdf-rc4-40.pdf"), ("AES-128", "pypdf-aes128.pdf")):
        writer = PdfWriter(clone_from=PdfReader(plain))
        writer.encrypt(user_password="", owner_password="owner-secret", algorithm=algorithm)
        writer.write(HERE / name)

    # Needs the password "open-me" to be opened at all.
    with pikepdf.open(plain) as pdf:
        pdf.save(
            HERE / "qpdf-aes256-password.pdf",
            encryption=pikepdf.Encryption(owner="owner-secret", user="open-me", R=6),
            object_stream_mode=pikepdf.ObjectStreamMode.generate,
        )

    plain.unlink()


if __name__ == "__main__":
    main()
