"""Reads single files out of Microsoft's healthcare data solutions (HDS) source package without downloading it all.

The package is one 6.8 GB zip on the Microsoft Download Center (https://aka.ms/HLSFabric). Its central directory is
read with HTTP range requests, and each requested member is streamed and inflated on the fly.

Licence: Microsoft Software License Terms for healthcare data solutions in Microsoft Fabric
(https://go.microsoft.com/fwlink/?LinkId=2369925). Downloading the package means accepting those terms. The OMOP
vocabularies inside it are third-party content (SNOMED CT, LOINC, RxNorm, ...) under their own terms.
"""
from __future__ import annotations

import io
import struct
import zipfile
import zlib
from pathlib import Path

import requests

HDS_VERSION = "1.4.0"
HDS_URL = ("https://download.microsoft.com/download/5d224a3e-b6c6-43b1-a639-aaf687f83fd5/"
           f"HDS%20v{HDS_VERSION}.zip")
HDS_ROOT = f"HDS v{HDS_VERSION}/"
VOCAB_DIR = HDS_ROOT + "ReferenceData/Clinical/OMOP/Vocab-HDS/"


class _HttpFile(io.RawIOBase):
    def __init__(self, url: str):
        self.url, self.pos, self.session = url, 0, requests.Session()
        self.size = int(self.session.head(url, allow_redirects=True, timeout=60).headers["Content-Length"])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def readinto(self, buffer):
        n = min(len(buffer), self.size - self.pos)
        if n <= 0:
            return 0
        resp = self.session.get(self.url, headers={"Range": f"bytes={self.pos}-{self.pos + n - 1}"}, timeout=120)
        resp.raise_for_status()
        buffer[:len(resp.content)] = resp.content
        self.pos += len(resp.content)
        return len(resp.content)


def members(url: str = HDS_URL) -> dict[str, zipfile.ZipInfo]:
    archive = zipfile.ZipFile(io.BufferedReader(_HttpFile(url), buffer_size=1 << 20))
    return {info.filename: info for info in archive.infolist()}


def extract(info: zipfile.ZipInfo, dest: Path, url: str = HDS_URL, chunk: int = 8 << 20) -> Path:
    """Streams one member to `dest`, verifying its CRC. Skips the download if `dest` already has the right size."""
    if dest.exists() and dest.stat().st_size == info.file_size:
        return dest
    session = requests.Session()
    header = session.get(url, headers={"Range": f"bytes={info.header_offset}-{info.header_offset + 29}"},
                         timeout=60).content
    name_len, extra_len = struct.unpack("<HH", header[26:30])
    start = info.header_offset + 30 + name_len + extra_len
    end = start + info.compress_size - 1
    if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        raise RuntimeError(f"Unsupported compression {info.compress_type} for {info.filename}")

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    inflater = zlib.decompressobj(-15) if info.compress_type == zipfile.ZIP_DEFLATED else None
    crc = 0
    with session.get(url, headers={"Range": f"bytes={start}-{end}"}, stream=True, timeout=600) as resp, \
            open(tmp, "wb") as out:
        resp.raise_for_status()
        for block in resp.iter_content(chunk):
            data = inflater.decompress(block) if inflater else block
            crc = zlib.crc32(data, crc)
            out.write(data)
        if inflater:
            tail = inflater.flush()
            crc = zlib.crc32(tail, crc)
            out.write(tail)
    if crc != info.CRC or tmp.stat().st_size != info.file_size:
        tmp.unlink()
        raise RuntimeError(f"CRC or size mismatch for {info.filename}")
    tmp.replace(dest)
    return dest
