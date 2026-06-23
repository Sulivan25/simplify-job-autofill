// formAutofill.js — Inject vào form tab bởi background.js
// Kiến trúc: Schema Serialization → callAISchema → Smart Execution

(async function () {
  if (window._sacAutofillRunning) return;
  window._sacAutofillRunning = true;

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const log  = (...a) => console.log('[SAC Form]', ...a);

  let _quotaExhausted = false;
  chrome.runtime.onMessage.addListener((req) => {
    if (req.action === 'allKeysExhausted') {
      _quotaExhausted = true;
      log('⛔ Hết toàn bộ quota key — dừng autofill.');
    }
  });

  // Đọc lockTs + job info ngay khi inject
  const { _sacFormTs: myLockTs, _sacCurrentJob } = await chrome.storage.local.get(['_sacFormTs', '_sacCurrentJob']);

  const jobCompany = _sacCurrentJob?.company || '';
  const jobTitle   = _sacCurrentJob?.title   || '';
  log(`🏢 ${jobCompany} — ${jobTitle}`);

  // Overlay nhỏ góc trên bên phải để dễ nhận biết đang fill form nào
  const _overlay = document.createElement('div');
  _overlay.id = 'sac-form-overlay';
  Object.assign(_overlay.style, {
    position: 'fixed', top: '10px', right: '10px', zIndex: '2147483647',
    background: '#1e293b', color: '#fff', fontSize: '12px', lineHeight: '1.4',
    padding: '8px 12px', borderRadius: '8px', maxWidth: '320px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)', fontFamily: 'Arial, sans-serif',
    pointerEvents: 'none'
  });
  _overlay.innerHTML = `<b style="color:#60a5fa">🤖 Auto Apply</b><br>${jobCompany}<br><span style="color:#94a3b8">${jobTitle}</span>`;
  document.body?.appendChild(_overlay);

  async function clearMyLock() {
    const { _sacFormTs: currentTs } = await chrome.storage.local.get('_sacFormTs');
    if (!currentTs || currentTs === myLockTs) {
      await chrome.storage.local.set({ _sacFormBusy: false, _sacFormTs: 0, _sacFormTabId: null });
    } else {
      log('ℹ️ Lock đã thuộc form tab khác — bỏ qua clear.');
    }
  }

  log('Injected on:', location.href);

  // ─────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  // Giả lập React/Vue/Angular synthetic events để bypass state management
  function setReactFieldValue(el, value) {
    const proto  = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new InputEvent('input',  { bubbles: true, data: value, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  }

  // Trích xuất label của field từ DOM (label, aria, placeholder, parent legend...)
  function extractFieldLabel(el) {
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return lbl.innerText.replace(/\*/g, '').trim();
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const ariaRef = el.getAttribute('aria-labelledby');
    if (ariaRef) {
      const ref = document.getElementById(ariaRef);
      if (ref) return ref.innerText.trim();
    }
    let node = el.parentElement;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      // label / legend (chuẩn HTML)
      const lbl = node.querySelector('label');
      if (lbl && !lbl.contains(el)) return lbl.innerText.replace(/\*/g, '').trim();
      const legend = node.querySelector('legend');
      if (legend) return legend.innerText.trim();
      // Heading / paragraph phía trên (p, strong, h1-h6, div có text ngắn)
      let prev = node.previousElementSibling;
      while (prev) {
        if (prev.offsetParent !== null) {
          const txt = prev.innerText?.replace(/\*/g, '').trim();
          const lines = (txt?.match(/\n/g) || []).length;
          if (txt && txt.length >= 3 && txt.length <= 300 && lines <= 2) return txt;
        }
        prev = prev.previousElementSibling;
      }
    }
    // Fallback: placeholder (chỉ dùng nếu không phải generic)
    if (el.placeholder && !/^(type here|enter here|write here|...)/i.test(el.placeholder))
      return el.placeholder.trim();
    return el.name || el.id || 'this field';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 1: FORM SCHEMA SERIALIZATION
  // Gán data-sac-id cho mỗi field và build JSON schema
  // ─────────────────────────────────────────────────────────────────────────

  function buildFormSchema() {
    const idMap    = {};   // id → DOM element
    const schema   = [];
    let   counter  = 0;

    const selector = [
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"])',
      'textarea',
      'select',
      '[contenteditable="true"]'   // rich text editors (Trix, Quill, ProseMirror)
    ].join(', ');

    for (const el of document.querySelectorAll(selector)) {
      if (el.offsetParent === null || el.disabled || el.readOnly) continue;

      const type  = (el.getAttribute('type') || el.tagName).toLowerCase();
      const label = extractFieldLabel(el);
      if (!label || label.length < 2 || label.length > 300) continue;

      // Bỏ qua field đã có giá trị (trừ checkbox/radio/contenteditable)
      const currentText = el.contentEditable === 'true'
        ? (el.innerText || '').trim()
        : (el.value || '').trim();
      if (!['checkbox', 'radio'].includes(type) && type !== 'contenteditable' && currentText) continue;

      const id = `field_${String(++counter).padStart(3, '0')}`;
      el.setAttribute('data-sac-id', id);
      idMap[id] = el;

      if (el.tagName.toLowerCase() === 'select') {
        const options = [...el.options]
          .filter(o => o.value && !/^(select|choose|--|please)/i.test(o.text.trim()))
          .map(o => ({ text: o.text.trim(), value: o.value }));
        if (!options.length) continue;
        schema.push({ id, action: 'select', label, options });

      } else if (type === 'radio') {
        // Gom nhóm radio theo name — chỉ thêm 1 entry cho cả nhóm
        const name = el.name;
        if (name && schema.find(f => f._radioName === name)) continue;
        const siblings = name
          ? [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)]
              .filter(r => r.offsetParent !== null && !r.disabled)
          : [el];
        const options = siblings.map(r => {
          const lbl = r.id ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`) : null;
          return {
            text:  lbl?.innerText.replace(/\*/g,'').trim() || r.closest('label')?.innerText.trim() || r.value,
            value: r.value
          };
        }).filter(o => o.text && o.value);
        if (!options.length) continue;
        schema.push({ id, action: 'select', label, options, _radioName: name });

      } else if (type === 'checkbox') {
        schema.push({ id, action: 'check', label, currentValue: el.checked });

      } else if (el.contentEditable === 'true') {
        if (currentText) continue; // đã có nội dung
        schema.push({ id, action: 'type', label });

      } else {
        // text, email, tel, url, number, textarea
        schema.push({ id, action: 'type', label });
      }
    }

    // Button toggle groups (Yes/No, True/False, button-style choices)
    const seenBtnGroups = new Set();
    for (const btn of document.querySelectorAll('button')) {
      if (btn.offsetParent === null || btn.disabled) continue;
      const txt = (btn.textContent || '').trim();
      if (!txt || txt.length > 40) continue;
      // Bỏ qua action buttons
      if (/^(submit|apply|next|back|cancel|save|continue|upload|browse|add|remove|sign|log)/i.test(txt)) continue;

      const parent = btn.parentElement;
      if (!parent || seenBtnGroups.has(parent)) continue;

      const siblings = [...parent.querySelectorAll('button')]
        .filter(b => b.offsetParent !== null && !b.disabled && (b.textContent||'').trim().length <= 40
          && !/^(submit|apply|next|back|cancel|save|continue|upload|browse|add|remove)/i.test((b.textContent||'').trim()));
      if (siblings.length < 2 || siblings.length > 6) continue;

      // Bỏ qua nếu đã có button được chọn
      const anyActive = siblings.some(b =>
        b.getAttribute('data-sac-btn-filled') === 'true' ||
        b.getAttribute('aria-pressed') === 'true' ||
        b.getAttribute('aria-selected') === 'true' ||
        b.getAttribute('data-state') === 'active' ||
        b.getAttribute('data-state') === 'checked' ||
        b.getAttribute('data-selected') === 'true' ||
        b.getAttribute('data-active') === 'true' ||
        /\bactive\b|\bselected\b|\bis-active\b|\bchecked\b|\bring-\w|\bborder-primary\b|\bbg-primary\b/.test(b.className)
      );
      if (anyActive) continue;

      // Tìm label câu hỏi phía trên group
      let groupLabel = null;
      let node = parent;
      for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
        let prev = node.previousElementSibling;
        while (prev) {
          if (prev.offsetParent !== null) {
            const t = prev.innerText?.replace(/\*/g,'').trim();
            const lines = (t?.match(/\n/g)||[]).length;
            if (t && t.length >= 3 && t.length <= 300 && lines <= 2) { groupLabel = t; break; }
          }
          prev = prev.previousElementSibling;
        }
        if (groupLabel) break;
      }
      if (!groupLabel) continue;

      seenBtnGroups.add(parent);
      const id = `btn_${String(++counter).padStart(3, '0')}`;
      const options = siblings.map(b => ({ text: b.textContent.trim(), value: b.textContent.trim() }));
      schema.push({ id, action: 'button', label: groupLabel, options, _btnEls: siblings });
      idMap[id] = siblings[0]; // dùng button đầu tiên làm anchor
    }

    // Loại bỏ field nội bộ trước khi gửi lên AI
    const cleanSchema = schema.map(({ _radioName, _btnEls, ...f }) => f);
    return { idMap, schema: cleanSchema, btnGroups: schema.filter(f => f._btnEls).map(f => ({ id: f.id, label: f.label, options: f.options, els: f._btnEls })) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 2: GỌI AI QUA background.js
  // background.js giữ API Key và gọi Gemini — Content Script không bao giờ
  // chứa key trực tiếp (bảo mật theo kiến trúc MV3)
  // ─────────────────────────────────────────────────────────────────────────

  function callAISchema(formSchema) {
    return new Promise(resolve => {
      let settled = false;

      // Timeout 45s phòng service worker bị Chrome kill
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        log('⏱️ Schema call timeout 45s');
        resolve(null);
      }, 45000);

      try {
        chrome.runtime.sendMessage({ action: 'callAISchema', formSchema }, res => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);

          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || '';
            log('❌ lastError:', msg);
            resolve(null); return;
          }
          if (!res?.success) {
            log('❌ AI error:', res?.error);
            if (res?.error?.includes('hết quota')) _quotaExhausted = true;
            resolve(null); return;
          }
          resolve(res.answers || []);
        });
      } catch (e) {
        clearTimeout(timeout);
        if (!settled) { settled = true; resolve(null); }
      }
    });
  }

  // callAI per-field — dùng cho combobox (cần click mở trước mới có options)
  function callAI(question, retries = 2) {
    return new Promise(resolve => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return; settled = true;
        log('⏱️ callAI timeout 30s');
        resolve(null);
      }, 30000);

      function attempt(n) {
        log(`🌐 callAI → "${question.slice(0, 60)}" (attempt ${retries - n + 1})`);
        try {
          chrome.runtime.sendMessage({ action: 'callAI', question }, res => {
            if (settled) return;
            if (chrome.runtime.lastError) {
              const msg = chrome.runtime.lastError.message || '';
              if (msg.includes('invalidated') || msg.includes('disconnected')) {
                settled = true; clearTimeout(timeout); resolve(null); return;
              }
              if (n > 0) { setTimeout(() => attempt(n - 1), 600); return; }
              settled = true; clearTimeout(timeout); resolve(null); return;
            }
            if (!res?.success) {
              if (n > 0) { setTimeout(() => attempt(n - 1), 1000); return; }
              settled = true; clearTimeout(timeout);
              log('❌ callAI error:', res?.error);
              resolve(null); return;
            }
            settled = true; clearTimeout(timeout);
            log(`✅ callAI ← "${(res.answer || '').slice(0, 80)}"`);
            resolve(res.answer || null);
          });
        } catch (e) {
          clearTimeout(timeout);
          if (!settled) { settled = true; resolve(null); }
        }
      }
      attempt(retries);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 3: SMART EXECUTION
  // Điền form từ mảng answers — giả lập đúng events cho React/Angular/Vue
  // ─────────────────────────────────────────────────────────────────────────

  async function executeAnswers(answers, idMap) {
    for (const ans of answers) {
      const el = idMap[ans.id] || document.querySelector(`[data-sac-id="${ans.id}"]`);
      if (!el || !el.isConnected) continue;

      el.scrollIntoView({ block: 'center' });

      if (ans.action === 'type') {
        if (el.contentEditable === 'true') {
          // Rich text editor — dùng innerText + input event
          el.focus();
          el.innerText = String(ans.value);
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } else {
          setReactFieldValue(el, String(ans.value));
        }
        log(`✅ [type]   "${extractFieldLabel(el).slice(0,50)}" → "${String(ans.value).slice(0,60)}"`);

      } else if (ans.action === 'select') {
        const tag = el.tagName.toLowerCase();

        if (tag === 'select') {
          // Native <select>: gán value thực tế của option
          const opt = [...el.options].find(o => o.value === ans.value);
          if (opt) {
            el.value = opt.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            log(`✅ [select] "${extractFieldLabel(el).slice(0,50)}" → "${opt.text}"`);
          } else {
            log(`⚠️ [select] Không tìm thấy option value="${ans.value}"`);
          }

        } else if (el.type === 'radio') {
          // Radio group: tìm radio có value khớp và click
          const name = el.name;
          const target = name
            ? document.querySelector(`input[type="radio"][name="${CSS.escape(name)}"][value="${CSS.escape(ans.value)}"]`)
            : (el.value === ans.value ? el : null);
          if (target) {
            ['mousedown', 'mouseup', 'click'].forEach(t =>
              target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }))
            );
            log(`✅ [radio]  "${extractFieldLabel(el).slice(0,50)}" → "${ans.value}"`);
          }
        }

      } else if (ans.action === 'check') {
        const desired = Boolean(ans.value);
        if (el.checked !== desired) {
          el.click();
          el.dispatchEvent(new Event('change', { bubbles: true }));
          log(`✅ [check]  "${extractFieldLabel(el).slice(0,50)}" → ${desired}`);
        }

      } else if (ans.action === 'button') {
        // Button toggle groups — tìm button có text khớp và click
        const v = String(ans.value).toLowerCase().trim();
        const parent = el.parentElement;
        const siblings = parent
          ? [...parent.querySelectorAll('button')].filter(b => b.offsetParent !== null)
          : [el];
        const chosen = siblings.find(b => b.textContent.trim().toLowerCase() === v)
          || siblings.find(b => b.textContent.trim().toLowerCase().includes(v));
        if (chosen) {
          chosen.scrollIntoView({ block: 'center' });
          ['mousedown', 'mouseup', 'click'].forEach(t =>
            chosen.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }))
          );
          // Đánh dấu cả group để round sau không detect lại
          siblings.forEach(b => b.setAttribute('data-sac-btn-filled', 'true'));
          log(`✅ [button] "${extractFieldLabel(el).slice(0,50)}" → "${chosen.textContent.trim()}"`);
        }
      }

      // Delay 150-250ms giữa các field — mô phỏng hành vi người dùng thật
      await wait(150 + Math.floor(Math.random() * 100));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // COMBOBOX HANDLER (Custom Select — cần click mở trước)
  // Options chỉ xuất hiện trong DOM sau khi click trigger
  // ─────────────────────────────────────────────────────────────────────────

  function getEmptyCustomSelects() {
    const seen    = new Set();
    const results = [];

    function tryAdd(el) {
      if (seen.has(el) || el.offsetParent === null) return;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
      seen.add(el); results.push(el);
    }

    // Pattern 1: ARIA combobox / haspopup
    for (const el of document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="true"]')) {
      if (el.tagName === 'SELECT' || el.tagName === 'INPUT') continue;
      const wrap = el.closest('[class*="select" i]') || el.parentElement;
      // Mở rộng detection: single-value (React Select), selected-item, aria-activedescendant
      const hasValue = !!(
        wrap?.querySelector('[class*="single-value" i], [class*="singleValue"], [class*="selected-item" i]') ||
        el.getAttribute('aria-activedescendant')
      );
      const innerTxt = (el.textContent || '').trim();
      // Coi là placeholder nếu text khớp pattern hoặc rỗng hoàn toàn
      const isPlaceholder = !innerTxt || /^(select|choose|--|please|none)/i.test(innerTxt);
      if (!hasValue && isPlaceholder) tryAdd(el);
    }

    // Pattern 2: div/button trông như dropdown (có text "Select..." và SVG arrow)
    for (const el of document.querySelectorAll('div[class*="select" i], button[class*="select" i]')) {
      if (seen.has(el)) continue;
      const txt = (el.textContent || '').trim().toLowerCase();
      if (/^(select\.\.\.|select|choose\.\.\.|choose|--)/.test(txt) && el.querySelector('svg, [class*="arrow" i], [class*="chevron" i]'))
        tryAdd(el);
    }

    return results;
  }

  // Mở combobox, thu thập options, đóng lại — trả về metadata để fill sau
  async function preloadComboboxOptions(el) {
    const wrap    = el.closest('[class*="select" i]') || el.parentElement;
    const label   = extractFieldLabel(wrap) || extractFieldLabel(el);
    if (!label || label.length < 2) return null;

    const before  = new Set(document.querySelectorAll('[role="option"], [role="menuitem"], [role="listbox"] li'));
    const trigger = wrap?.querySelector('[class*="control" i]') || el;
    trigger.click();
    await wait(800);

    const listbox = document.querySelector('[role="listbox"]:not([aria-hidden="true"])')
      || document.querySelector('[class*="menu" i]:not([class*="menubar" i])');

    let optionEls = listbox
      ? [...listbox.querySelectorAll('[role="option"], li')].filter(o => o.offsetParent !== null)
      : [...document.querySelectorAll('[role="option"], [role="menuitem"]')]
          .filter(o => o.offsetParent !== null && !before.has(o));

    // Đóng dropdown bằng click outside — KHÔNG dùng Escape vì React Select
    // sẽ xóa luôn giá trị đang được chọn khi nhận Escape lúc menu mở
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await wait(300);

    const options = optionEls
      .map(o => o.textContent.trim())
      .filter(t => t && !/^(select|choose|--|please)/i.test(t));

    if (!options.length) return null;

    return { el, trigger, label, options, optionEls };
  }

  // Sau khi AI trả về answer, mở lại dropdown và click đúng option
  async function executeComboboxAnswer(combo, value) {
    const { el, trigger, label, options, optionEls } = combo;

    trigger.click();
    await wait(800);

    // Tìm option khớp với value AI trả về (exact → fuzzy)
    const v = String(value).toLowerCase().trim();
    let idx = options.findIndex(o => o.toLowerCase() === v);
    if (idx < 0) idx = options.findIndex(o => o.toLowerCase().includes(v) || v.includes(o.toLowerCase()));
    if (idx < 0) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return; }

    // Re-query optionEls vì DOM có thể đã re-render sau khi đóng/mở lại
    const listbox = document.querySelector('[role="listbox"]:not([aria-hidden="true"])')
      || document.querySelector('[class*="menu" i]:not([class*="menubar" i])');
    const freshOpts = listbox
      ? [...listbox.querySelectorAll('[role="option"], li')].filter(o => o.offsetParent !== null)
      : optionEls;

    const chosen = freshOpts[idx];
    if (!chosen) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return; }

    chosen.scrollIntoView({ block: 'nearest' });
    ['mousedown', 'mouseup', 'click'].forEach(t =>
      chosen.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }))
    );
    log(`✅ [combobox] "${label.slice(0,50)}" → "${chosen.textContent.trim()}"`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN AI FILL LOOP — 1 API call duy nhất cho toàn bộ form
  // ─────────────────────────────────────────────────────────────────────────

  async function aiScanAndFill() {
    const stored = await chrome.storage.local.get('_sacAiConfig');
    const cfg    = stored._sacAiConfig;
    if (!cfg?.apiKey || !cfg?.resume || !cfg?.provider) {
      log('AI fill: chưa cấu hình — bỏ qua.'); return;
    }

    for (let round = 0; round < 3; round++) {

      // 1. Preload tất cả combobox options TRƯỚC khi build schema
      const comboMetas = [];
      for (const el of getEmptyCustomSelects()) {
        const meta = await preloadComboboxOptions(el);
        if (meta) comboMetas.push(meta);
        await wait(200);
      }

      // 2. Build schema cho native fields + button groups
      const { idMap, schema } = buildFormSchema();

      // 3. Gộp combobox vào schema với options thật (đã thu thập ở bước 1)
      let comboCounter = schema.length;
      for (const meta of comboMetas) {
        const id = `combo_${String(++comboCounter).padStart(3, '0')}`;
        meta.schemaId = id;
        schema.push({
          id,
          action: 'select',
          label: meta.label,
          options: meta.options.map(t => ({ text: t, value: t }))
        });
      }

      if (schema.length === 0) { log('AI fill: không còn field trống.'); break; }

      log(`── Round ${round + 1}: ${schema.length} field(s) (${comboMetas.length} combobox) → 1 API call`);
      schema.forEach(f =>
        log(`  [${f.action}] "${f.label.slice(0,60)}"${f.options ? ` (${f.options.length} opts)` : ''}`)
      );

      // 4. Gọi AI 1 lần duy nhất cho toàn bộ form
      const answers = await callAISchema(schema);
      if (!answers) {
        log(_quotaExhausted ? '⛔ Hết quota — dừng AI fill.' : 'AI fill: không có response.');
        break;
      }
      log(`AI fill: nhận ${answers.length} answers`);

      // 5. Thực thi native fields
      await executeAnswers(answers, idMap);

      // 6. Thực thi combobox answers (mở lại dropdown và click)
      for (const meta of comboMetas) {
        const ans = answers.find(a => a.id === meta.schemaId);
        if (ans?.value) {
          await executeComboboxAnswer(meta, ans.value);
          await wait(400);
        }
      }

      // 7. Dọn data-sac-id
      document.querySelectorAll('[data-sac-id]').forEach(el => el.removeAttribute('data-sac-id'));

      await waitForDomSettle(5000, 800);
    }

    log('AI fill xong.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DOM SETTLE DETECTOR
  // Chờ DOM không thay đổi trong settleMs liên tiếp (thay cho fixed wait)
  // ─────────────────────────────────────────────────────────────────────────

  function waitForDomSettle(timeoutMs = 20000, settleMs = 1500) {
    return new Promise(resolve => {
      let lastChange = Date.now();
      const observer = new MutationObserver(() => { lastChange = Date.now(); });
      observer.observe(document.body, {
        subtree: true, childList: true,
        attributes: true, attributeFilter: ['value', 'class', 'disabled']
      });
      const timer = setInterval(() => {
        const now = Date.now();
        if (now - lastChange >= settleMs || now - Date.now() + timeoutMs <= 0) {
          clearInterval(timer); observer.disconnect(); resolve();
        }
      }, 200);
      setTimeout(() => { clearInterval(timer); observer.disconnect(); resolve(); }, timeoutMs);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FLOW CHÍNH
  // ─────────────────────────────────────────────────────────────────────────

  // Bước 1: Click nút "Apply" nếu chưa ở form
  const searchRoot = document.querySelector('main') || document.querySelector('article') || document.body;
  const applyBtn   = [...searchRoot.querySelectorAll('button, a')].find(el => {
    if (el.offsetParent === null) return false;
    const txt = (el.textContent || '').trim().toLowerCase();
    return txt === 'apply' || txt === 'apply now' || txt === '1-click apply';
  });
  if (applyBtn) {
    log(`Click Apply: "${applyBtn.textContent.trim()}"`);
    applyBtn.scrollIntoView({ block: 'center' });
    await wait(400);
    ['mousedown', 'mouseup', 'click'].forEach(t =>
      applyBtn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }))
    );
    await wait(3000);
  }

  // Bước 2: Tìm và click #fill-button của Simplify trong shadow root
  async function waitForFillButton(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hosts = document.getElementsByClassName('simplify-jobs-shadow-root');
      for (let i = 0; i < hosts.length; i++) {
        const root = hosts[i].shadowRoot;
        if (!root) continue;
        const btn = root.querySelector('#fill-button')
          || [...root.querySelectorAll('button')].find(b =>
               /autofill this page|autofill/i.test(b.textContent.trim())
             );
        if (btn) { log(`#fill-button tìm thấy tại host[${i}]`); return btn; }
      }
      await wait(400);
    }
    log(`Timeout: không tìm thấy #fill-button sau ${timeoutMs}ms`);
    return null;
  }

  // Kiểm tra nhanh Simplify có trên trang không (shadow root host)
  const hasSimplify = () => document.getElementsByClassName('simplify-jobs-shadow-root').length > 0;

  let fillBtn = null;
  if (hasSimplify()) {
    // Simplify đang có → chờ fill button tối đa 8s
    log('Simplify extension detected — chờ #fill-button...');
    fillBtn = await waitForFillButton(8000);
  } else {
    // Chờ tối đa 3s để Simplify có thể inject sau
    await wait(3000);
    if (hasSimplify()) fillBtn = await waitForFillButton(5000);
  }

  if (fillBtn) {
    fillBtn.scrollIntoView({ block: 'center' });
    await wait(300);
    fillBtn.click();
    log('Clicked fill-button. Chờ Simplify fill xong...');
    await waitForDomSettle(25000, 2500);
    await wait(1500);
    log('Simplify settled. Bắt đầu AI scan...');
  } else {
    log('ℹ️ Không có Simplify — chạy AI fill trực tiếp.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HELPERS: tìm Submit / Next button
  // ─────────────────────────────────────────────────────────────────────────

  function findSubmitBtn() {
    return [...document.querySelectorAll('button, input[type="submit"], input[type="button"]')]
      .find(btn => {
        if (btn.offsetParent === null || btn.disabled) return false;
        const txt = (btn.textContent || btn.value || '').toLowerCase().trim();
        return txt.includes('submit') || txt === 'apply';
      }) || null;
  }

  function findNextBtn() {
    return [...document.querySelectorAll('button, input[type="button"]')]
      .find(btn => {
        if (btn.offsetParent === null || btn.disabled) return false;
        const txt = (btn.textContent || btn.value || '').toLowerCase().trim();
        return /^(next|continue|proceed|save\s*&?\s*continue|tiếp|tiếp theo)/.test(txt);
      }) || null;
  }

  const SUCCESS_URL  = /confirmation|thank.?you|thanks|success|submitted|complete|received|applied/i;
  const SUCCESS_TEXT = /thank you|application submitted|successfully submitted|we.?ve received|your application|application received|you.ve applied|we received your|submission confirmed/i;

  // ─────────────────────────────────────────────────────────────────────────
  // Bước 3 + 4: Fill từng step → Next → Submit (hỗ trợ multi-step form)
  // ─────────────────────────────────────────────────────────────────────────

  let confirmed = false;
  const MAX_STEPS = 8;

  for (let step = 0; step < MAX_STEPS; step++) {
    log(`── Step ${step + 1}/${MAX_STEPS}: AI fill...`);
    await aiScanAndFill();
    await wait(1500);

    if (_quotaExhausted) {
      log('⛔ Hết quota — dừng, giữ tab để review thủ công.');
      await clearMyLock();
      return;
    }

    // Ưu tiên Submit
    const submitBtn = findSubmitBtn();
    if (submitBtn) {
      log(`Submit (step ${step + 1}): "${(submitBtn.textContent || submitBtn.value).trim()}"`);
      submitBtn.scrollIntoView({ block: 'center' });
      await wait(800);
      ['mousedown', 'mouseup', 'click'].forEach(t =>
        submitBtn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }))
      );
      const startUrl = location.href;
      for (let i = 0; i < 30 && !confirmed; i++) {
        await wait(1000);
        if (i === 0 || i === 4) log(`Poll ${i+1}/30 — ${location.href.slice(-60)}`);
        if (location.href !== startUrl && SUCCESS_URL.test(location.href)) { confirmed = true; log('✅ Success URL'); break; }
        if (SUCCESS_TEXT.test(document.body.innerText || ''))              { confirmed = true; log('✅ Success text'); break; }
        if (!submitBtn.isConnected || submitBtn.disabled) {
          await wait(1500);
          if (!submitBtn.isConnected || submitBtn.disabled) { confirmed = true; log('✅ Submit gone/disabled'); break; }
        }
      }
      log(confirmed ? '✅ Submitted!' : '⚠️ Submit chưa confirm sau 30s');
      break;
    }

    // Không có Submit → tìm Next/Continue
    const nextBtn = findNextBtn();
    if (!nextBtn) {
      log(`Step ${step + 1}: Không tìm thấy Next hay Submit — dừng.`);
      break;
    }

    log(`Step ${step + 1}: Click Next → "${nextBtn.textContent.trim()}"`);
    nextBtn.scrollIntoView({ block: 'center' });
    await wait(500);
    ['mousedown', 'mouseup', 'click'].forEach(t =>
      nextBtn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }))
    );
    await waitForDomSettle(15000, 1000);
    await wait(800);
  }

  await clearMyLock();

  if (confirmed) {
    log('✅ Đóng tab.');
    window.close();
  } else {
    log('⚠️ Giữ tab để review thủ công.');
  }
})();
