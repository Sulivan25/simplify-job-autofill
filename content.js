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
            <th>Company</th><th>Job Title</th><th>Link</th><th>Salary</th><th>Location</th><th>Scroll</th><th>Keyword</th>
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
    isCrawling = true;
    chrome.storage.local.set({ isCrawling, maxPages });
    document.getElementById("indeed-start-btn").disabled = true;
    updateStatus("Bắt đầu cuộn trang và quét dữ liệu...");
    await crawlLoop();
}

async function crawlLoop() {
    let currentScroll = 0;
    let lastHeight = 0;

    while (isCrawling && currentScroll < maxPages) {
        updateStatus(`Đang quét dữ liệu lần cuộn thứ ${currentScroll + 1}...`);
        
        // Quét các job hiện có trên màn hình
        await scrapeCurrentJobs(currentScroll + 1);

        // Cuộn xuống để load thêm
        window.scrollTo(0, document.body.scrollHeight);
        await wait(3000); // Đợi Simplify load API

        let newHeight = document.body.scrollHeight;
        if (newHeight === lastHeight) {
            log("Đã chạm đáy trang.");
            break;
        }
        lastHeight = newHeight;
        currentScroll++;
    }
    finishCrawl("Hoàn thành quét dữ liệu.");
}

async function scrapeCurrentJobs(scrollNumber) {
    const jobCards = document.querySelectorAll('div.group.mx-auto.flex.size-full.flex-col');
    const keyword = document.title.split('|')[0].trim();

    for (let card of jobCards) {
        if (!isCrawling) break;

        try {
            const titleEl = card.querySelector('div.mt-2 h3');
            const companyEl = card.querySelector('div.text-secondary-300 span.text-left');
            const linkEl = card.closest('a');
            
            const jobTitle = titleEl ? titleEl.innerText.trim() : "N/A";
            const jobCompany = companyEl ? companyEl.innerText.trim() : "N/A";
            const jobKey = `${jobTitle}-${jobCompany}`; // Tạo key duy nhất vì Simplify không có jk-id lộ thiên

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

            const job = {
                key: jobKey,
                title: jobTitle,
                company: jobCompany,
                location: location,
                salary: salary,
                link: linkEl ? linkEl.href : window.location.href,
                page: scrollNumber,
                keyword: keyword
            };

            allJobs.push(job);
            existingKeys.add(jobKey);
            appendToTable(job);
            chrome.storage.local.set({ allJobs });
            
            await wait(100); // Tránh treo UI
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
    const headers = ["Company", "Title", "Link", "Salary", "Location", "Scroll_Step"];
    const rows = allJobs.map(j => 
        [j.company, j.title, j.link, j.salary, j.location, j.page].map(v => `"${(v||"").toString().replace(/"/g, '""')}"`).join(",")
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