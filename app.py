#!/usr/bin/env python3
"""Against the Gods - Novel Reading Web Server
On-demand PDF extraction with pypdf (fast) and chapter caching."""

import os
import re
import json
import asyncio
import hashlib
import threading
from datetime import datetime
from flask import Flask, jsonify, render_template, Response, request

app = Flask(__name__)

# Support both local development and Netlify deployment
PDF_PATH = os.getenv(
    "PDF_PATH",
    "/Users/prot/Documents/03_Reference/Books/Against the Gods อสูรพลิกฟ้า1-1900.pdf"
)

CACHE_DIR = os.path.join(os.path.dirname(__file__), "cache")
CACHE_FILE = os.path.join(CACHE_DIR, "index.json")
BOOKMARK_FILE = os.path.join(CACHE_DIR, "bookmark.json")
CHAPTER_CACHE_DIR = os.path.join(CACHE_DIR, "chapters")
TTS_AUDIO_DIR  = os.path.join(CACHE_DIR, "audio")
TTS_USAGE_FILE = os.path.join(CACHE_DIR, "tts_usage.json")

# Only create cache dirs if PDF exists (for safety on Netlify)
if os.path.exists(PDF_PATH):
    os.makedirs(CHAPTER_CACHE_DIR, exist_ok=True)
    os.makedirs(TTS_AUDIO_DIR, exist_ok=True)


# Shared PDF reader
_pdf_reader = None
_pdf_lock = threading.Lock()

chapter_index = {}  # {chapter_num: page_index}
index_lock = threading.Lock()
index_complete = False

TOTAL_CHAPTERS = 1900
CH1_PAGE = 9
PAGES_PER_CHAPTER = 10.8
SCAN_RADIUS = 40

# Thai diacritic spacing fix pattern:
# Matches a space that sits between a Thai char + upper/lower diacritic and
# the next Thai consonant/vowel. These spaces are PDF extraction artifacts.
_THAI_DIAC = "\u0e31\u0e34\u0e35\u0e36\u0e37\u0e38\u0e39\u0e47\u0e48\u0e49\u0e4a\u0e4b\u0e4c\u0e4d"
_THAI_CHAR = "\u0e01-\u0e3a\u0e40-\u0e4f"
_FIX_SPACE_RE = re.compile(
    r"([" + _THAI_CHAR + r"][" + _THAI_DIAC + r"]+)\s+(?=[" + _THAI_CHAR + r"])"
)
# Also fix space before ? ! that follows Thai
_FIX_PUNCT_RE = re.compile(
    r"([" + _THAI_CHAR + _THAI_DIAC + r"])\s+([?!])"
)


def fix_thai_spacing(text):
    """Remove erroneous spaces between Thai chars with diacritics."""
    text = _FIX_SPACE_RE.sub(r"\1", text)
    text = _FIX_PUNCT_RE.sub(r"\1\2", text)
    return text


def get_reader():
    global _pdf_reader
    if _pdf_reader is None:
        from pypdf import PdfReader
        if not os.path.exists(PDF_PATH):
            return None  # PDF not available on Netlify
        _pdf_reader = PdfReader(PDF_PATH)
    return _pdf_reader


def load_cache():
    global chapter_index
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            chapter_index = {int(k): v for k, v in data.items()}
        print(f"Loaded {len(chapter_index)} chapters from cache")


def save_cache():
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(chapter_index, f, ensure_ascii=False)


def estimate_page(chapter_num):
    return int(CH1_PAGE + (chapter_num - 1) * PAGES_PER_CHAPTER)


def find_chapter_page(chapter_num, hint=None):
    reader = get_reader()
    total = len(reader.pages)
    est = hint if hint is not None else estimate_page(chapter_num)
    start = max(0, est - SCAN_RADIUS)
    end = min(total, est + SCAN_RADIUS)

    if chapter_num == 0:
        pattern = re.compile(r"^บทนํา")
    else:
        pattern = re.compile(r"^บทที่?\s*" + str(chapter_num) + r"(\s|$)")

    with _pdf_lock:
        for i in range(start, end):
            text = reader.pages[i].extract_text() or ""
            for line in text.split("\n"):
                if pattern.match(line.strip()):
                    return i
    return None


