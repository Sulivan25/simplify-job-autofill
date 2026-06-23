// content.js - Kịch bản Tự Động Kích Hoạt & Auto Apply Hỗn Hợp cho Simplify.jobs
let isCrawling = false;
let maxPages = 1;

// --- DEDUPLICATION: dùng Set + sessionStorage để survive DOM re-render ---
// (allJobsApplied array cũ bị mất khi SPA thay thế DOM nodes)
function getProcessedSet() {
    try {
        return new Set(JSON.parse(sessionStorage.getItem('_sac_processed') || '[]'));
    } catch { return new Set(); }
}
function markProcessed(jobId) {
    const s = getProcessedSet();
    s.add(jobId);
    try { sessionStorage.setItem('_sac_processed', JSON.stringify([...s])); } catch {}
}
function isProcessed(jobId) {
    return getProcessedSet().has(jobId);
}

// --- HELPERS ---
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function randomDelay(min = 1500, max = 3000) {
    return new Promise(resolve => setTimeout(resolve, min + Math.random() * (max - min)));
}
function log(...args) { console.log("[Simplify Auto-Apply]", ...args); }

// --- UI PANEL ---
function createPanel() {
    if (document.querySelector("#indeed-crawler-panel")) return;

    const panel = document.createElement("div");
    panel.id = "indeed-crawler-panel";
    panel.innerHTML = `
    <div id="indeed-crawler-controls">
      <button id="indeed-start-btn" style="background-color: #22c55e; color: white; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Bắt Đầu Auto Apply</button>
      <button id="indeed-stop-btn" style="background-color: #ef4444; color: white; padding: 6px 12px; border-radius: 4px; cursor: pointer; margin-left: 5px;">Dừng Bot</button>
      <label style="margin-left: 10px; color: white;">
        Số lượt cuộn tìm Job:
        <input type="number" id="max-pages-input" value="${maxPages}" min="1" style="width: 50px; color: black; text-align: center;"/>
      </label>
    </div>
    <div id="indeed-crawler-status" style="margin-top: 5px; color: #60a5fa;">Sẵn sàng chạy kịch bản ứng tuyển.</div>
    <div id="indeed-crawler-table-wrapper" style="max-height: 180px; overflow-y: auto; margin-top: 5px;">
      <table id="indeed-crawler-table" style="width: 100%; font-size: 12px; table-layout: fixed;">
        <thead>
          <tr style="text-align: left;">
            <th style="width:28%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Công ty</th>
            <th style="width:42%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Vị trí</th>
            <th style="width:30%;">Trạng thái</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <div id="sac-ai-settings">
      <div id="sac-ai-toggle">⚙️ Cài đặt AI <span id="sac-ai-chevron">▼</span></div>
      <div id="sac-ai-body">
        <label>Provider:
          <select id="sac-ai-provider">
            <option value="openai">OpenAI GPT-4o-mini</option>
            <option value="gemini">Google Gemini 2.0 Flash</option>
          </select>
        </label>
        <label id="sac-key-label">API Key:
          <input type="password" id="sac-ai-key" placeholder="sk-... hoặc AIza..."/>
        </label>
        <label id="sac-sheet-label" style="display:none;">Sheet URL (danh sách key Gemini):
          <input type="text" id="sac-ai-sheet-url" placeholder="https://docs.google.com/spreadsheets/d/1wzgeUWKlXe-QU-rDZLaLjIQxeXreNvbm3Fi88UZjXWM/edit?usp=sharing" style="width:100%;font-size:10px;"/>
          <span style="color:#94a3b8;font-size:10px;">Publish sheet → File → Share → Publish to web → CSV</span>
        </label>
        <label>Resume (paste plain text):
          <textarea id="sac-ai-resume" rows="6" placeholder="Dán nội dung resume vào đây..."></textarea>
        </label>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <button id="sac-ai-save">💾 Lưu cài đặt</button>
          <button id="sac-ai-parse">📋 Parse Resume</button>
          <span id="sac-ai-save-status"></span>
        </div>
        <div id="sac-resume-data-status" style="font-size:10px;color:#94a3b8;margin-top:4px;"></div>
      </div>
    </div>
  `;
    document.body.appendChild(panel);

    document.getElementById("indeed-start-btn").onclick = () => startAutoApplyLoop();
    document.getElementById("indeed-stop-btn").onclick = () => {
        isCrawling = false;
        chrome.storage.local.set({ isCrawling: false });
        updateStatus("🛑 Đã gửi lệnh dừng bot.");
    };

    // --- AI Settings: load saved config ---
    function updateProviderUI(provider) {
        const isGemini = provider === 'gemini';
        document.getElementById("sac-key-label").style.display   = isGemini ? 'none'  : 'block';
        document.getElementById("sac-sheet-label").style.display  = isGemini ? 'block' : 'none';
    }

    chrome.storage.local.get('_sacAiConfig', ({ _sacAiConfig }) => {
        if (_sacAiConfig) {
            document.getElementById("sac-ai-provider").value       = _sacAiConfig.provider  || "openai";
            document.getElementById("sac-ai-key").value            = _sacAiConfig.apiKey    || "";
            document.getElementById("sac-ai-sheet-url").value      = _sacAiConfig.sheetUrl  || "";
            document.getElementById("sac-ai-resume").value         = _sacAiConfig.resume    || "";
            updateProviderUI(_sacAiConfig.provider || "openai");
            if (_sacAiConfig.resumeData) {
                document.getElementById("sac-resume-data-status").textContent =
                    "✅ Resume đã parse: " + Object.keys(_sacAiConfig.resumeData).length + " fields";
            }
        }
    });

    document.getElementById("sac-ai-provider").onchange = (e) => updateProviderUI(e.target.value);

    // Toggle collapse
    document.getElementById("sac-ai-toggle").onclick = () => {
        const body    = document.getElementById("sac-ai-body");
        const chevron = document.getElementById("sac-ai-chevron");
        const open    = body.style.display !== "none";
        body.style.display    = open ? "none" : "block";
        chevron.textContent   = open ? "▼" : "▲";
    };

    // Save config
    document.getElementById("sac-ai-save").onclick = () => {
        const provider = document.getElementById("sac-ai-provider").value;
        const cfg = {
            provider,
            apiKey:   document.getElementById("sac-ai-key").value.trim(),
            sheetUrl: document.getElementById("sac-ai-sheet-url").value.trim(),
            resume:   document.getElementById("sac-ai-resume").value.trim()
        };
        // Xóa resumeData cũ khi resume text thay đổi
        chrome.storage.local.set({ _sacAiConfig: cfg }, () => {
            chrome.runtime.sendMessage({ action: 'resetKeyPool' });
            document.getElementById("sac-resume-data-status").textContent = "⚠️ Resume thay đổi — nhấn Parse Resume lại";
            const st = document.getElementById("sac-ai-save-status");
            st.textContent = "✅ Đã lưu!";
            setTimeout(() => { st.textContent = ""; }, 2000);
        });
    };

    // Parse Resume → compact JSON
    document.getElementById("sac-ai-parse").onclick = async () => {
        const st = document.getElementById("sac-resume-data-status");
        const stored = await chrome.storage.local.get('_sacAiConfig');
        const cfg = stored._sacAiConfig;
        if (!cfg?.resume) { st.textContent = "❌ Chưa có resume — lưu cài đặt trước."; return; }

        st.textContent = "⏳ Đang parse resume...";
        const prompt = `Extract key info from this resume into compact JSON. Return ONLY valid JSON, no explanation:
{
  "name": "",
  "email": "",
  "phone": "",
  "location": "",
  "work_auth_us": true,
  "visa_sponsorship": false,
  "experience_years": 0,
  "current_role": "",
  "skills": [],
  "education": "",
  "linkedin": "",
  "languages": [],
  "summary": ""
}

Resume:
${cfg.resume}`;

        chrome.runtime.sendMessage(
            { action: 'callAI', provider: cfg.provider, apiKey: cfg.apiKey, sheetUrl: cfg.sheetUrl, resume: '', question: prompt, rawPrompt: true },
            res => {
                if (!res?.success || !res.answer) {
                    st.textContent = "❌ Parse thất bại: " + (res?.error || 'no response');
                    return;
                }
                try {
                    const cleaned = res.answer.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
                    const match = cleaned.match(/\{[\s\S]*\}/);
                    const resumeData = JSON.parse(match?.[0] || cleaned);
                    chrome.storage.local.set({ _sacAiConfig: { ...cfg, resumeData } }, () => {
                        const keys = Object.keys(resumeData).length;
                        st.textContent = `✅ Đã parse: ${keys} fields — ${JSON.stringify(resumeData).length} chars`;
                    });
                } catch (e) {
                    st.textContent = "❌ Không parse được JSON: " + res.answer.slice(0, 100);
                }
            }
        );
    };
}

