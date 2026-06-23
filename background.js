// background.js — Service Worker (Manifest V3)
// Xử lý toàn bộ API calls, lưu trữ key, tab lifecycle

// ─────────────────────────────────────────────────────────────────────────────
// MISC HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "saveToCSV" && message.url) {
    const filename = message.filename || "simplify_jobs.csv";
    chrome.downloads.download({ url: message.url, filename, saveAs: true }, (downloadId) => {
      if (chrome.runtime.lastError) console.error("Lỗi tải file:", chrome.runtime.lastError);
      else console.log("Đã tải file ID:", downloadId);
    });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getSheetId") {
    (async () => {
      try {
        const res = await fetch(request.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        try { sendResponse({ success: true, data: JSON.parse(text) }); }
        catch { sendResponse({ success: false, error: "Invalid JSON", raw: text }); }
      } catch (err) { sendResponse({ success: false, error: err.message }); }
    })();
    return true;
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "saveToSheets") {
    (async () => {
      try {
        await fetch(request.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          mode: "no-cors",
          body: JSON.stringify(request.payload)
        });
        sendResponse({ success: true });
      } catch (err) { sendResponse({ success: false, error: err.message }); }
    })();
    return true;
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchJobHTML") {
    fetch(request.url)
      .then(r => r.text())
      .then(html => sendResponse({ success: true, html }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// KEY ROTATION
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1wzgeUWKlXe-QU-rDZLaLjIQxeXreNvbm3Fi88UZjXWM/gviz/tq?tqx=out:csv&sheet=Gemini%20API';

const keyPool = { keys: [], exhausted: new Set(), date: null, loaded: false };

function todayStr() { return new Date().toISOString().slice(0, 10); }

async function loadKeys(sheetUrl) {
  let url = sheetUrl || SHEET_CSV_URL;
  const mId = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (mId && !url.includes('gviz/tq')) {
    url = `https://docs.google.com/spreadsheets/d/${mId[1]}/gviz/tq?tqx=out:csv&sheet=Gemini%20API`;
  }
  try {
    const text = await (await fetch(url)).text();
    if (text.trim().startsWith('<')) { console.log('[SAC BG] ❌ Sheet trả về HTML'); return; }
    const keys = text.replace(/\r/g, '').split('\n').slice(3)
      .map(l => l.split(',')[0].replace(/^"|"$/g, '').trim())
      .filter(k => k.length > 15);
    keyPool.keys = keys; keyPool.loaded = true; keyPool.date = todayStr();
    console.log(`[SAC BG] ✅ Loaded ${keys.length} keys`);
  } catch (e) { console.log('[SAC BG] ❌ Load keys failed:', e.message); }
}

function getKey(fallback) {
  if (keyPool.date !== todayStr()) { keyPool.exhausted.clear(); keyPool.date = todayStr(); }
  return keyPool.keys.find(k => !keyPool.exhausted.has(k)) || fallback || null;
}

function exhaustKey(key) {
  keyPool.exhausted.add(key);
  const rem = keyPool.keys.filter(k => !keyPool.exhausted.has(k)).length;
  const idx = keyPool.keys.indexOf(key) + 1;
  console.log(`[SAC BG] ⚠️ Key [${idx}] exhausted | còn: ${rem}/${keyPool.keys.length}`);
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action !== 'resetKeyPool') return;
  keyPool.loaded = false; keyPool.keys = []; keyPool.exhausted.clear();
  console.log('[SAC BG] Key pool reset');
  // Reload ngay sau khi reset để sẵn sàng cho lần gọi tiếp theo
  chrome.storage.local.get('_sacAiConfig', ({ _sacAiConfig }) => {
    if (_sacAiConfig?.sheetUrl || SHEET_CSV_URL) loadKeys(_sacAiConfig?.sheetUrl);
  });
});

// Preload keys ngay khi service worker khởi động
chrome.storage.local.get('_sacAiConfig', ({ _sacAiConfig }) => {
  loadKeys(_sacAiConfig?.sheetUrl);
});

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI API HELPER — hỗ trợ rotation + retry
// ─────────────────────────────────────────────────────────────────────────────

function parseRetryMs(errText) {
  try {
    const json = JSON.parse(errText);
    const info = json.error?.details?.find(d => d['@type']?.includes('RetryInfo'));
    if (info?.retryDelay) { const s = parseFloat(info.retryDelay); if (!isNaN(s)) return Math.ceil(s * 1000); }
  } catch {}
  return 0;
}