def join_lines_thai(raw_lines):
    """Join PDF lines preserving Thai text spacing rules.

    Key insight from the PDF:
    - Lines ending WITHOUT trailing space = word-wrapped continuation
      -> join directly (no space) to next line
    - Lines ending WITH trailing space = sentence/paragraph break
      -> mark as paragraph boundary
    """
    segments = []  # list of (text, ends_paragraph)

    for line in raw_lines:
        if not line:
            continue
        stripped = line.strip()
        if not stripped:
            continue
        # Single stray diacritic char
        if len(stripped) == 1 and stripped not in "ๆฯ":
            continue
        # Only dots/ellipsis
        if re.match(r"^[.…\s]+$", stripped):
            continue

        ends_with_space = line.endswith(" ")
        segments.append((stripped, ends_with_space))

    return segments


def build_paragraphs(segments):
    """Build paragraphs from line segments using trailing-space detection."""
    paragraphs = []
    buf = ""

    for text, ends_para in segments:
        # Skip chapter title lines
        if re.match(r"^(บทที่?\s*\d|บทนํา)", text):
            if buf:
                paragraphs.append(buf)
                buf = ""
            continue

        if buf:
            # Previous line did NOT end with space -> continuation (no space)
            buf += text
        else:
            buf = text

        if ends_para:
            # This line ended with space -> paragraph/sentence break
            paragraphs.append(buf)
            buf = ""

    if buf:
        paragraphs.append(buf)

    return [fix_thai_spacing(p.strip()) for p in paragraphs if len(p.strip()) > 3]


def extract_chapter(chapter_num):
    cache_file = os.path.join(CHAPTER_CACHE_DIR, f"ch{chapter_num:04d}.json")
    if os.path.exists(cache_file):
        with open(cache_file, "r", encoding="utf-8") as f:
            return json.load(f)

    try:
        with index_lock:
            start_page = chapter_index.get(chapter_num)

        if start_page is None:
            hint = 2 if chapter_num == 0 else estimate_page(chapter_num)
            start_page = find_chapter_page(chapter_num, hint)
            if start_page is None:
                return None
            with index_lock:
                chapter_index[chapter_num] = start_page
                save_cache()

        # Find end page
        with index_lock:
            end_page = chapter_index.get(chapter_num + 1)

        if end_page is None:
            end_page = find_chapter_page(chapter_num + 1,
                                         estimate_page(chapter_num + 1))
            if end_page is None:
                reader = get_reader()
                end_page = min(start_page + 20, len(reader.pages))
            else:
                with index_lock:
                    chapter_index[chapter_num + 1] = end_page
                    save_cache()

        # Extract raw text preserving original line breaks
        reader = get_reader()
        total = len(reader.pages)
        all_lines = []
        with _pdf_lock:
            for i in range(start_page, min(end_page, total)):
                text = reader.pages[i].extract_text()
                if text:
                    # Keep original lines with their trailing spaces
                    all_lines.extend(text.split("\n"))

        # Detect title (may appear anywhere on first page)
        title = f"บทที่ {chapter_num}"
        for raw_line in all_lines[:20]:
            line = raw_line.strip()
            m = re.match(r"^บทที่?\s*\d+\s*(.*)", line)
            if m:
                name = fix_thai_spacing(m.group(1).strip())
                title = f"บทที่ {chapter_num} {name}".strip() if name else f"บทที่ {chapter_num}"
                break
            if re.match(r"^บทนํา", line):
                title = "บทนำ"
                break

        # Build paragraph list using Thai spacing rules
        segments = join_lines_thai(all_lines)
        paragraphs = build_paragraphs(segments)

        result = {
            "chapter": chapter_num,
            "title": title,
            "paragraphs": paragraphs,
            "pages": f"{start_page + 1}\u2013{end_page}",
        }

        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        return result

    except Exception as e:
        print(f"Error extracting chapter {chapter_num}: {e}")
        import traceback; traceback.print_exc()
        return None


