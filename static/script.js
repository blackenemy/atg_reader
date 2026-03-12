/* Against the Gods Reader - Frontend Script */

let currentChapter = null;
let totalChapters = 1900;
let fontSize = 18;
let knownChapters = {};
let tocRendered = false;
let ttsAvailable = null; // null=unchecked, true/false after first check
let useWebSpeechAPI = false; // fallback when server TTS unavailable
let synth = null; // Web Speech API synthesis
let ttsEngine = "edge-tts"; // "edge-tts", "elevenlabs", or "webspeech"

// ── Init ──
document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  fetchInfo();
  buildTocSkeleton();
  setupScrollProgress();

  // Keyboard nav
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    // TTS shortcuts (only when bar is visible)
    if (tts.active) {
      if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        tts.playing ? ttsPause() : ttsPlay();
        return;
      }
      if (e.key === "Escape") { ttsStop(); return; }
      if (e.shiftKey && e.key === "ArrowLeft") { e.preventDefault(); ttsSkipPrev(); return; }
      if (e.shiftKey && e.key === "ArrowRight") { e.preventDefault(); ttsSkipNext(); return; }
    }
    // Chapter nav (only when TTS not active or shift not pressed)
    if (!e.shiftKey) {
      if (e.key === "ArrowLeft" || e.key === ",") prevChapter();
      if (e.key === "ArrowRight" || e.key === ".") nextChapter();
    }
    if (e.key === "Escape") closeSidebar();
  });

  // Jump on Enter
  document.getElementById("jumpInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") jumpToChapter();
  });

  // Check TTS availability (static hosting vs Flask server)
  _checkTtsAvailable();

  // Restore last chapter from server bookmark (persistent across sessions)
  restoreBookmark();
});

function loadSettings() {
  const saved = localStorage.getItem("atg_settings");
  if (saved) {
    const s = JSON.parse(saved);
    fontSize = s.fontSize || 18;
    if (s.theme === "light") document.body.className = "light";
    else document.body.className = "dark";
    applyFontSize();
  }
}

function saveSettings() {
  localStorage.setItem("atg_settings", JSON.stringify({
    fontSize,
    theme: document.body.className,
  }));
}

// ── Fetch Info ──
async function fetchInfo() {
  try {
    const res = await fetch("/api/info");
    const data = await res.json();
    totalChapters = data.total_chapters;
    document.getElementById("jumpInput").max = totalChapters;
  } catch (e) { }

  // Poll index status
  pollIndexStatus();
}

async function pollIndexStatus() {
  try {
    const res = await fetch("/api/index");
    const data = await res.json();
    knownChapters = data.chapters || {};
    const count = Object.keys(knownChapters).length;
    const pct = Math.round(count / totalChapters * 100);
    const el = document.getElementById("indexStatus");
    if (count < totalChapters) {
      el.textContent = `สารบัญ: ${count}/${totalChapters} บท (${pct}%)`;
      el.style.color = "var(--accent2)";
      setTimeout(pollIndexStatus, 5000);
    } else {
      el.textContent = `สารบัญ: ${totalChapters} บท (ครบ)`;
      el.style.color = "var(--text-muted)";
    }
    // Update TOC if we have more data
    if (count > Object.keys(knownChapters).length || !tocRendered) {
      buildTocSkeleton();
    }
  } catch (e) { }
}

// ── Table of Contents ──
function buildTocSkeleton() {
  const list = document.getElementById("tocList");

  // Show groups of chapters
  list.innerHTML = "";

  // Intro
  const intro = makeTocItem(0, "บทนำ");
  list.appendChild(intro);

  // Group by 50
  for (let start = 1; start <= totalChapters; start += 50) {
    const end = Math.min(start + 49, totalChapters);
    const group = document.createElement("div");

    const header = document.createElement("div");
    header.className = "toc-group-header";
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.textContent = "▶";
    header.appendChild(chevron);
    header.appendChild(document.createTextNode(`บทที่ ${start}–${end}`));
    group.appendChild(header);

    const groupItems = document.createElement("div");
    groupItems.id = `toc-group-${start}`;
    groupItems.style.display = "none"; // collapsed by default
    // Pre-populate all items immediately (no lazy loading)
    for (let i = start; i <= end; i++) {
      groupItems.appendChild(makeTocItem(i));
    }
    group.appendChild(groupItems);

    // Expand button
    header.style.cursor = "pointer";
    header.addEventListener("click", () => {
      const isOpen = groupItems.style.display !== "none";
      groupItems.style.display = isOpen ? "none" : "block";
      header.classList.toggle("open", !isOpen);
    });

    list.appendChild(group);
  }

  tocRendered = true;
}