const MAX_503_RETRIES = 3;  // 503 retry tối đa 3 lần rồi fail

async function callGemini(cfg, prompt) {
  const model = cfg.geminiModel || 'gemini-2.5-flash';

  if (!keyPool.loaded) await loadKeys(cfg.sheetUrl || SHEET_CSV_URL);
  const useRotation = keyPool.keys.length > 0;

  // AbortController 40s — cancel fetch và thoát loop trước khi formAutofill timeout 45s
  const controller = new AbortController();
  const globalTimeout = setTimeout(() => {
    console.log('[SAC BG] ⏱️ callGemini global timeout 40s — aborting');
    controller.abort();
  }, 40000);

  let retries503 = 0;

  try {
    while (true) {
      if (controller.signal.aborted) throw new Error('⏱️ Timeout: quá 40s');

      const key = useRotation ? getKey(cfg.apiKey) : cfg.apiKey;
      if (!key) {
        console.log('[SAC BG] ⛔ Tất cả key đã hết quota — dừng tool');
        chrome.runtime.sendMessage({ action: 'allKeysExhausted' });
        throw new Error('⛔ Tất cả key đã hết quota');
      }

      if (useRotation) {
        const idx = keyPool.keys.indexOf(key) + 1;
        console.log(`[SAC BG] 🔑 Key [${idx}/${keyPool.keys.length}]`);
      }

      let res;
      try {
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
            signal: controller.signal }
        );
      } catch (e) {
        if (e.name === 'AbortError') throw new Error('⏱️ Timeout: quá 40s');
        throw e;
      }

      if (res.status === 503) {
        retries503++;
        if (retries503 > MAX_503_RETRIES) throw new Error('Gemini 503: overloaded sau ' + MAX_503_RETRIES + ' lần retry');
        console.log(`[SAC BG] Gemini 503 (${retries503}/${MAX_503_RETRIES}) — retry 5s`);
        await new Promise(r => setTimeout(r, 5000)); continue;
      }

      if (res.status === 429) {
        // Bất kỳ 429 → exhausted key ngay, chuyển key tiếp, không chờ
        exhaustKey(key);
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
      }

      const json = await res.json();
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
      console.log(`[SAC BG] Gemini OK — finishReason=${json.candidates?.[0]?.finishReason}, len=${text.length}`);
      return text;
    }
  } finally {
    clearTimeout(globalTimeout);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// callAI — Per-field AI call (text fields, combobox fallback)
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'callAI') return;

  (async () => {
    try {
      const stored = await chrome.storage.local.get('_sacAiConfig');
      const cfg = stored._sacAiConfig;
      if (!cfg?.apiKey) { sendResponse({ success: false, error: 'Chưa cấu hình API key' }); return; }

      const resume = cfg.resumeData ? JSON.stringify(cfg.resumeData) : (cfg.resume || '').slice(0, 2000);
      const prompt = `You are filling out a job application form. Answer concisely based on the candidate profile.
Return ONLY the answer text — no explanation, no label prefix.

Candidate Profile:
${resume}

Question/Field: ${request.question}`;

      console.log(`[SAC BG] callAI — fieldLen=${request.question?.length}`);
      const answer = await callGemini(cfg, prompt);
      sendResponse({ success: true, answer });
    } catch (err) {
      console.log('[SAC BG] callAI error:', err.message);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});

// ─────────────────────────────────────────────────────────────────────────────
// callAISchema — Schema-based batch fill (1 lần gọi cho toàn bộ form)
// Nhận formSchema từ formAutofill.js, trả về mảng answers
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'callAISchema') return;

  (async () => {
    try {
      const stored = await chrome.storage.local.get('_sacAiConfig');
      const cfg = stored._sacAiConfig;
      if (!cfg?.apiKey) { sendResponse({ success: false, error: 'Chưa cấu hình API key' }); return; }

      const resume = cfg.resumeData ? JSON.stringify(cfg.resumeData) : (cfg.resume || '').slice(0, 2000);
      const { formSchema } = request;

      const prompt = `You are an AI assistant helping fill out a job application form on behalf of a candidate.
Analyze the label/context of EACH field and provide the most appropriate answer.

CANDIDATE PROFILE:
${resume}

FORM SCHEMA:
${JSON.stringify(formSchema)}

STRICT RULES:
1. For action "type": return the text string to fill in the field. ALWAYS provide an answer — use the candidate profile to craft a reasonable response. For "How did you hear about us?" use "LinkedIn" or "Simplify.jobs". For motivation/fit questions, write 1–2 sentences using the candidate's background.
2. For action "select": return the EXACT "value" from the options array (not the text).
3. For action "check": return boolean true/false. Default true for legal/consent/privacy checkboxes.
4. Only omit a field if you have absolutely no basis for any answer.
5. Output ONLY raw JSON — absolutely NO markdown fences, NO explanation text.

REQUIRED OUTPUT FORMAT (raw JSON only):
{"answers":[{"id":"field_001","action":"type","value":"John"},{"id":"field_002","action":"select","value":"us"},{"id":"field_003","action":"check","value":true}]}`;

      console.log(`[SAC BG] callAISchema — fields=${formSchema.length}, promptLen=${prompt.length}`);
      const raw = await callGemini(cfg, prompt);

      // Parse JSON — bỏ markdown wrapper phòng khi model không tuân thủ
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const match   = cleaned.match(/\{[\s\S]*\}/);
      const parsed  = JSON.parse(match?.[0] || cleaned);

      console.log(`[SAC BG] callAISchema — ${parsed.answers?.length ?? 0} answers`);
      sendResponse({ success: true, answers: parsed.answers || [] });
    } catch (err) {
      console.log('[SAC BG] callAISchema error:', err.message);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});

// ─────────────────────────────────────────────────────────────────────────────
// TAB LIFECYCLE MONITORING
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== "trackFormTab") return;

  chrome.tabs.query({ lastFocusedWindow: true }, (tabs) => {
    const newestTab = tabs
      .filter(t => t.id !== sender.tab?.id)
      .sort((a, b) => b.id - a.id)[0];

    if (!newestTab) { sendResponse({ success: false }); return; }

    chrome.storage.local.set({ _sacFormTabId: newestTab.id });
    console.log("[SAC BG] Tracking form tab ID:", newestTab.id, newestTab.url);
    sendResponse({ success: true, tabId: newestTab.id });
    injectAutofillWhenReady(newestTab.id);
  });
  return true;
});