function updateStatus(text) {
    const el = document.getElementById("indeed-crawler-status");
    if (el) el.textContent = text;
    log(text);
}

function appendToTable(company, title, status, success = true) {
    const tbody = document.querySelector("#indeed-crawler-table tbody");
    if (!tbody) return;
    const row = document.createElement("tr");
    row.innerHTML = `
    <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${company}">${company}</td>
    <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${title}">${title}</td>
    <td style="color:${success ? '#22c55e' : '#f87171'};font-weight:bold;">${status}</td>
  `;
    tbody.appendChild(row);
    tbody.scrollTop = tbody.scrollHeight;
}

// =============================================================
// AI FORM FILL — điền các field mà Simplify bỏ sót bằng AI
// =============================================================

function setReactFieldValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new InputEvent('input',  { bubbles: true, data: value, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
}

function extractFieldLabel(el) {
    if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return lbl.innerText.replace(/\*/g, '').trim();
    }
    const ariaLbl = el.getAttribute('aria-label');
    if (ariaLbl) return ariaLbl.trim();
    const ariaRef = el.getAttribute('aria-labelledby');
    if (ariaRef) {
        const ref = document.getElementById(ariaRef);
        if (ref) return ref.innerText.trim();
    }
    if (el.placeholder) return el.placeholder.trim();
    let node = el.parentElement;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
        const lbl = node.querySelector('label');
        if (lbl && !lbl.contains(el)) return lbl.innerText.replace(/\*/g, '').trim();
        const legend = node.querySelector('legend');
        if (legend) return legend.innerText.trim();
    }
    return el.name || el.id || 'this field';
}