def build_index_background():
    """Full sequential scan of ALL pages to find every chapter."""
    global index_complete
    print("Background indexer: full sequential scan started...")
    reader = get_reader()
    total = len(reader.pages)
    ch_pat = re.compile(r"^บทที่?\s*(\d+)")
    pre_pat = re.compile(r"^บทนํา")

    batch_size = 200  # pages per lock acquisition
    i = 2
    while i < total:
        end = min(i + batch_size, total)
        with _pdf_lock:
            for j in range(i, end):
                text = reader.pages[j].extract_text() or ""
                for line in text.split("\n"):
                    line = line.strip()
                    if pre_pat.match(line):
                        with index_lock:
                            if 0 not in chapter_index:
                                chapter_index[0] = j
                        break
                    m = ch_pat.match(line)
                    if m:
                        ch = int(m.group(1))
                        with index_lock:
                            if ch not in chapter_index:
                                chapter_index[ch] = j
                        break
        i = end

        with index_lock:
            count = len(chapter_index)
        if count % 100 < 10 or i >= total:
            save_cache()
            pct = int(i / total * 100)
            print(f"  Indexed {count} chapters... ({pct}% pages scanned)")

    save_cache()
    index_complete = True
    with index_lock:
        count = len(chapter_index)
    print(f"Background indexer complete: {count} chapters found in {total} pages")


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/info")
def api_info():
    with index_lock:
        indexed = len(chapter_index)
    return jsonify({
        "total_chapters": TOTAL_CHAPTERS,
        "indexed_chapters": indexed,
        "index_complete": index_complete,
        "title": "Against the Gods อสูรพลิกฟ้า",
        "author": "\u706b\u661f\u5f15\u529b",
        "translator": "Aradeer",
    })


@app.route("/api/chapter/<int:chapter_num>")
def api_chapter(chapter_num):
    reader = get_reader()
    if reader is None:
        return jsonify({"error": "PDF file not available on this deployment"}), 503
    if chapter_num < 0 or chapter_num > TOTAL_CHAPTERS:
        return jsonify({"error": "Chapter out of range"}), 404
    data = extract_chapter(chapter_num)
    if data is None:
        return jsonify({"error": "Chapter not found"}), 404
    return jsonify(data)


@app.route("/api/index")
def api_index():
    with index_lock:
        idx = dict(chapter_index)
    return jsonify({
        "chapters": idx,
        "total": TOTAL_CHAPTERS,
        "complete": index_complete,
    })


@app.route("/api/bookmark", methods=["GET"])
def api_bookmark_get():
    if os.path.exists(BOOKMARK_FILE):
        with open(BOOKMARK_FILE, "r", encoding="utf-8") as f:
            return jsonify(json.load(f))
    return jsonify({"chapter": None})


@app.route("/api/bookmark", methods=["POST"])
def api_bookmark_post():
    from flask import request
    data = request.get_json(force=True)
    chapter = data.get("chapter")
    title = data.get("title", "")
    if chapter is None:
        return jsonify({"error": "missing chapter"}), 400
    bm = {"chapter": chapter, "title": title, "saved_at": __import__("datetime").datetime.now().isoformat()}
    with open(BOOKMARK_FILE, "w", encoding="utf-8") as f:
        json.dump(bm, f, ensure_ascii=False)
    return jsonify({"ok": True})


# ════════════════════════════════════════════════════════
# TTS  –  Microsoft Edge TTS (edge-tts, ฟรี ไม่ต้องใช้ API key)
# voices: th-TH-NiwatNeural (ชาย), th-TH-PremwadeeNeural (หญิง)
# ════════════════════════════════════════════════════════

def _tts_get_usage():
    """Return current month's TTS usage dict (for stats only – no limit)."""
    month = datetime.now().strftime("%Y-%m")
    if os.path.exists(TTS_USAGE_FILE):
        with open(TTS_USAGE_FILE, "r") as f:
            data = json.load(f)
        if data.get("month") == month:
            return data
    return {"month": month, "chars_used": 0}


def _tts_save_usage(data):
    with open(TTS_USAGE_FILE, "w") as f:
        json.dump(data, f)


@app.route("/api/tts/usage")
def api_tts_usage():
    usage = _tts_get_usage()
    used = usage["chars_used"]
    return jsonify({
        "chars_used": used,
        "month": usage["month"],
        "engine": "edge-tts",
        "free": True,
    })


