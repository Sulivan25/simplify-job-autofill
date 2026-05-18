// content.js - Tối ưu cho Simplify.jobs dựa trên khung logic Indeed
let isCrawling = false;
let allJobs = [];
let maxPages = 1; // Ở Simplify, 1 "trang" tương ứng với 1 lần cuộn (load thêm job)
let hasExported = false;

const url = "https://script.google.com/macros/s/AKfycbwZyM19-hv2Z9Fz1z4lgnaOftjC4mDsCQrsD9IxTI3ChnjUBmoReELMOhQ8dIqsOHiY/exec";
let existingKeys = new Set();

// --- HELPERS ---
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function randomDelay(min = 1200, max = 3500) {
    return new Promise(resolve => setTimeout(resolve, min + Math.random() * (max - min)));
}
function log(...args) { console.log("[Simplify Crawler]", ...args); }

// --- GOOGLE SHEETS LOGIC ---
async function sendToGoogleSheets(jobs) {
    const sheetName = "Simplify_Crawl_" + new Date().toLocaleDateString().replace(/\//g, '-');
    const payload = { sheetName, jobs };

    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: "saveToSheets", url, payload }, response => {
            if (response && response.success) resolve(response.data);
            else reject(new Error(response?.error || "Unknown error"));
        });
    });
}

// --- UI PANEL ---
function createPanel() {
    if (document.querySelector("#indeed-crawler-panel")) return;

    const panel = document.createElement("div");
    panel.id = "indeed-crawler-panel"; // Giữ ID cũ để khớp với styles.css của bạn
    panel.innerHTML = `
    <div id="indeed-crawler-controls">
      <button id="indeed-start-btn">Bắt Đầu Thu Thập</button>
      <button id="indeed-stop-btn">Tạm Dừng & Xuất File</button>
      <button id="indeed-reset-btn">Xóa Dữ Liệu</button>
      <label style="margin-left: 10px;">
        Số lần cuộn tối đa:
        <input type="number" id="max-pages-input" value="${maxPages}" min="1" style="width: 50px;"/>
      </label>
    </div>
    <div id="indeed-crawler-status">Sẵn sàng quét Simplify.jobs</div>
    <div id="indeed-crawler-table-wrapper">
      <table id="indeed-crawler-table">
        <thead>
          <tr>
            <th>Company</th><th>Job Title</th><th>Link</th><th>Salary</th><th>Posted Date</th><th>Location</th><th>Scroll</th><th>Keyword</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  `;
    document.body.appendChild(panel);

    document.getElementById("indeed-start-btn").onclick = () => {
        const currentSearch = new URLSearchParams(window.location.search).get("search") || "General";
        currentKeyword = currentSearch;
        startCrawl();
    };

    document.getElementById("indeed-stop-btn").onclick = async () => {
        isCrawling = false;
        chrome.storage.local.set({ isCrawling: false });
        updateStatus("Đã dừng và đang xử lý dữ liệu...");
        exportCSV();
        await sendToGoogleSheets(allJobs);
    };

    document.getElementById("indeed-reset-btn").onclick = () => {
        chrome.storage.local.clear();
        allJobs = [];
        existingKeys.clear();
        isCrawling = false;
        hasExported = false;
        document.querySelector("#indeed-crawler-table tbody").innerHTML = "";
        updateStatus("Đã xóa dữ liệu.");
        document.getElementById("indeed-start-btn").disabled = false;
    };
}

function updateStatus(text) {
    document.getElementById("indeed-crawler-status").textContent = text;
    log(text);
}

function appendToTable(job) {
    const tbody = document.querySelector("#indeed-crawler-table tbody");
    const row = document.createElement("tr");
    row.innerHTML = `
    <td>${job.company}</td>
    <td>${job.title}</td>
    <td><a href="${job.link}" target="_blank">Link</a></td>
    <td>${job.salary}</td>
    <td>${job.postedDate}
    <td>${job.location}</td>
    <td>${job.page}</td>
    <td>${job.keyword}</td>
  `;
    tbody.appendChild(row);
    tbody.scrollTop = tbody.scrollHeight;
}

// --- CRAWL LOGIC CHO SIMPLIFY (INFINITE SCROLL) ---
async function startCrawl() {
    if (isCrawling) return;

    const inputVal = document.getElementById("max-pages-input").value;
    maxPages = parseInt(inputVal) || 1;

    isCrawling = true;
    chrome.storage.local.set({ isCrawling, maxPages });
    document.getElementById("indeed-start-btn").disabled = true;
    updateStatus("Bắt đầu cuộn trang và quét dữ liệu...");
    await crawlLoop();
}

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

