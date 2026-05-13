// background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "saveToCSV" && message.url) {
    const filename = message.filename || "simplify_jobs.csv"; // dùng tên gửi từ content.js nếu có
    chrome.downloads.download({
      url: message.url,
      filename: filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("Lỗi khi tải file:", chrome.runtime.lastError);
      } else {
        console.log("Đã tải file với ID:", downloadId);
      }
    });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getSheetId") {
    
    (async () => {
      try {
        const res = await fetch(request.url, {
          method: "GET",
        });

        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }

        const text = await res.text();

        try {
          const json = JSON.parse(text);
          sendResponse({ success: true, data: json });
        } catch (e) {
          sendResponse({
            success: false,
            error: "Invalid JSON from server",
            raw: text
          });
        }

      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();

    return true; 
  }
});


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "saveToSheets") {
    
    (async () => {
      try {
        const res = await fetch(request.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          mode: "no-cors",
          body: JSON.stringify(request.payload)
        });

        const text = await res.text();

        sendResponse({ success: true, data: text });

      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();

    return true; 
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchJobHTML") {
    fetch(request.url)
      .then(response => response.text())
      .then(html => sendResponse({ success: true, html }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Giữ kết nối để phản hồi bất đồng bộ
  }
});