function extractLabelAbove(container) {
    const aria = container.getAttribute('aria-label');
    if (aria?.trim()) return aria.trim();
    const ariaRef = container.getAttribute('aria-labelledby');
    if (ariaRef) { const r = document.getElementById(ariaRef); if (r) return r.innerText.trim(); }
    const legend = container.closest('fieldset')?.querySelector('legend');
    if (legend) return legend.innerText.replace(/\*/g, '').trim();
    let node = container;
    for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
        let prev = node.previousElementSibling;
        while (prev) {
            if (prev.offsetParent !== null) {
                const txt = prev.innerText?.replace(/\*/g, '').trim();
                if (txt && txt.length >= 3 && txt.length <= 500) return txt;
            }
            prev = prev.previousElementSibling;
        }
    }
    return null;
}

function getEmptyTextFields() {
    const sel = [
        'input[type="text"]', 'input[type="email"]', 'input[type="url"]',
        'input[type="tel"]',  'input[type="number"]', 'textarea'
    ].join(',');
    return [...document.querySelectorAll(sel)].filter(el =>
        el.offsetParent !== null && !el.disabled && !el.readOnly &&
        (el.value || '').trim() === ''
    );
}

function getEmptySelectFields() {
    return [...document.querySelectorAll('select')].filter(el => {
        if (el.offsetParent === null || el.disabled) return false;
        if (!el.value) return true;
        const selected = el.options[el.selectedIndex];
        if (!selected?.value) return true;
        const firstText = (el.options[0]?.text || '').toLowerCase();
        return /select|choose|--|please|none|\s*/.test(firstText) && el.selectedIndex === 0;
    });
}

function getUncheckedCheckboxGroups() {
    const seen = new Set();
    const groups = [];
    [...document.querySelectorAll('input[type="checkbox"]')]
        .filter(cb => cb.offsetParent !== null && !cb.disabled)
        .forEach(cb => {
            let container = cb.closest('fieldset') || cb.closest('[role="group"]');
            if (!container) {
                let node = cb.parentElement;
                for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
                    if (node.querySelectorAll('input[type="checkbox"]').length > 1) { container = node; break; }
                }
            }
            if (!container || seen.has(container)) return;
            const cbs = [...container.querySelectorAll('input[type="checkbox"]')]
                .filter(c => c.offsetParent !== null && !c.disabled);
            if (cbs.some(c => c.checked)) return;
            seen.add(container);
            groups.push({ container, checkboxes: cbs });
        });
    return groups;
}

function getUncheckedRadioGroups() {
    const seen = new Set();
    const groups = [];
    [...document.querySelectorAll('input[type="radio"]')]
        .filter(r => r.offsetParent !== null && !r.disabled)
        .forEach(r => {
            const key = r.name || r.parentElement;
            if (!key || seen.has(key)) return;
            seen.add(key);
            const siblings = r.name
                ? [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(r.name)}"]`)]
                    .filter(x => x.offsetParent !== null && !x.disabled)
                : [r];
            if (siblings.some(x => x.checked)) return;
            groups.push({ key, radios: siblings });
        });
    return groups;
}

function getButtonToggleGroups() {
    const seen = new Set();
    const groups = [];
    const parentMap = new Map();
    for (const btn of document.querySelectorAll('button')) {
        if (btn.offsetParent === null || btn.disabled) continue;
        const txt = (btn.textContent || '').trim();
        if (!txt || txt.length > 50) continue;
        const lower = txt.toLowerCase();
        if (/^(submit|apply|next|back|cancel|save|continue|upload|browse|sign|log|autofill|fill|add|remove)/.test(lower)) continue;
        const parent = btn.parentElement;
        if (!parent) continue;
        if (!parentMap.has(parent)) parentMap.set(parent, []);
        parentMap.get(parent).push(btn);
    }
    for (const [parent, buttons] of parentMap) {
        if (buttons.length < 2 || buttons.length > 6) continue;
        if (seen.has(parent)) continue;
        const anyActive = buttons.some(b =>
            b.getAttribute('aria-pressed') === 'true' ||
            b.getAttribute('aria-selected') === 'true' ||
            b.classList.contains('active') || b.classList.contains('selected')
        );
        if (anyActive) continue;
        const label = extractLabelAbove(parent);
        if (!label || label.length < 3) continue;
        seen.add(parent);
        groups.push({ container: parent, buttons, label });
    }
    return groups;
}