function injectAutofillWhenReady(tabId) {
  let injected = false;

  async function doInject() {
    if (injected) return;
    injected = true;
    cleanup();
    console.log("[SAC BG] Injecting formAutofill.js vào tab", tabId);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['formAutofill.js'] });
        console.log("[SAC BG] formAutofill.js injected OK (attempt", attempt, ")");
        return;
      } catch (err) {
        console.log("[SAC BG] Inject attempt", attempt, "failed:", err.message);
        if (attempt < 3) await new Promise(r => setTimeout(r, 400));
      }
    }
    console.log("[SAC BG] Inject FAILED after 3 attempts, tab", tabId);
  }

  function onUpdated(updatedTabId, changeInfo) {
    if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
    setTimeout(doInject, 300);
  }
  function onRemoved(removedTabId) { if (removedTabId === tabId) cleanup(); }
  function cleanup() {
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(onRemoved);
    clearTimeout(fallback);
  }

  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(onRemoved);

  const fallback = setTimeout(() => {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError || !tab) return;
      if (tab.status === 'complete' && !injected) doInject();
    });
  }, 600);
}

// (A) Form tab đóng → clear busy lock
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get(['_sacFormBusy', '_sacFormTabId'], ({ _sacFormBusy, _sacFormTabId }) => {
    if (_sacFormBusy && _sacFormTabId === tabId) {
      console.log("[SAC BG] Form tab", tabId, "đóng → clear busy lock");
      chrome.storage.local.set({ _sacFormBusy: false, _sacFormTs: 0, _sacFormTabId: null });
    }
  });
});

// (B) Form tab redirect → clear busy lock
// Trigger khi: về simplify.jobs HOẶC trang confirmation sau submit
const SUBMIT_SUCCESS_URL = /confirmation|thank.?you|thanks|success|submitted|complete|received|applied/i;
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  chrome.storage.local.get(['_sacFormBusy', '_sacFormTabId'], ({ _sacFormBusy, _sacFormTabId }) => {
    if (!_sacFormBusy || _sacFormTabId !== tabId) return;
    if (changeInfo.url.includes('simplify.jobs') || SUBMIT_SUCCESS_URL.test(changeInfo.url)) {
      console.log("[SAC BG] Form tab", tabId, "redirect → clear busy lock:", changeInfo.url.slice(-80));
      chrome.storage.local.set({ _sacFormBusy: false, _sacFormTs: 0, _sacFormTabId: null });
    }
  });
});