async function crawlLoop() {
    let currentScroll = 0;
    let lastHeight = 0;

    while (isCrawling && currentScroll < maxPages) {
        updateStatus(`Đang quét dữ liệu lần cuộn thứ ${currentScroll + 1}...`);

        await scrapeCurrentJobs(currentScroll + 1);

        const container = getJobListContainer();
        if (!container) {
            log("Không tìm thấy job list container, dừng lại.");
            break;
        }

        await wheelScroll(container, 22);
        await wait(4000); // Đợi Simplify gọi API và render card mới

        const newHeight = container.scrollHeight;
        if (newHeight === lastHeight) {
            log("Đã chạm đáy — thử kích lại.");
            container.scrollTop -= 300;
            await wait(1000);
            await wheelScroll(container, 22);
            await wait(10000);
            container.scrollTop = container.scrollHeight;
            await wait(10000);
            if (container.scrollHeight === lastHeight) break;
            await scrapeCurrentJobs(currentScroll + 1); // Có job mới sau retry → quét lại
        }
        lastHeight = container.scrollHeight;
        currentScroll++;
    }
    finishCrawl("Hoàn thành quét dữ liệu.");
}

async function getShareLink(urlBefore) {
    // Ưu tiên 1: URL browser thay đổi sau khi click card (SPA navigation)
    if (window.location.href !== urlBefore) {
        return window.location.href;
    }

    // Ưu tiên 2: Click nút share và đọc clipboard
    const shareBtn =
        document.querySelector('button[aria-label*="share" i]') ||
        document.querySelector('button[aria-label*="copy link" i]') ||
        document.querySelector('button[title*="share" i]') ||
        document.querySelector('[data-testid*="share"]');

    if (shareBtn) {
        shareBtn.click();
        await wait(600);
        try {
            const clipText = await navigator.clipboard.readText();
            if (clipText && clipText.startsWith('http')) return clipText.trim();
        } catch (e) {
            log("Không đọc được clipboard:", e.message);
        }
    }

    return window.location.href;
}

    /**
     * Hàm tìm ngày đăng dựa trên class cụ thể đã xác định
     * @param {Element} card - Thẻ job card hiện tại
     * @returns {string} - Ngày đăng hoặc "N/A"
     */
    async function getPostedDate() {
    const detailPanel = document.querySelector('div.flex.flex-col.gap-4.lg\\:w-1\\/2.xl\\:w-2\\/5');
    if (!detailPanel) return "N/A";

    // 1. Tìm phần tử trigger (thẻ span chứa chữ "Confirmed live...")
    const triggerSpan = detailPanel.querySelector('span.cursor-help');

    if (triggerSpan) {
        // 2. Mô phỏng di chuột vào để kích hoạt tooltip
        triggerSpan.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        triggerSpan.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

        // 3. Đợi một chút để Radix UI đổi data-state và hiển thị tooltip
        await wait(600); 

        // 4. Tìm Tooltip Content - Thường Radix sẽ render ở cuối body hoặc gần đó
        // Chúng ta tìm theo nội dung "Posted on" như trong hình bạn gửi
        const portalNodes = document.querySelectorAll('[role="tooltip"], [data-side]');
        for (let node of portalNodes) {
            if (node.innerText.includes("Posted on")) {
                const dateMatch = node.innerText.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
                const result = dateMatch ? dateMatch[0] : "N/A";
                
                // Di chuột ra để dọn dẹp trạng thái UI (optional)
                triggerSpan.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
                
                return result;
            }
        }
    }

    // Trường hợp dự phòng: Nếu ngày hiện sẵn không cần hover
    const pEl = detailPanel.querySelector('div.pb-2 p.mt-1.text-left.text-sm.text-gray-500');
    if (pEl && pEl.innerText.trim() !== "") {
        const dateMatch = pEl.innerText.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
        if (dateMatch) return dateMatch[0];
    }

    return "N/A";
}

    function forceOpenDateTooltip() {
    // Tìm phần tử trigger có chứa data-state trong detail panel
    const element = document.querySelector('div[aria-describedby*="radix"]');
        if (element && element.getAttribute('data-state') === 'closed') {
            element.setAttribute('data-state', 'open');
            
            // Dùng MutationObserver để giữ trạng thái luôn mở trong lúc cào
            const observer = new MutationObserver(() => {
                if (element.getAttribute('data-state') == 'closed') {
                    element.setAttribute('data-state', 'delayed-open');
                }
            });
            observer.observe(element, { attributes: true });
            return observer;
        }
        return null;
    }