function fieldKey(el) {
    return el.id || el.name || (el.getAttribute('aria-label') || '') + el.placeholder;
}

function waitForDomSettle(timeoutMs = 8000, settleMs = 1200) {
    return new Promise(resolve => {
        let lastChange = Date.now();
        const startTime = Date.now();
        const observer = new MutationObserver(() => { lastChange = Date.now(); });
        observer.observe(document.body, {
            subtree: true, childList: true,
            attributes: true, attributeFilter: ['value', 'class', 'disabled'],
        });
        const timer = setInterval(() => {
            const now = Date.now();
            if (now - lastChange >= settleMs || now - startTime >= timeoutMs) {
                clearInterval(timer);
                observer.disconnect();
                resolve();
            }
        }, 200);
    });
}

function callAI(question, cfg, retries = 2) {
    return new Promise(resolve => {
        function attempt(n) {
            chrome.runtime.sendMessage(
                { action: 'callAI', provider: cfg.provider, apiKey: cfg.apiKey, sheetUrl: cfg.sheetUrl, resume: cfg.resume, question },
                res => {
                    if (chrome.runtime.lastError) {
                        if (n > 0) { setTimeout(() => attempt(n - 1), 600); return; }
                        resolve(null); return;
                    }
                    if (!res?.success) {
                        const retryMs = res?.retryAfterMs || 0;
                        if (n > 0 && retryMs > 0 && retryMs <= 60000) {
                            setTimeout(() => attempt(n - 1), retryMs + 200);
                        } else { resolve(null); }
                        return;
                    }
                    resolve(res.answer || null);
                }
            );
        }
        attempt(retries);
    });
}

async function aiHandleSelect(el, cfg) {
    const label = extractFieldLabel(el);
    const options = [...el.options]
        .filter(o => o.value && !o.text.toLowerCase().match(/^(select|choose|--|please)/))
        .map((o, i) => ({ i, text: o.text.trim(), value: o.value }));
    if (!options.length) return;
    const prompt = `Question: "${label}"\nChoose the best option (reply NUMBER only):\n` +
        options.map(o => `${o.i + 1}. ${o.text}`).join('\n');
    const answer = await callAI(prompt, cfg);
    if (!answer) return;
    const num = parseInt(answer.trim());
    const chosen = (!isNaN(num) && options[num - 1])
        ? options[num - 1]
        : options.find(o => answer.toLowerCase().includes(o.text.toLowerCase()));
    if (chosen) {
        el.value = chosen.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        log(`✅ [select] "${label}" → "${chosen.text}"`);
    }
}

async function aiHandleCheckboxGroup({ container, checkboxes }, cfg) {
    const label = extractLabelAbove(container) || extractFieldLabel(container);
    if (!label || label.length < 2 || label.length > 300) return;
    const options = checkboxes.map((cb, i) => {
        const lbl = cb.id ? document.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : null;
        const text = lbl?.innerText.trim() || cb.closest('label')?.innerText.trim() || cb.value || `Option ${i + 1}`;
        return { i, text, el: cb };
    });
    const prompt = `Question: "${label}"\nCheck appropriate option(s) (reply NUMBER only, comma-separated if multiple):\n` +
        options.map(o => `${o.i + 1}. ${o.text}`).join('\n');
    const answer = await callAI(prompt, cfg);
    if (!answer) return;
    const nums = answer.match(/\d+/g)?.map(Number) ?? [];
    for (const num of nums) {
        const opt = options[num - 1];
        if (opt && !opt.el.checked) { opt.el.click(); log(`✅ [checkbox] "${label}" → "${opt.text}"`); }
    }
}

async function aiHandleRadioGroup({ radios }, cfg) {
    const container = radios[0].closest('[role="radiogroup"]') || radios[0].closest('fieldset') || radios[0].parentElement;
    const label = extractLabelAbove(container) || extractFieldLabel(radios[0]);
    if (!label || label.length < 2 || label.length > 400) return;
    const options = radios.map((r, i) => {
        const text = (r.id ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.innerText.replace(/\*/g, '').trim() : null)
            || r.closest('label')?.innerText.trim() || r.value || `Option ${i + 1}`;
        return { i, text, el: r };
    });
    const prompt = `Question: "${label}"\nSelect one option (reply NUMBER only):\n` +
        options.map(o => `${o.i + 1}. ${o.text}`).join('\n');
    const answer = await callAI(prompt, cfg);
    if (!answer) return;
    const num = parseInt(answer.trim());
    const chosen = (!isNaN(num) && options[num - 1])
        ? options[num - 1]
        : options.find(o => answer.toLowerCase().includes(o.text.toLowerCase()));
    if (chosen) { chosen.el.click(); log(`✅ [radio] "${label}" → "${chosen.text}"`); }
}