function makeTocItem(num, title) {
  const btn = document.createElement("button");
  btn.className = "toc-item" + (currentChapter === num ? " active" : "");
  btn.id = `toc-item-${num}`;
  btn.textContent = title || (num === 0 ? "บทนำ" : `บทที่ ${num}`);
  btn.onclick = () => loadChapter(num);
  return btn;
}

function expandTocGroup(chapterNum) {
  if (chapterNum <= 0) return;
  const groupStart = Math.floor((chapterNum - 1) / 50) * 50 + 1;
  const groupEl = document.getElementById(`toc-group-${groupStart}`);
  if (groupEl && groupEl.style.display === "none") {
    groupEl.style.display = "block";
    // Mark header as open
    const header = groupEl.previousElementSibling;
    if (header) header.classList.add("open");
  }
}

// ── Load Chapter ──
async function loadChapter(num) {
  showLoading(true);
  currentChapter = num;

  try {
    const res = await fetch(`/api/chapter/${num}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderChapter(data);
    // Save bookmark to server file (persistent across restarts)
    saveBookmark(num, data.title || "");
  } catch (e) {
    showError(`ไม่สามารถโหลดบทที่ ${num} ได้<br><small>${e.message}</small>`);
  } finally {
    showLoading(false);
  }

  // Update active TOC item
  document.querySelectorAll(".toc-item").forEach(el => el.classList.remove("active"));
  expandTocGroup(num);
  if (num < totalChapters) expandTocGroup(num + 1); // pre-expand next group at boundaries

  // Ensure TOC group is populated
  if (num > 0) {
    const groupStart = Math.floor((num - 1) / 50) * 50 + 1;
    const groupEl = document.getElementById(`toc-group-${groupStart}`);
    if (groupEl) {
      // Now set active
      const activeItem = document.getElementById(`toc-item-${num}`);
      if (activeItem) {
        activeItem.classList.add("active");
        activeItem.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  } else {
    const introItem = document.getElementById("toc-item-0");
    if (introItem) introItem.classList.add("active");
  }
}

function renderChapter(data) {
  const content = document.getElementById("content");

  // Title display
  let titleDisplay = "";
  if (data.chapter === 0) {
    titleDisplay = `<div class="chapter-num">บทนำ</div><p class="chapter-title">${escHtml(data.title || "บทนำ")}</p>`;
  } else {
    const titleParts = (data.title || "").replace(/^บทที่?\s*\d+\s*/, "").trim();
    titleDisplay = `
      <div class="chapter-num">บทที่ ${data.chapter}</div>
      <p class="chapter-title">${escHtml(titleParts || `บทที่ ${data.chapter}`)}</p>
    `;
  }

  const paragraphs = (data.paragraphs || [])
    .map(p => {
      p = escHtml(p);
      const isDialogue = p.startsWith("&quot;") || p.startsWith("\u201C") || p.startsWith("\u2018");
      return `<p${isDialogue ? ' class="dialogue"' : ""}>${p}</p>`;
    })
    .join("\n");

  content.innerHTML = `
    <div class="chapter-header">
      ${titleDisplay}
      ${data.pages ? `<div class="chapter-pages">หน้า PDF: ${data.pages}</div>` : ""}
    </div>
    <div class="chapter-body">
      ${paragraphs || '<p style="color:var(--text-muted)">ไม่พบเนื้อหา</p>'}
    </div>
  `;

  // Update topbar title
  document.getElementById("currentChapterTitle").textContent = data.title || `บทที่ ${data.chapter}`;

  // Show/update nav
  const nav = document.getElementById("chapterNav");
  nav.style.display = "flex";
  document.getElementById("prevBtn").disabled = data.chapter <= 0;
  document.getElementById("nextBtn").disabled = data.chapter >= totalChapters;
  document.getElementById("navInfo").textContent =
    data.chapter === 0 ? "บทนำ" : `บทที่ ${data.chapter} / ${totalChapters}`;

  // Scroll to top
  window.scrollTo({ top: 0, behavior: "instant" });
  content.scrollTop = 0;

  // Reset TTS paragraph list for new chapter
  tts.paragraphs = [];

  // Click-to-jump: clicking any paragraph starts TTS from there
  const body = content.querySelector(".chapter-body");
  if (body) {
    body.addEventListener("click", (e) => {
      if (!tts.active) return;
      const p = e.target.closest("p");
      if (!p) return;
      const all = Array.from(body.querySelectorAll("p"));
      const idx = all.indexOf(p);
      if (idx === -1) return;
      // Stop current audio and jump
      if (tts.audio) { tts.audio.pause(); tts.audio = null; }
      tts.index = idx;
      tts.playing = true;
      tts.paused = false;
      _ttsSetPlayUI(true);
      // Ensure paragraphs are collected
      if (!tts.paragraphs.length) {
        tts.paragraphs = all.map(el => ({
          el, text: el.textContent.trim(),
          preset: ttsGetParaPreset(el.textContent.trim()),
        }));
      }
      _ttsPlayCurrent();
      _ttsPrefetch(idx, 5);
    }, { once: false });
  }

  // Auto-prefetch if TTS was playing (chapter auto-advanced)
  if (tts.playing) {
    tts.index = 0;
    _ttsPlayCurrent();
  }
}

// ── Bookmark (server-side + localStorage fallback) ──
function saveBookmark(chapter, title) {
  // Always save to localStorage (works everywhere)
  localStorage.setItem("atg_bookmark", JSON.stringify({ chapter, title }));
  // Also try server (Flask only — silent fail on Netlify)
  fetch("/api/bookmark", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chapter, title }),
  }).catch(() => { });
}

async function restoreBookmark() {
  // Try server first (Flask), fall back to localStorage
  try {
    const res = await fetch("/api/bookmark");
    if (!res.ok) throw new Error("api unavailable");
    const bm = await res.json();
    if (bm.chapter !== null && bm.chapter !== undefined) {
      showBookmarkToast(bm.chapter, bm.title);
      setTimeout(() => loadChapter(bm.chapter), 400);
      return;
    }
  } catch (e) {
    // Server unavailable — try localStorage
    const local = localStorage.getItem("atg_bookmark");
    if (local) {
      try {
        const bm = JSON.parse(local);
        if (bm.chapter !== null && bm.chapter !== undefined) {
          showBookmarkToast(bm.chapter, bm.title);
          setTimeout(() => loadChapter(bm.chapter), 400);
        }
      } catch (_) { }
    }
  }
}

function showBookmarkToast(chapter, title) {
  const toast = document.createElement("div");
  toast.style.cssText = `
    position:fixed; bottom:24px; right:24px; z-index:500;
    background:var(--surface2); color:var(--text);
    padding:12px 18px; border-radius:10px;
    border:1px solid var(--border);
    font-size:0.85rem; line-height:1.5;
    box-shadow:0 4px 16px rgba(0,0,0,0.3);
    animation: fadeIn 0.3s ease;
  `;
  const label = chapter === 0 ? "บทนำ" : `บทที่ ${chapter}`;
  toast.innerHTML = `<strong>ต่อจากที่อ่านค้างไว้</strong><br>${label}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ── Navigation ──
function prevChapter() {
  if (currentChapter === null) return;
  if (currentChapter > 0) loadChapter(currentChapter - 1);
}

function nextChapter() {
  if (currentChapter === null) return;
  if (currentChapter < totalChapters) loadChapter(currentChapter + 1);
}

function jumpToChapter() {
  const val = parseInt(document.getElementById("jumpInput").value);
  if (!isNaN(val) && val >= 0 && val <= totalChapters) {
    loadChapter(val);
    document.getElementById("jumpInput").value = "";
  }
}

// ── UI Controls ──
function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebarBackdrop");

  // Toggle the 'closed' class
  sidebar.classList.toggle("closed");

  // On mobile, also toggle an 'open' class for cleaner animation logic if needed,
  // but for now we'll stick to 'closed' logic and handle the backdrop
  const isNowOpen = !sidebar.classList.contains("closed");

  if (backdrop) {
    backdrop.classList.toggle("active", isNowOpen);
  }

  // Prevent scroll on mobile when sidebar is open
  if (window.innerWidth <= 768) {
    document.body.style.overflow = isNowOpen ? "hidden" : "";
  }
}

function closeSidebar() {
  document.getElementById("sidebar").classList.add("closed");
  const backdrop = document.getElementById("sidebarBackdrop");
  if (backdrop) backdrop.classList.remove("active");
  document.body.style.overflow = "";
}

function toggleTheme() {
  const body = document.body;
  body.className = body.className === "dark" ? "light" : "dark";
  document.getElementById("themeBtn").textContent = body.className === "dark" ? "☀️" : "🌙";
  saveSettings();
}

function changeFontSize(delta) {
  fontSize = Math.max(14, Math.min(28, fontSize + delta));
  applyFontSize();
  saveSettings();
}

function applyFontSize() {
  document.documentElement.style.setProperty("--font-size", fontSize + "px");
}

// ── Loading / Error ──
function showLoading(show) {
  document.getElementById("loading").style.display = show ? "flex" : "none";
}

function showError(msg) {
  document.getElementById("content").innerHTML = `
    <div class="error-msg">
      <h3>❌ เกิดข้อผิดพลาด</h3>
      <p>${msg}</p>
      <br>
      <button class="btn-primary" onclick="loadChapter(${currentChapter})">ลองอีกครั้ง</button>
    </div>
  `;
  document.getElementById("chapterNav").style.display = "none";
}

// ── Reading Progress Bar ──
function setupScrollProgress() {
  const bar = document.createElement("div");
  bar.className = "reading-progress";
  document.body.appendChild(bar);

  window.addEventListener("scroll", () => {
    const total = document.documentElement.scrollHeight - window.innerHeight;
    const pct = total > 0 ? (window.scrollY / total) * 100 : 0;
    bar.style.width = pct + "%";
  });
}

// ════════════════════════════════════════════════════════
// TTS  –  Text-to-Speech Engine
// ════════════════════════════════════════════════════════

// edge-tts: Microsoft Edge Neural TTS (ฟรี ไม่ต้องใช้ API key)
const TTS_VOICES = [
  { value: "th-TH-PremwadeeNeural", label: "Premwadee — หญิง ★" },
  { value: "th-TH-NiwatNeural", label: "Niwat — ชาย ★" },
];

const TTS_PRESETS_DEFAULT = {
  narrator: {
    voice: "th-TH-PremwadeeNeural",
    rate_pct: 0,    // ความเร็ว: -50 ถึง +100 (%)
    pitch_hz: 0,    // ระดับเสียง: -10 ถึง +10 (Hz)
  },
  dialogue_male: {
    voice: "th-TH-NiwatNeural",
    rate_pct: 0,
    pitch_hz: -3,
  },
  dialogue_female: {
    voice: "th-TH-PremwadeeNeural",
    rate_pct: 5,
    pitch_hz: 4,
  },
};

// ── TTS State ──
const tts = {
  active: false,
  playing: false,
  paused: false,
  paragraphs: [],
  index: 0,
  audio: null,
  blobCache: {},
  prefetchQueue: {},
  speedMultiplier: 1.0,
  volume: 1.0,
  defaultGender: "male",
  abortCtrl: null,
  autoNextChapter: true,      // อ่านต่อบทถัดไปอัตโนมัติ
  consecutiveFailures: 0,     // ป้องกัน loop ไม่สิ้นสุดเมื่อ server ไม่ตอบ
};

function ttsGetPresets() {
  const saved = localStorage.getItem("atg_tts_presets");
  return saved ? { ...TTS_PRESETS_DEFAULT, ...JSON.parse(saved) } : { ...TTS_PRESETS_DEFAULT };
}

function ttsSavePresets(presets) {
  localStorage.setItem("atg_tts_presets", JSON.stringify(presets));
}

// ── Detect paragraph voice type ──
function ttsGetParaPreset(text) {
  const isDialogue = /^["""'']/.test(text.trimStart());
  if (!isDialogue) return "narrator";
  return tts.defaultGender === "female" ? "dialogue_female" : "dialogue_male";
}

// ── TTS availability check (skips on Netlify/static hosting) ──
async function _checkTtsAvailable() {
  if (ttsAvailable !== null) return ttsAvailable;
  
  // Try edge-tts first
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch("/api/tts/usage", { signal: ctrl.signal });
    clearTimeout(timeout);
    if (res.ok) {
      ttsAvailable = true;
      ttsEngine = "edge-tts";
      return true;
    }
  } catch (_) { }
  
  // Try ElevenLabs API
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch("/api/tts/elevenlabs/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "test" }),
      signal: ctrl.signal
    });
    clearTimeout(timeout);
    if (res.ok) {
      ttsAvailable = true;
      ttsEngine = "elevenlabs";
      const btn = document.getElementById("ttsMasterBtn");
      if (btn) {
        btn.title = "อ่านออกเสียง (ElevenLabs AI)";
      }
      return true;
    }
  } catch (_) { }
  
  // Fall back to Web Speech API
  if ("speechSynthesis" in window) {
    useWebSpeechAPI = true;
    synth = window.speechSynthesis;
    ttsEngine = "webspeech";
    ttsAvailable = true;
    const btn = document.getElementById("ttsMasterBtn");
    if (btn) {
      btn.title = "อ่านออกเสียง (Web Speech API)";
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    }
    return true;
  }
  
  // No TTS available
  ttsAvailable = false;
  const btn = document.getElementById("ttsMasterBtn");
  if (btn) {
    btn.title = "TTS ไม่รองรับ (ต้องใช้ server หรือ browser ที่รองรับ Web Speech)";
    btn.style.opacity = "0.45";
    btn.style.cursor = "not-allowed";
  }
  return false;
}

// ── Toggle player bar ──
async function ttsTogglePlayer() {
  const ok = await _checkTtsAvailable();
  if (!ok) {
    _showToast("🔇 ระบบอ่านออกเสียงต้องการ server Python\nไม่รองรับบน Netlify static hosting", 4000);
    return;
  }
  tts.active = !tts.active;
  document.getElementById("ttsBar").style.display = tts.active ? "block" : "none";
  document.getElementById("ttsMasterBtn").classList.toggle("active", tts.active);
  document.body.classList.toggle("tts-active-mode", tts.active);
  if (tts.active) {
    ttsRefreshUsage();
  } else {
    ttsStop();
  }
}

function _showToast(msg, ms = 3000) {
  const t = document.createElement("div");
  t.style.cssText = `
    position:fixed;bottom:24px;right:24px;z-index:600;
    background:var(--surface2);color:var(--text);
    padding:12px 18px;border-radius:10px;
    border:1px solid var(--border);
    font-size:0.85rem;line-height:1.6;white-space:pre-line;
    box-shadow:0 4px 16px rgba(0,0,0,0.3);
  `;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ── Play / Pause / Stop ──
function ttsPlay() {
  if (tts.paused && tts.audio) {
    tts.audio.play();
    tts.paused = false;
    tts.playing = true;
    _ttsSetPlayUI(true);
    return;
  }
  // Collect paragraphs from DOM
  const paras = Array.from(document.querySelectorAll(".chapter-body p"));
  if (!paras.length) return;
  tts.paragraphs = paras.map(el => ({
    el,
    text: el.textContent.trim(),
    preset: ttsGetParaPreset(el.textContent.trim()),
  }));
  tts.index = 0;
  tts.playing = true;
  tts.paused = false;
  _ttsSetPlayUI(true);
  _ttsPlayCurrent();
  // Prefetch next 5 paragraphs immediately
  _ttsPrefetch(0, 5);
}

function ttsPause() {
  if (useWebSpeechAPI && synth) {
    synth.pause();
    tts.paused = true;
    tts.playing = false;
    _ttsSetPlayUI(false);
  } else if (tts.audio && !tts.audio.paused) {
    tts.audio.pause();
    tts.paused = true;
    tts.playing = false;
    _ttsSetPlayUI(false);
  }
}

function ttsStop() {
  tts.playing = false;
  tts.paused = false;
  if (useWebSpeechAPI && synth) {
    synth.cancel();
  }
  if (tts.audio) {
    tts.audio.pause();
    tts.audio.src = "";
    tts.audio = null;
  }
  if (tts.abortCtrl) { tts.abortCtrl.abort(); tts.abortCtrl = null; }
  document.querySelectorAll(".chapter-body p").forEach(p => p.classList.remove("tts-active", "tts-done"));
  _ttsSetPlayUI(false);
  _ttsUpdateProgress();
}

function ttsChangeSpeed(val) {
  tts.speedMultiplier = parseFloat(val);
  if (useWebSpeechAPI && synth && synth.speaking) {
    synth.cancel(); // Need to restart with new rate
  }
  if (tts.audio) tts.audio.playbackRate = tts.speedMultiplier;
}

function ttsSetVolume(val) {
  tts.volume = parseFloat(val);
  if (useWebSpeechAPI && synth && synth.speaking) {
    synth.cancel(); // Need to restart with new volume
  }
  if (tts.audio) tts.audio.volume = tts.volume;
}

function ttsSkipPrev() {
  if (!tts.paragraphs.length) return;
  if (useWebSpeechAPI && synth) {
    synth.cancel();
  }
  if (tts.audio) { tts.audio.pause(); tts.audio = null; }
  tts.index = Math.max(0, tts.index - 1);
  if (tts.playing || tts.paused) {
    tts.playing = true; tts.paused = false;
    _ttsSetPlayUI(true);
    _ttsPlayCurrent();
    _ttsPrefetch(tts.index, 5);
  }
}

function ttsSkipNext() {
  if (!tts.paragraphs.length) return;
  if (useWebSpeechAPI && synth) {
    synth.cancel();
  }
  if (tts.audio) { tts.audio.pause(); tts.audio = null; }
  tts.index = Math.min(tts.paragraphs.length - 1, tts.index + 1);
  if (tts.playing || tts.paused) {
    tts.playing = true; tts.paused = false;
    _ttsSetPlayUI(true);
    _ttsPlayCurrent();
    _ttsPrefetch(tts.index, 5);
  }
}

function ttsSeek(e) {
  if (!tts.paragraphs.length) return;
  const wrap = document.getElementById("ttsProgressWrap");
  const pct = e.offsetX / wrap.offsetWidth;
  const idx = Math.round(pct * (tts.paragraphs.length - 1));
  tts.index = Math.max(0, Math.min(idx, tts.paragraphs.length - 1));
  if (tts.playing || tts.paused) {
    tts.paused = false;
    tts.playing = true;
    if (tts.audio) { tts.audio.pause(); tts.audio = null; }
    _ttsSetPlayUI(true);
    _ttsPlayCurrent();
    _ttsPrefetch(tts.index, 3);
  }
}

// ── Internal playback ──
async function _ttsPlayCurrent() {
  if (!tts.playing) return;

  // ── End of chapter ──
  if (tts.index >= tts.paragraphs.length) {
    if (tts.autoNextChapter && currentChapter !== null && currentChapter < totalChapters) {
      // Load next chapter; renderChapter will restart playback automatically
      await loadChapter(currentChapter + 1);
    } else {
      ttsStop();
    }
    return;
  }

  const para = tts.paragraphs[tts.index];
  const presets = ttsGetPresets();
  const cfg = presets[para.preset] || presets.narrator;

  // ── Highlight + loading state ──
  document.querySelectorAll(".chapter-body p").forEach((p, i) => {
    p.classList.remove("tts-active", "tts-done", "tts-loading");
    if (i === tts.index) p.classList.add("tts-loading");
    else if (i < tts.index) p.classList.add("tts-done");
  });
  para.el.scrollIntoView({ block: "center", behavior: "smooth" });
  _ttsUpdateProgress();

  try {
    const audioUrlOrData = await _ttsFetchAudio(para.text, cfg);
    if (!tts.playing) return;

    // Swap loading → active
    para.el.classList.remove("tts-loading");
    para.el.classList.add("tts-active");

    // Check if using Web Speech API
    if (useWebSpeechAPI && typeof audioUrlOrData === "object" && audioUrlOrData.utterance) {
      // Web Speech API playback
      const utterance = audioUrlOrData.utterance;
      await new Promise((resolve, reject) => {
        utterance.onended = resolve;
        utterance.onerror = (e) => reject(new Error(e.error));
        synth.cancel(); // Cancel any ongoing speech
        synth.speak(utterance);
      });
    } else {
      // Server TTS playback (HTML5 Audio element)
      tts.audio = new Audio(audioUrlOrData);
      tts.audio.playbackRate = tts.speedMultiplier;
      tts.audio.volume = tts.volume;
      await new Promise((resolve, reject) => {
        tts.audio.onended = resolve;
        tts.audio.onerror = reject;
        tts.audio.play().catch(reject);
      });
    }
    
    if (!tts.playing) return;
    tts.consecutiveFailures = 0; // reset on success
    tts.index++;
    _ttsPrefetch(tts.index, 5);
    _ttsPlayCurrent();
  } catch (err) {
    if (!tts.playing) return;
    if (err?.name === "AbortError") return;
    console.warn("TTS skip:", err);
    para.el.classList.remove("tts-loading");
    tts.consecutiveFailures++;
    // หยุดถ้า fail ติดต่อกัน 3 ครั้ง (เช่น server ไม่ตอบ)
    if (tts.consecutiveFailures >= 3) {
      console.warn("TTS: หยุดเนื่องจากเกิดข้อผิดพลาดต่อเนื่อง");
      ttsStop();
      _showToast("⚠️ TTS หยุดทำงาน เนื่องจากเกิดข้อผิดพลาดต่อเนื่อง");
      return;
    }
    tts.index++;
    _ttsPlayCurrent();
  }
}

// ── Fetch audio (with disk cache via backend) ──
async function _ttsFetchAudio(text, cfg) {
  const key = JSON.stringify({ text, ...cfg });
  if (tts.blobCache[key]) return tts.blobCache[key];
  if (tts.prefetchQueue[key]) return tts.prefetchQueue[key];

  let promise;

  // Use Web Speech API if configured
  if (ttsEngine === "webspeech" || useWebSpeechAPI) {
    promise = new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      
      // Set language to Thai
      utterance.lang = "th-TH";
      
      // Set voice based on config
      const voices = synth.getVoices();
      if (cfg.voice && cfg.voice.includes("male")) {
        const maleVoice = voices.find(v => v.lang.includes("th") || v.lang === "th-TH");
        if (maleVoice) utterance.voice = maleVoice;
      } else {
        const femaleVoice = voices.find(v => v.lang.includes("th") || v.lang === "th-TH");
        if (femaleVoice) utterance.voice = femaleVoice;
      }
      
      // Set rate and pitch
      utterance.rate = 1.0 + ((cfg.rate_pct ?? 0) / 100);
      utterance.pitch = 1.0 + ((cfg.pitch_hz ?? 0) / 10);
      utterance.volume = tts.volume;
      
      // Store as dummy URL to bypass audio element code
      const dummyUrl = `web-speech://${key}`;
      tts.blobCache[key] = { utterance, dummyUrl };
      delete tts.prefetchQueue[key];
      
      utterance.onend = () => resolve(dummyUrl);
      utterance.onerror = (e) => reject(new Error(e.error));
      
      resolve(dummyUrl);
    });
  }
  // Use ElevenLabs API
  else if (ttsEngine === "elevenlabs") {
    tts.abortCtrl = new AbortController();
    promise = fetch("/api/tts/elevenlabs/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice_id: cfg.voice_id || "default",
      }),
      signal: tts.abortCtrl.signal,
    }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "ElevenLabs TTS failed");
      }
      const used = res.headers.get("X-Chars-Used");
      if (used) _ttsUpdateUsageLabel(parseInt(used));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      tts.blobCache[key] = url;
      delete tts.prefetchQueue[key];
      return url;
    });
  }
  // Use edge-tts (default)
  else {
    tts.abortCtrl = new AbortController();
    promise = fetch("/api/tts/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice: cfg.voice,
        rate_pct: cfg.rate_pct ?? 0,
        pitch_hz: cfg.pitch_hz ?? 0,
      }),
      signal: tts.abortCtrl.signal,
    }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.error === "edge_tts_not_installed") {
          ttsStop();
          alert("กรุณาติดตั้ง edge-tts:\npip install edge-tts");
        }
        throw new Error(err.error || "TTS failed");
      }
      const used = res.headers.get("X-Chars-Used");
      if (used) _ttsUpdateUsageLabel(parseInt(used));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      tts.blobCache[key] = url;
      delete tts.prefetchQueue[key];
      return url;
    });
  }

  tts.prefetchQueue[key] = promise;
  return promise;
}

// ── Prefetch next N paragraphs ──
function _ttsPrefetch(fromIdx, count) {
  const presets = ttsGetPresets();
  for (let i = fromIdx; i < Math.min(fromIdx + count, tts.paragraphs.length); i++) {
    const para = tts.paragraphs[i];
    const cfg = presets[para.preset] || presets.narrator;
    const key = JSON.stringify({ text: para.text, ...cfg });
    if (!tts.blobCache[key] && !tts.prefetchQueue[key]) {
      _ttsFetchAudio(para.text, cfg).catch(() => { });
    }
  }
}

// ── UI helpers ──
function _ttsSetPlayUI(playing) {
  document.getElementById("ttsPlayBtn").style.display = playing ? "none" : "inline-flex";
  document.getElementById("ttsPauseBtn").style.display = playing ? "inline-flex" : "none";
}

function _ttsUpdateProgress() {
  const total = tts.paragraphs.length;
  const idx = tts.index;
  const fill = document.getElementById("ttsProgressFill");
  const label = document.getElementById("ttsParaLabel");
  if (!fill) return;
  fill.style.width = total ? ((idx / total) * 100) + "%" : "0%";
  label.textContent = total ? `${idx} / ${total}` : "—";
}

function _ttsUpdateUsageLabel(used) {
  const fill = document.getElementById("ttsUsageFill");
  const label = document.getElementById("ttsUsageLabel");
  if (fill) fill.style.width = "100%";   // edge-tts ไม่มี limit
  if (label) label.textContent = `ใช้ไป ${used.toLocaleString()} ตัวอักษร (ฟรี ไม่จำกัด)`;
}

async function ttsRefreshUsage() {
  try {
    const res = await fetch("/api/tts/usage");
    const data = await res.json();
    const detailEl = document.getElementById("ttsUsageDetail");
    if (detailEl) {
      detailEl.textContent =
        `✅ edge-tts (Microsoft Neural) — ฟรี ไม่จำกัด\nใช้ไปแล้ว ${data.chars_used.toLocaleString()} ตัวอักษรเดือน ${data.month}`;
    }
    _ttsUpdateUsageLabel(data.chars_used);
  } catch (e) { }
}

// ── Settings modal ──
let _ttsCurrentTab = "narrator";

function ttsOpenSettings() {
  document.getElementById("ttsSettingsOverlay").style.display = "flex";
  ttsRefreshUsage();
  _ttsRenderPresetPanel(_ttsCurrentTab);
  // Load saved gender default
  const gender = localStorage.getItem("atg_tts_gender") || "male";
  tts.defaultGender = gender;
  document.getElementById("ttsDefaultGender").value = gender;
  // Sync auto-next checkbox
  const chk = document.getElementById("ttsAutoNextChk");
  if (chk) chk.checked = tts.autoNextChapter;
}

function ttsCloseSettings() {
  document.getElementById("ttsSettingsOverlay").style.display = "none";
}

function ttsCloseSettingsOutside(e) {
  if (e.target === document.getElementById("ttsSettingsOverlay")) ttsCloseSettings();
}

function ttsSelectTab(preset, btn) {
  _ttsCurrentTab = preset;
  document.querySelectorAll(".tts-tab").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  _ttsRenderPresetPanel(preset);
}

function ttsSetDefaultGender(val) {
  tts.defaultGender = val;
  localStorage.setItem("atg_tts_gender", val);
}

function _ttsRenderPresetPanel(presetKey) {
  const panel = document.getElementById("ttsPresetPanel");
  const presets = ttsGetPresets();
  const cfg = presets[presetKey];

  const voiceOptions = TTS_VOICES.map(v =>
    `<option value="${v.value}" ${cfg.voice === v.value ? "selected" : ""}>${v.label}</option>`
  ).join("");

  panel.innerHTML = `
    <div class="tts-preset-fields">
      <div class="tts-field">
        <label>เสียง</label>
        <select id="ttsFieldVoice" class="tts-select" onchange="_ttsSaveField('${presetKey}','voice',this.value)">
          ${voiceOptions}
        </select>
      </div>
      <div class="tts-field">
        <label>ความเร็ว <span id="ttsRateVal">${cfg.rate_pct >= 0 ? "+" : ""}${cfg.rate_pct}%</span></label>
        <input type="range" id="ttsFieldRate" min="-50" max="100" step="5" value="${cfg.rate_pct}"
          class="tts-range"
          oninput="document.getElementById('ttsRateVal').textContent=(this.value>=0?'+':'')+this.value+'%'; _ttsSaveField('${presetKey}','rate_pct',parseInt(this.value))">
      </div>
      <div class="tts-field">
        <label>ระดับเสียง <span id="ttsPitchVal">${cfg.pitch_hz >= 0 ? "+" : ""}${cfg.pitch_hz} Hz</span></label>
        <input type="range" id="ttsFieldPitch" min="-10" max="10" step="1" value="${cfg.pitch_hz}"
          class="tts-range"
          oninput="document.getElementById('ttsPitchVal').textContent=(this.value>=0?'+':'')+this.value+' Hz'; _ttsSaveField('${presetKey}','pitch_hz',parseInt(this.value))">
      </div>
      <div class="tts-field">
        <button class="tts-preview-btn" onclick="_ttsPreview('${presetKey}')">▶ ทดสอบเสียง</button>
      </div>
    </div>
  `;
}

function _ttsSaveField(presetKey, field, value) {
  const presets = ttsGetPresets();
  presets[presetKey][field] = value;
  ttsSavePresets(presets);
}

function _ttsPreview(presetKey) {
  const presets = ttsGetPresets();
  const cfg = presets[presetKey];
  const samples = {
    narrator: "หยุนเช่อมองสวรรค์อย่างเยือกเย็น ดวงตาลึกซึ้งราวกับมหาสมุทร",
    dialogue_male: "ข้าคือสวรรค์ ไม่มีใครอาจสั่งข้าได้!",
    dialogue_female: "หยุนเช่อ เจ้ากลับมาแล้วหรือ ข้ารอเจ้าอยู่",
  };
  _ttsFetchAudio(samples[presetKey] || samples.narrator, cfg)
    .then(url => { const a = new Audio(url); a.play(); })
    .catch(e => alert("ทดสอบเสียงไม่สำเร็จ: " + e.message));
}



// ── Utils ──
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
