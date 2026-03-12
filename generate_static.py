#!/usr/bin/env python3
"""
generate_static.py — สร้างไฟล์ static สำหรับ deploy บน Netlify

วิธีใช้ (รันครั้งเดียวก่อน git push):
    python generate_static.py

จะสร้าง:
    index.html           — copy จาก templates/index.html
    info.json            — ข้อมูลหนังสือ (แทน /api/info)
    index-data.json      — รายชื่อบท (แทน /api/index)
    api-unavailable.json — response สำหรับ API ที่ไม่รองรับ (TTS, bookmark)
    chapters/0.json      — เนื้อหาบทที่ 0 (บทนำ)
    chapters/1.json      — เนื้อหาบทที่ 1
    ...
    chapters/1900.json

Netlify redirect rules (ใน netlify.toml):
    /api/chapter/N  →  /chapters/N.json   (200 rewrite)
    /api/info       →  /info.json          (200 rewrite)
    /api/index      →  /index-data.json    (200 rewrite)
    /api/bookmark   →  /api-unavailable.json
    /api/tts/*      →  /api-unavailable.json
"""

import os
import sys
import json
import shutil
import threading

BASE = os.path.dirname(os.path.abspath(__file__))

# ── ค้นหา PDF อัตโนมัติ ──
_PDF_CANDIDATES = [
    os.path.join(BASE, "Against the Gods อสูรพลิกฟ้า1-1900.pdf"),
    os.environ.get("PDF_PATH", ""),
    "/Users/prot/Documents/03_Reference/Books/Against the Gods อสูรพลิกฟ้า1-1900.pdf",
]
PDF_PATH = next((p for p in _PDF_CANDIDATES if p and os.path.exists(p)), None)

OUT_CHAPTER_DIR = os.path.join(BASE, "chapters")
TOTAL_CHAPTERS  = 1900


def main():
    if not PDF_PATH:
        print("❌ ไม่พบไฟล์ PDF")
        print("   วางไฟล์ PDF ไว้ในโฟลเดอร์โปรเจกต์ หรือตั้ง PDF_PATH environment variable")
        sys.exit(1)

    print(f"📄 PDF: {os.path.basename(PDF_PATH)}")

    # ── Set env so app.py uses our PDF ──
    os.environ["PDF_PATH"] = PDF_PATH

    # ── Import extraction logic from app.py ──
    sys.path.insert(0, BASE)
    from app import (
        extract_chapter, load_cache, build_index_background,
        chapter_index, index_lock, CHAPTER_CACHE_DIR
    )

    # ── Load existing chapter index ──
    load_cache()

    # ── Run background indexer (synchronous for script) ──
    import app as _app
    with _app.index_lock:
        has_index = len(_app.chapter_index) > 0

    if not has_index:
        print("🔍 Building chapter index from PDF (this takes 1-3 minutes)...")
        # Run indexer synchronously
        t = threading.Thread(target=build_index_background, daemon=False)
        t.start()
        t.join()
        print(f"✅ Index complete: {len(_app.chapter_index)} chapters found")
    else:
        print(f"✅ Loaded existing index: {len(_app.chapter_index)} chapters")

    # ── สร้างโฟลเดอร์ chapters/ ──
    os.makedirs(OUT_CHAPTER_DIR, exist_ok=True)

    # ── Extract all chapters ──
    print(f"\n📖 Extracting {TOTAL_CHAPTERS + 1} chapters...")
    success = 0
    failed  = []

    for num in range(0, TOTAL_CHAPTERS + 1):
        dest = os.path.join(OUT_CHAPTER_DIR, f"{num}.json")

        # Check if already exists from cache copy
        cache_src = os.path.join(CHAPTER_CACHE_DIR, f"ch{num:04d}.json")
        if os.path.exists(cache_src) and not os.path.exists(dest):
            shutil.copy2(cache_src, dest)
            success += 1
        elif os.path.exists(dest):
            success += 1
        else:
            # Extract fresh
            data = extract_chapter(num)
            if data:
                with open(dest, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False)
                success += 1
            else:
                failed.append(num)

        if num % 100 == 0 or num == TOTAL_CHAPTERS:
            print(f"  บทที่ {num} / {TOTAL_CHAPTERS}  ({success} สำเร็จ)", end="\r")

    print(f"\n✅ Extracted {success} chapters → chapters/")
    if failed:
        print(f"⚠️  ไม่สำเร็จ {len(failed)} บท: {failed[:10]}{'...' if len(failed) > 10 else ''}")

    # ── สร้าง info.json ──
    info = {
        "total_chapters": TOTAL_CHAPTERS,
        "indexed_chapters": success,
        "index_complete": success >= TOTAL_CHAPTERS,
        "title": "Against the Gods อสูรพลิกฟ้า",
        "author": "火星引力",
        "translator": "Aradeer",
        "static_mode": True,
    }
    with open(os.path.join(BASE, "info.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)
    print("✅ Generated info.json")

    # ── สร้าง index-data.json ──
    available = {str(n): 0 for n in range(0, TOTAL_CHAPTERS + 1)
                 if os.path.exists(os.path.join(OUT_CHAPTER_DIR, f"{n}.json"))}
    index_data = {
        "chapters": available,
        "total": TOTAL_CHAPTERS,
        "complete": len(available) >= TOTAL_CHAPTERS,
    }
    with open(os.path.join(BASE, "index-data.json"), "w", encoding="utf-8") as f:
        json.dump(index_data, f)
    print("✅ Generated index-data.json")

    # ── สร้าง api-unavailable.json ──
    with open(os.path.join(BASE, "api-unavailable.json"), "w", encoding="utf-8") as f:
        json.dump({"error": "api_unavailable", "static_mode": True,
                   "message": "This API requires the Python Flask server"}, f)
    print("✅ Generated api-unavailable.json")

    # ── Copy index.html → root ──
    src_html  = os.path.join(BASE, "templates", "index.html")
    dest_html = os.path.join(BASE, "index.html")
    if os.path.exists(src_html):
        shutil.copy2(src_html, dest_html)
        print("✅ Copied templates/index.html → index.html")
    else:
        print("⚠️  ไม่พบ templates/index.html")

    # ── Summary ──
    total_size = sum(
        os.path.getsize(os.path.join(OUT_CHAPTER_DIR, f))
        for f in os.listdir(OUT_CHAPTER_DIR)
        if f.endswith(".json")
    ) / 1024 / 1024

    print()
    print("=" * 55)
    print("✅ พร้อม deploy บน Netlify แล้ว!")
    print()
    print(f"   บทที่สร้างแล้ว: {success}/{TOTAL_CHAPTERS + 1}")
    print(f"   ขนาดไฟล์รวม:  {total_size:.1f} MB")
    print()
    print("ขั้นตอนถัดไป:")
    print("   git add index.html info.json index-data.json api-unavailable.json chapters/")
    print("   git commit -m 'Generate static chapter files for Netlify'")
    print("   git push")
    print()
    print("หมายเหตุ: TTS ไม่ทำงานบน Netlify (ต้องใช้ Flask server)")
    print("=" * 55)


if __name__ == "__main__":
    main()