async function aiHandleButtonToggleGroup({ buttons, label }, cfg) {
    if (!label || label.length < 2 || label.length > 400) return;
    const options = buttons.map((b, i) => ({ i, text: b.textContent.trim(), el: b }));
    const prompt = `Question: "${label}"\nClick the best option (reply NUMBER only):\n` +
        options.map(o => `${o.i + 1}. ${o.text}`).join('\n');
    const answer = await callAI(prompt, cfg);
    if (!answer) return;
    const num = parseInt(answer.trim());
    const chosen = (!isNaN(num) && options[num - 1])
        ? options[num - 1]
        : options.find(o => answer.toLowerCase().includes(o.text.toLowerCase()));
    if (chosen) { chosen.el.scrollIntoView({ block: 'center' }); chosen.el.click(); log(`✅ [toggle] "${label}" → "${chosen.text}"`); }
}

async function scanAndFillEmptyFields() {
    const stored = await chrome.storage.local.get('_sacAiConfig');
    const cfg = stored._sacAiConfig;
    const needsKey = cfg?.provider === 'openai' || (cfg?.provider === 'gemini' && !cfg?.sheetUrl);
    if ((needsKey && !cfg?.apiKey) || !cfg?.resume || !cfg?.provider) {
        log("ℹ️ AI fill: chưa cấu hình — bỏ qua.");
        return;
    }

    const attempted = new Set();

    for (let round = 0; round < 5; round++) {
        const found = {
            text:     getEmptyTextFields().filter(f => !attempted.has(fieldKey(f))),
            select:   getEmptySelectFields(),
            checkbox: getUncheckedCheckboxGroups(),
            radio:    getUncheckedRadioGroups(),
            toggle:   getButtonToggleGroups(),
        };
        const total = Object.values(found).reduce((s, a) => s + a.length, 0);
        if (total === 0) { log("✅ AI fill: không còn field trống."); break; }

        log(`🤖 AI fill round ${round + 1}: ${total} field(s)`);
        updateStatus(`🤖 AI đang điền ${total} trường còn trống...`);

        for (const f of found.text) {
            let q = extractFieldLabel(f);
            if (!q || q.length < 2) continue;
            if (q.length > 300) q = q.slice(0, 300);
            attempted.add(fieldKey(f));
            const ans = await callAI(q, cfg);
            if (ans) { f.scrollIntoView({ block: 'center' }); setReactFieldValue(f, ans); log(`✅ [text] "${q}" → "${ans.slice(0, 80)}"`); }
            await wait(300);
        }
        for (const f of found.select) { await aiHandleSelect(f, cfg); await wait(300); }
        for (const g of found.checkbox) { await aiHandleCheckboxGroup(g, cfg); await wait(300); }
        for (const g of found.radio) { await aiHandleRadioGroup(g, cfg); await wait(300); }
        for (const g of found.toggle) { await aiHandleButtonToggleGroup(g, cfg); await wait(400); }

        await waitForDomSettle(5000, 800);
    }
    updateStatus("✅ AI đã điền xong các trường còn trống.");
}

// --- SHADOW DOM HELPERS (Simplify Extension) ---
// Extension Simplify nhúng UI vào Shadow Root của div.simplify-jobs-shadow-root
// Phải truy cập qua host.shadowRoot — document.getElementById() không xuyên được shadow boundary

function getSimplifyRoot() {
    const ls = document.getElementsByClassName("simplify-jobs-shadow-root");

    // DEBUG: kiểm tra host element có tồn tại không
    log(`🔍 shadowRoot check: tìm thấy ${ls ? ls.length : 0} host element(s) với class "simplify-jobs-shadow-root"`);

    if (!ls || ls.length === 0) {
        log("❌ shadowRoot: KHÔNG tìm thấy host nào — Simplify chưa inject hoặc sai class");
        return null;
    }

    // Chỉ lấy phần tử [0] từ HTMLCollection trả về
    const host = ls[0];
    log(`🔍 shadowRoot: ls[0] = <${host.tagName.toLowerCase()}> id="${host.id}" class="${host.className.slice(0, 60)}"`);

    if (!host.shadowRoot) {
        log("❌ shadowRoot: ls[0].shadowRoot = null (closed mode hoặc chưa attach)");
        return null;
    }

    log(`✅ shadowRoot: OK — ${host.shadowRoot.children.length} children bên trong`);
    return host.shadowRoot;
}

function querySimplify(selector) {
    const root = getSimplifyRoot();
    return root ? root.querySelector(selector) : null;
}

