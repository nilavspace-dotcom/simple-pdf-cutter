"""Regenerates the test files in this folder.

They are made with other software than the tool itself - qpdf (through
pikepdf), pypdf, jbig2enc, libtiff and OpenJPEG (through Pillow and img2pdf),
and poppler - so the tests show that files from elsewhere are understood.

Usage:  pip install pikepdf pypdf cryptography img2pdf pillow
        apt install jbig2 poppler-utils    (or the equivalent for your system)
        python3 test/fixtures/make_fixtures.py
"""

import io
import subprocess
import tempfile
from pathlib import Path

import img2pdf
import pikepdf
from PIL import Image, ImageDraw
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
    make_scans()


def make_scans() -> None:
    """scans.pdf: images in the formats used by scanners, one per page:
    1. JBIG2 (lossless), 2. JBIG2 with a shared symbol dictionary (lossy),
    3. CCITT fax group 4, 4. JPEG 2000 colour, 5. JPEG 2000 gray,
    6. JPEG 2000 with transparency in the image data (SMaskInData).
    The images they were made from are saved next to it, as are photo.jpg
    (a plain JPEG for other tests) and poppler's reading of page 2."""
    bitmap = Image.new("1", (203, 61), 1)  # an odd width on purpose
    draw = ImageDraw.Draw(bitmap)
    draw.rectangle([3, 3, 60, 40], fill=0)
    draw.ellipse([80, 5, 130, 55], fill=0)
    draw.line([140, 2, 200, 58], fill=0, width=3)
    draw.text((10, 44), "SCAN TEST 123", fill=0)
    bitmap.save(HERE / "bitmap.png")

    photo = Image.new("RGB", (40, 30))
    photo.putdata(
        [((x * 6) % 256, (y * 8) % 256, ((x + y) * 4) % 256) for y in range(30) for x in range(40)]
    )
    photo.save(HERE / "photo.png")
    photo.convert("L").save(HERE / "photo-gray.png")
    photo.resize((64, 48)).save(HERE / "photo.jpg", quality=90)
    photo_alpha = photo.copy()
    alpha = Image.new("L", photo.size)
    alpha.putdata([(x * 6 + y * 3) % 256 for y in range(30) for x in range(40)])
    photo_alpha.putalpha(alpha)
    photo_alpha.save(HERE / "photo-alpha.png")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        pages = []

        # JBIG2, made with jbig2enc: a generic region, and symbol mode with globals.
        subprocess.run(["jbig2", "-p", HERE / "bitmap.png"], check=True,
                       stdout=open(tmp / "generic.jb2", "wb"), stderr=subprocess.DEVNULL)
        subprocess.run(["jbig2", "-s", "-p", "-b", tmp / "sym", HERE / "bitmap.png"], check=True,
                       stderr=subprocess.DEVNULL)
        jbig2 = pikepdf.new()
        globals_ = jbig2.make_stream(open(tmp / "sym.sym", "rb").read())
        for data, parms in ((open(tmp / "generic.jb2", "rb").read(), None),
                            (open(tmp / "sym.0000", "rb").read(), Dictionary(JBIG2Globals=globals_))):
            image = jbig2.make_stream(data)
            image.write(data, filter=Name.JBIG2Decode, decode_parms=parms)
            image.Type, image.Subtype = Name.XObject, Name.Image
            image.Width, image.Height = bitmap.size
            image.ColorSpace, image.BitsPerComponent = Name.DeviceGray, 1
            content = jbig2.make_stream(b"q 203 0 0 61 0 0 cm /Im0 Do Q")
            jbig2.pages.append(pikepdf.Page(Dictionary(
                Type=Name.Page, MediaBox=[0, 0, 203, 61], Contents=content,
                Resources=Dictionary(XObject=Dictionary(Im0=image)))))
        jbig2.save(tmp / "jbig2.pdf")
        pages.append(tmp / "jbig2.pdf")

        # CCITT group 4 (libtiff) and lossless JPEG 2000 (OpenJPEG), embedded by img2pdf.
        bitmap.save(tmp / "g4.tif", compression="group4")
        photo.save(tmp / "photo.jp2", irreversible=False)
        photo.convert("L").save(tmp / "gray.jp2", irreversible=False)
        for source in ("g4.tif", "photo.jp2", "gray.jp2"):
            (tmp / f"{source}.pdf").write_bytes(img2pdf.convert(str(tmp / source)))
            pages.append(tmp / f"{source}.pdf")

        # JPEG 2000 with transparency, which img2pdf leaves out; embedded by hand.
        photo_alpha.save(tmp / "alpha.jp2", irreversible=False)
        jpx = pikepdf.new()
        data = (tmp / "alpha.jp2").read_bytes()
        image = jpx.make_stream(data)
        image.write(data, filter=Name.JPXDecode)
        image.Type, image.Subtype = Name.XObject, Name.Image
        image.Width, image.Height = photo.size
        image.SMaskInData = 1
        jpx.pages.append(pikepdf.Page(Dictionary(
            Type=Name.Page, MediaBox=[0, 0, 40, 30],
            Contents=jpx.make_stream(b"q 40 0 0 30 0 0 cm /Im0 Do Q"),
            Resources=Dictionary(XObject=Dictionary(Im0=image)))))
        jpx.save(tmp / "alpha.pdf")
        pages.append(tmp / "alpha.pdf")

        scans = pikepdf.new()
        for part in pages:
            scans.pages.extend(pikepdf.open(part).pages)
        scans.save(HERE / "scans.pdf")

        # JBIG2 symbol mode is lossy, so what a correct reader shows is the reference.
        subprocess.run(["pdfimages", "-png", "-f", "2", "-l", "2", HERE / "scans.pdf", tmp / "ref"],
                       check=True)
        Image.open(tmp / "ref-000.png").convert("1").save(HERE / "bitmap-jbig2-symbols.png")


if __name__ == "__main__":
    main()