async function scrapeCurrentJobs(scrollNumber) {
    if (scrollNumber === 1) await wait(800); // Đợi DOM ổn định ở lần đầu

    const jobCards = document.querySelectorAll('div.group.mx-auto.flex.size-full.flex-col');
    const keyword = document.title.split('|')[0].trim();

    for (let card of jobCards) {
        if (!isCrawling) break;

        try {
            // Thử nhiều selector để xử lý cả trạng thái active/inactive của card
            const titleEl = card.querySelector('h3') || card.querySelector('h2') || card.querySelector('h4');
            const companyEl = card.querySelector('span.text-left') ||
                              card.querySelector('[class*="company"]') ||
                              card.querySelector('div.text-secondary-300 span');

            const jobTitle = titleEl ? titleEl.innerText.trim() : "N/A";
            const jobCompany = companyEl ? companyEl.innerText.trim() : "N/A";
            
            await wait(2000)
            

            // Bỏ qua nếu cả hai đều N/A (element không phải job card thực sự)
            if (jobTitle === "N/A" && jobCompany === "N/A") continue;

            const jobKey = `${jobTitle}-${jobCompany}`;

            if (existingKeys.has(jobKey)) continue;

            // Xử lý Lương và Địa điểm từ các badge
            let salary = "N/A";
            let location = "N/A";
            const badges = card.querySelectorAll('div.bg-gray-50');
            badges.forEach(badge => {
                const text = badge.innerText.trim();
                if (text.includes('$')) salary = text;
                else if (badge.querySelector('p.text-left')) location = text;
            });

            // Click card để mở detail panel bên phải
            const urlBefore = window.location.href;
            
            card.click();
            await wait(2000); // Đợi detail panel load

            // --- LOGIC MỚI CHO NGÀY BỊ GIẤU ---
            // 1. Ép trạng thái Tooltip sang 'open' bằng MutationObserver
            const observer = forceOpenDateTooltip();
            
            // 2. Đợi một chút để Portal/Tooltip kịp render nội dung vào DOM
            await wait(1000); 

            // 3. Lấy ngày đăng (Hàm getPostedDate lúc này sẽ tìm thấy data-state="open")
            const postedDate = await getPostedDate();

            // 4. Dọn dẹp: Ngắt observer để trả lại trạng thái tự nhiên cho UI
            if (observer) observer.disconnect();
            
            const jobLink = await getShareLink(urlBefore);

            const job = {
                key: jobKey,
                title: jobTitle,
                company: jobCompany,
                location,
                salary,
                postedDate: postedDate,
                link: jobLink,
                page: scrollNumber,
                keyword
            };

            allJobs.push(job);
            existingKeys.add(jobKey);
            appendToTable(job);
            chrome.storage.local.set({ allJobs });

            await randomDelay(1000, 1500);
        } catch (e) {
            console.error("Lỗi thẻ job:", e);
        }
    }
}

async function finishCrawl(reason) {
    updateStatus(`${reason} Đang xuất file...`);
    if (!hasExported) {
        exportCSV();
        hasExported = true;
    }
    try {
        await sendToGoogleSheets(allJobs);
        updateStatus(`Xong! Đã lưu ${allJobs.length} jobs vào Sheets & CSV.`);
    } catch (err) {
        updateStatus("Lỗi gửi Sheets nhưng CSV đã tải.");
    }
    isCrawling = false;
    document.getElementById("indeed-start-btn").disabled = false;
    chrome.storage.local.set({ isCrawling: false });
}

function exportCSV() {
    const headers = ["Company", "Title", "Link", "Salary", "Posted_Date", "Location", "Scroll_Step"];
    const rows = allJobs.map(j => 
        [j.company, j.title, j.link, j.salary, j.postedDate, j.location, j.page].map(v => `"${(v||"").toString().replace(/"/g, '""')}"`).join(",")
    );
    const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({ action: "saveToCSV", url, filename: `Simplify_Jobs_${allJobs.length}.csv` });
}

// Khởi tạo
createPanel();

// Khôi phục dữ liệu cũ nếu có
chrome.storage.local.get(["allJobs", "maxPages"], data => {
    if (data.allJobs) {
        allJobs = data.allJobs;
        allJobs.forEach(j => {
            existingKeys.add(j.key);
            appendToTable(j);
        });
    }
    if (data.maxPages) {
        maxPages = data.maxPages;
        document.getElementById("max-pages-input").value = maxPages;
    }
});