// Tìm #fill-button bằng cách quét TẤT CẢ host elements (không chỉ ls[0])
// Vì Simplify inject nhiều shadow root — fill-button có thể ở host bất kỳ
function findAutofillButton() {
    const hosts = document.getElementsByClassName("simplify-jobs-shadow-root");
    if (!hosts || hosts.length === 0) {
        log("❌ Không tìm thấy host element nào.");
        return null;
    }

    log(`🔍 Quét ${hosts.length} host elements tìm #fill-button...`);

    for (let i = 0; i < hosts.length; i++) {
        const root = hosts[i].shadowRoot;
        if (!root) continue;

        // Ưu tiên #fill-button (confirmed ID)
        const byId = root.querySelector('#fill-button');
        if (byId) {
            log(`✅ Tìm thấy #fill-button tại host[${i}]`);
            return byId;
        }

        // Fallback: tìm theo text chính xác
        const match = [...root.querySelectorAll('button, [role="button"]')].find(el => {
            const t = (el.textContent || '').trim().toLowerCase();
            return t === 'autofill this page' || t === 'autofill';
        });
        if (match) {
            log(`✅ Tìm thấy autofill button bằng text tại host[${i}]`);
            return match;
        }
    }

    // Debug: log tất cả buttons tìm thấy trong mọi host
    for (let i = 0; i < hosts.length; i++) {
        const root = hosts[i].shadowRoot;
        if (!root) continue;
        const btns = [...root.querySelectorAll('button')];
        if (btns.length) {
            log(`🔎 host[${i}] buttons: ${btns.map(b => `#${b.id || '?'} "${b.textContent.trim().slice(0, 30)}"`).join(' | ')}`);
        }
    }

    return null;
}

// Poll #fill-button với timeout (render async sau khi tab/page load)
async function waitForAutofillButton(timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const btn = findAutofillButton();
        if (btn) {
            log("✅ Tìm thấy #fill-button.");
            return btn;
        }
        await wait(400);
    }
    log("⏱️ Timeout: không tìm thấy #fill-button sau " + timeoutMs + "ms");
    return null;
}

// --- CONTAINER SCROLL LOGIC ---
function getJobListContainer() {
    return [...document.querySelectorAll('div')].find(el =>
        el.classList.contains('overflow-y-auto') &&
        el.classList.contains('gap-4') &&
        el.scrollHeight > el.clientHeight
    ) || null;
}

async function wheelScroll(container, times = 22) {
    const cardHeight = document.querySelector('div.group.mx-auto.flex.size-full.flex-col')?.offsetHeight || 120;
    const rect = container.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    container.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY, bubbles: true }));
    await wait(100);

    for (let i = 0; i < times; i++) {
        container.dispatchEvent(new WheelEvent('wheel', {
            deltaY: cardHeight,
            deltaMode: 0,
            clientX,
            clientY,
            bubbles: true,
            cancelable: true
        }));
        await wait(80);
    }
}

// --- LẤY STABLE ID CHO CARD (tránh dùng title/company text dễ thay đổi) ---
function getCardJobId(card) {
    // Ưu tiên: link href → data attribute → fallback title+company
    const link = card.querySelector('a[href*="/jobs/"], a[href*="job"]');
    if (link && link.href) {
        try {
            return new URL(link.href).pathname; // vd: /jobs/abc123
        } catch {}
    }
    // Thử data-id / data-job-id attribute
    const dataId = card.getAttribute('data-id') || card.getAttribute('data-job-id') || card.getAttribute('id');
    if (dataId) return dataId;

    // Fallback: title + company text (kém ổn định hơn nhưng vẫn dùng)
    const titleEl = card.querySelector('h3') || card.querySelector('h2') || card.querySelector('h4');
    const companyEl = card.querySelector('span.text-left') || card.querySelector('div.text-secondary-300 span');
    const title = titleEl ? titleEl.innerText.trim() : '';
    const company = companyEl ? companyEl.innerText.trim() : '';
    return title || company ? `${title}__${company}` : null;
}

// Kiểm tra extension context còn hợp lệ không
// (bị invalidate khi extension reload mà tab chưa refresh)
function isChromeContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
}

// Nhận thông báo hết key từ background.js → dừng tool
chrome.runtime.onMessage.addListener((request) => {
    if (request.action !== 'allKeysExhausted') return;
    isCrawling = false;
    chrome.storage.local.set({ isCrawling: false });
    updateStatus('⛔ Tất cả Gemini key đã hết quota hôm nay — tool đã dừng.');
    const st = document.getElementById("sac-resume-data-status");
    if (st) st.textContent = '⛔ Hết quota — thêm key mới vào Sheet hoặc chờ ngày mai.';
});