@app.route("/api/tts/synthesize", methods=["POST"])
def api_tts_synthesize():
    """Synthesize via edge-tts (Microsoft Edge Neural TTS). Caches MP3 on disk."""
    try:
        import edge_tts
    except ImportError:
        return jsonify({"error": "edge_tts_not_installed", "hint": "pip install edge-tts"}), 503

    data = request.get_json(force=True)
    text     = data.get("text", "").strip()
    voice    = data.get("voice", "th-TH-PremwadeeNeural")
    # rate: "+0%" / "+25%" / "-20%"  (relative %)
    rate_pct = int(data.get("rate_pct", 0))          # e.g. -20 … +50
    # pitch: "+0Hz" / "+5Hz" / "-3Hz"
    pitch_hz = int(data.get("pitch_hz", 0))          # e.g. -10 … +10

    if not text:
        return jsonify({"error": "text is required"}), 400

    rate_str  = f"{rate_pct:+d}%"
    pitch_str = f"{pitch_hz:+d}Hz"

    # ── Cache lookup ──
    cache_key  = hashlib.sha256(
        f"{text}|{voice}|{rate_str}|{pitch_str}".encode()
    ).hexdigest()
    cache_path = os.path.join(TTS_AUDIO_DIR, f"{cache_key}.mp3")

    if os.path.exists(cache_path):
        with open(cache_path, "rb") as f:
            audio = f.read()
        return Response(audio, mimetype="audio/mpeg",
                        headers={"X-Cache": "HIT"})

    # ── Synthesize ──
    async def _synth():
        communicate = edge_tts.Communicate(text, voice,
                                           rate=rate_str, pitch=pitch_str)
        chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        return b"".join(chunks)

    try:
        audio = asyncio.run(_synth())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    if not audio:
        return jsonify({"error": "empty_audio"}), 500

    # ── Save to cache ──
    with open(cache_path, "wb") as f:
        f.write(audio)

    # ── Update char stats ──
    usage = _tts_get_usage()
    usage["chars_used"] += len(text)
    _tts_save_usage(usage)

    return Response(audio, mimetype="audio/mpeg",
                    headers={"X-Cache": "MISS",
                             "X-Chars-Used": str(usage["chars_used"])})


# ════════════════════════════════════════════════════════
# ElevenLabs TTS (Premium AI voices)
# ════════════════════════════════════════════════════════

@app.route("/api/tts/elevenlabs/synthesize", methods=["POST"])
def api_tts_elevenlabs():
    """Synthesize via ElevenLabs API. Premium AI voices with caching."""
    import requests
    
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        return jsonify({"error": "ELEVENLABS_API_KEY not set"}), 503
    
    data = request.get_json(force=True)
    text = data.get("text", "").strip()
    voice_id = data.get("voice_id", os.getenv("ELEVENLABS_VOICE_ID", "EXAVITQu4vLQfsLW1N7F"))
    
    if not text:
        return jsonify({"error": "text is required"}), 400
    
    # ── Cache lookup ──
    cache_key = hashlib.sha256(f"{text}|elevenlabs|{voice_id}".encode()).hexdigest()
    cache_path = os.path.join(TTS_AUDIO_DIR, f"el_{cache_key}.mp3")
    
    if os.path.exists(cache_path):
        with open(cache_path, "rb") as f:
            audio = f.read()
        return Response(audio, mimetype="audio/mpeg",
                        headers={"X-Cache": "HIT", "X-Engine": "elevenlabs"})
    
    # ── Call ElevenLabs API ──
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    headers = {
        "xi-api-key": api_key,
        "Content-Type": "application/json",
    }
    payload = {
        "text": text,
        "model_id": "eleven_monolingual_v1",  # Fast model
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75,
        }
    }
    
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        response.raise_for_status()
        audio = response.content
    except requests.exceptions.RequestException as e:
        error_msg = str(e)
        status_code = 503
        try:
            if hasattr(e.response, 'status_code'):
                if e.response.status_code == 401:
                    error_msg = "Invalid ElevenLabs API key"
                    status_code = 401
                elif e.response.status_code == 429:
                    error_msg = "ElevenLabs rate limit exceeded"
                    status_code = 429
        except:
            pass
        return jsonify({"error": error_msg}), status_code
    
    if not audio:
        return jsonify({"error": "empty_audio"}), 500
    
    # ── Save to cache ──
    with open(cache_path, "wb") as f:
        f.write(audio)
    
    # ── Update char stats ──
    usage = _tts_get_usage()
    usage["chars_used"] += len(text)
    _tts_save_usage(usage)
    
    return Response(audio, mimetype="audio/mpeg",
                    headers={"X-Cache": "MISS",
                             "X-Engine": "elevenlabs",
                             "X-Chars-Used": str(usage["chars_used"])})


if __name__ == "__main__":
    load_cache()

    # Clear old chapter caches (they have old spacing logic)
    import glob
    old_caches = glob.glob(os.path.join(CHAPTER_CACHE_DIR, "ch*.json"))
    if old_caches:
        for f in old_caches:
            os.remove(f)
        print(f"Cleared {len(old_caches)} old chapter caches (spacing fix)")

    # Start full background indexer
    t = threading.Thread(target=build_index_background, daemon=True)
    t.start()

    port = int(os.environ.get("PORT", 5001))
    print(f"Server starting at http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