// --- CORE WORKFLOW LOOP ---
async function startAutoApplyLoop() {
    if (isCrawling) return;

    if (!isChromeContextValid()) {
        alert('⚠️ Extension vừa được reload.\nHãy refresh trang này (Cmd+R) rồi thử lại.');
        return;
    }

    const inputVal = document.getElementById("max-pages-input").value;
    maxPages = parseInt(inputVal) || 1;

    isCrawling = true;
    chrome.storage.local.set({ isCrawling, maxPages });
    document.getElementById("indeed-start-btn").disabled = true;

    let currentScroll = 0;
    let lastHeight = 0;

    updateStatus("⏳ Đang đợi danh sách Job hiển thị ổn định...");
    let retries = 0;
    while (!document.querySelector('div.group.mx-auto.flex.size-full.flex-col') && retries < 10) {
        await wait(1000);
        retries++;
    }

    while (isCrawling && currentScroll < maxPages) {
        updateStatus(`🔄 Quét job — đợt cuộn ${currentScroll + 1}/${maxPages}...`);
        await clickAndProcessJobCards();

        const container = getJobListContainer();
        if (!container) {
            log("Không tìm thấy container cuộn trang, dừng.");
            break;
        }

        await wheelScroll(container, 22);
        await wait(3000);

        const newHeight = container.scrollHeight;
        if (newHeight === lastHeight) {
            log("Đã duyệt hết danh sách công việc.");
            break;
        }
        lastHeight = newHeight;
        currentScroll++;
    }

    isCrawling = false;
    document.getElementById("indeed-start-btn").disabled = false;
    updateStatus("🎉 Đã hoàn thành toàn bộ danh sách ứng tuyển ngày hôm nay!");
}

// --- XỬ LÝ CLICK CARD ---
async function clickAndProcessJobCards() {
    const jobCards = document.querySelectorAll('div.group.mx-auto.flex.size-full.flex-col');
    for (let card of jobCards) {
        if (!isCrawling) break;

        // --- CHỐNG CLICK LOOP (2 lớp) ---
        // Lớp 1: data attribute (nhanh, bị mất khi React re-render)
        if (card.dataset.autoApplied === 'true') continue;

        // Lớp 2: stable ID + sessionStorage (persist qua re-render và page navigation SPA)
        const jobId = getCardJobId(card);
        if (jobId && isProcessed(jobId)) {
            card.dataset.autoApplied = 'true'; // sync lại attribute
            continue;
        }

        // Đánh dấu TRƯỚC KHI click để tránh loop nếu event handler kích hoạt lại
        card.dataset.autoApplied = 'true';
        if (jobId) markProcessed(jobId);

        try {
            const titleEl = card.querySelector('h3') || card.querySelector('h2') || card.querySelector('h4');
            const companyEl = card.querySelector('span.text-left') || card.querySelector('span[class*="text-left"]') || card.querySelector('div.text-secondary-300 span');
            const jobTitle = titleEl ? titleEl.innerText.trim() : "Unknown Title";
            const jobCompany = companyEl ? companyEl.innerText.trim() : "Unknown Company";

            log(`👉 Đang chọn Card: ${jobTitle} - ${jobCompany} (ID: ${jobId})`);
            card.scrollIntoView({ block: 'center', behavior: 'smooth' });
            await wait(300); // chờ scroll settle trước khi click
            card.click();
            await wait(2500); // chờ detail panel render

            // Tìm nút Apply trong detail panel bên phải
            // Dùng selector linh hoạt thay vì exact class match
            const applyButton =
                document.querySelector('button.bg-primary-400:has(span)')        ||
                document.querySelector('a.bg-primary-400')                        ||
                [...document.querySelectorAll('button, a')].find(el => {
                    const txt = (el.textContent || '').trim().toLowerCase();
                    return (txt === 'apply' || txt === 'apply now') &&
                           el.offsetParent !== null;
                });

            if (applyButton) {
                log("🎯 Tìm thấy nút Apply. Đang click...");
                applyButton.click();

                updateStatus(`⏳ Chờ Simplify Extension render autofill popup...`);

                // Chờ + click nút "Autofill this page" trong Shadow DOM của Simplify extension
                await handleSimplifyAutofill(jobCompany, jobTitle);
            } else {
                log("⚠️ Không tìm thấy nút Apply — bỏ qua job này.");
                appendToTable(jobCompany, jobTitle, "Bỏ qua (không có Apply)", false);
            }

            await randomDelay(1500, 3000);

        } catch (err) {
            console.error("Lỗi khi xử lý Card:", err);
        }
    }
}

// --- SEMAPHORE: dùng chrome.storage để đồng bộ listing tab ↔ form tab ---
// Giải quyết n+1 tab: listing tab chờ form tab xong mới tiếp tục card tiếp theo

// setFormBusy trả về lockTs — timestamp chính xác do MÌNH set
// (không đọc lại từ storage để tránh đọc nhầm timestamp cũ từ lần chạy trước)
async function setFormBusy() {
    const lockTs = Date.now();
    await chrome.storage.local.set({ _sacFormBusy: true, _sacFormTs: lockTs });
    return lockTs;
}

// clearFormBusy reset cả timestamp về 0 — tránh timestamp cũ gây stale detection sai
async function clearFormBusy() {
    await chrome.storage.local.set({ _sacFormBusy: false, _sacFormTs: 0 });
}

// lockTs: timestamp do setFormBusy() trả về — dùng để detect stale chính xác
// (không dùng _sacFormTs từ storage vì có thể là giá trị cũ từ lần chạy trước)
async function waitFormDone(timeoutMs = 120000, lockTs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await wait(1000);
        const { _sacFormBusy } = await chrome.storage.local.get('_sacFormBusy');

        if (!_sacFormBusy) return true;
    }
    // Hết timeout
    await clearFormBusy();
    return false;
}

// --- XỬ LÝ SIMPLIFY AUTOFILL (chạy trên listing tab sau khi click Apply) ---
async function handleSimplifyAutofill(jobCompany, jobTitle) {
    try {
        // setFormBusy() trả về lockTs — dùng để detect stale chính xác
        const lockTs = await setFormBusy();
        await chrome.storage.local.set({ _sacCurrentJob: { company: jobCompany, title: jobTitle } });
        await wait(2000);

        const stillOnListing = document.querySelectorAll('div.group.mx-auto.flex.size-full.flex-col').length > 0;

        if (stillOnListing) {
            // Apply mở TAB MỚI → listing tab chờ form tab unlock
            log("📌 Form tab đã mở — đang chờ form tab hoàn thành...");
            updateStatus("⏳ Chờ form tab submit xong...");
            appendToTable(jobCompany, jobTitle, "⏳ Đang xử lý...", true);

            // Yêu cầu background.js track form tab vừa mở
            // → khi tab đó đóng hoặc redirect sang external domain,
            //   background.js tự clear _sacFormBusy (không cần chờ 90s nữa)
            chrome.runtime.sendMessage({ action: "trackFormTab" }, (res) => {
                if (res?.success) {
                    log(`🔭 Background đang track form tab ID: ${res.tabId}`);
                } else {
                    log("⚠️ Không track được form tab — dùng stale fallback 30s.");
                }
            });

            const done = await waitFormDone(120000, lockTs);
            if (done) {
                log("✅ Form tab đã xong — tiếp tục card tiếp theo.");
                // Cập nhật dòng "⏳ Đang xử lý" → "✅ Đã nộp"
                const rows = document.querySelectorAll("#indeed-crawler-table tbody tr");
                const last = rows[rows.length - 1];
                if (last) last.cells[2].textContent = "✅ Đã nộp";
            } else {
                log("⚠️ Timeout/crash chờ form tab.");
                appendToTable(jobCompany, jobTitle, "⚠️ Form tab không phản hồi", false);
            }
            return;
        }

        // Apply mở CÙNG TAB (SPA) — form đang hiển thị trên tab này
        updateStatus("⏳ Chờ #fill-button...");
        const autofillBtn = await waitForAutofillButton(12000);

        if (autofillBtn) {
            log(`🔌 Click #fill-button: "${autofillBtn.textContent.trim()}"`);
            autofillBtn.scrollIntoView({ block: 'center' });
            await wait(300);
            autofillBtn.click();
            updateStatus("⏳ Đang autofill...");
            await wait(6000);
            // AI fill các field còn trống sau khi Simplify đã fill (SPA path)
            await scanAndFillEmptyFields();
        } else {
            log("ℹ️ Không tìm thấy #fill-button.");
        }

        const submitButton = [...document.querySelectorAll('button, input[type="submit"], input[type="button"]')]
            .find(btn => {
                const txt = (btn.textContent || btn.value || "").toLowerCase().trim();
                return txt.includes('submit') || txt.includes('nộp đơn') || txt.includes('hoàn tất');
            });

        if (submitButton && submitButton.offsetParent !== null) {
            log(`🎉 Submit: "${(submitButton.textContent || submitButton.value).trim()}"`);
            submitButton.scrollIntoView({ block: 'center' });
            await wait(800);
            submitButton.click();
            await wait(3000);
            appendToTable(jobCompany, jobTitle, "✅ Đã nộp", true);
            await clearFormBusy();
            log("🔙 Navigate back về listing...");
            window.history.back();
            await wait(3000);
        } else {
            log("⚠️ Không tìm thấy Submit.");
            appendToTable(jobCompany, jobTitle, "⚠️ Chờ Submit thủ công", false);
            await clearFormBusy();
        }

    } catch (err) {
        console.error("Lỗi handleSimplifyAutofill:", err);
        appendToTable(jobCompany, jobTitle, "❌ Lỗi", false);
        await clearFormBusy(); // luôn unlock dù lỗi
    }
}

// --- KHỞI TẠO ---
// Panel chỉ hiển thị trên simplify.jobs (listing tab)
// Trên form page (greenhouse, lever, workday...) chỉ chạy auto-fill logic
if (window.location.hostname.includes('simplify.jobs')) {
    createPanel();
}

(async function init() {
    await wait(3000);
    const hasListingCards = document.querySelectorAll('div.group.mx-auto.flex.size-full.flex-col').length > 0;
    if (hasListingCards) {
        log("🗂️ Listing page xác nhận — panel đã sẵn sàng.");
    }
    // Form page autofill được xử lý bởi background.js executeScript (hoạt động trên mọi URL)
})();
