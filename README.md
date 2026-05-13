# Simplify Job Crawler Chrome Extension

Một Chrome Extension chuyên dụng giúp tự động thu thập dữ liệu việc làm từ trang [Simplify.jobs](https://simplify.jobs/) bằng cơ chế cuộn thông minh và hỗ trợ xuất dữ liệu đa nền tảng.

## 🧹 Tính năng nổi bật

* **Tự động cuộn (Infinite Scroll):** Tự động cuộn trang để kích hoạt tải thêm công việc mới từ API của Simplify.
* **Giao diện trực quan:** Bảng điều khiển (Panel) hiển thị ngay trên trang web giúp theo dõi trạng thái thu thập thời gian thực.
* **Dữ liệu chi tiết:** Thu thập đầy đủ các trường thông tin: Tên công ty, Tiêu đề công việc, Mức lương ( Salary), Địa điểm (Location) và Liên kết ứng tuyển trực tiếp.
* **Đồng bộ Google Sheets:** Tự động gửi dữ liệu về Google Sheets thông qua Google Apps Script ngay sau khi hoàn tất.
* **Xuất file CSV:** Hỗ trợ tải file CSV cục bộ để lưu trữ và xử lý offline.
* **Chống trùng lặp:** Cơ chế kiểm tra dựa trên Title và Company để đảm bảo không lưu trùng dữ liệu khi cuộn nhiều lần.

---

## 🔧 Cài đặt nhanh

1. **Tải mã nguồn:** Tải toàn bộ source code về máy tính của bạn.
2. **Nạp vào Chrome:**
* Mở trình duyệt và truy cập `chrome://extensions/`.
* Bật chế độ **Developer Mode** (Chế độ dành cho nhà phát triển).
* Chọn **Load unpacked** (Tải tiện ích đã giải nén) và trỏ đến thư mục chứa project.


3. **Cấu hình Apps Script:** Dán URL Web App của bạn vào hằng số `url` trong file `content.js` để tính năng lưu vào Sheets hoạt động.

---

## 🚀 Cách sử dụng

1. Truy cập vào mục [Simplify Jobs](https://simplify.jobs/jobs) và thực hiện tìm kiếm công việc.
2. Bảng điều khiển **Simplify Crawler** sẽ tự động xuất hiện ở góc dưới bên phải màn hình.
3. **Thiết lập:** Nhập "Số lần cuộn tối đa" (mỗi lần cuộn tương ứng với việc load thêm một lượng job mới).
4. **Bắt đầu:** Nhấn **"Bắt đầu thu thập"**. Extension sẽ tự động thực hiện việc quét dữ liệu và cuộn trang liên tục.
5. **Kết thúc:**
* Quá trình sẽ dừng khi đạt giới hạn lần cuộn hoặc hết dữ liệu trên trang.
* Bạn có thể nhấn **"Dừng & Xuất File"** bất cứ lúc nào để kết thúc sớm.


6. **Xử lý dữ liệu:** Sau khi hoàn tất, file CSV sẽ tự động được tải về và dữ liệu sẽ được đẩy lên Google Sheets đã cấu hình.

---

## 📂 Cấu trúc dữ liệu CSV/Sheets

Dữ liệu thu thập được sắp xếp theo định dạng:

| Company | Job Title | Salary | Location | Link |
| --- | --- | --- | --- | --- |
| Tên công ty | Tên vị trí tuyển dụng | Mức lương (nếu có) | Địa điểm làm việc | Link ứng tuyển |

---

## 📃 Cấu trúc thư mục

```text
.
├── manifest.json   # Cấu hình quyền và tên miền simplify.jobs
├── background.js   # Xử lý download file và fetch dữ liệu ngầm
├── content.js      # Logic bóc tách DOM và quản lý UI Panel
├── styles.css      # Định dạng giao diện cho bảng điều khiển
└── icon.png        # Biểu tượng của extension

```

---

## ⚠️ Lưu ý bảo mật

* Extension này được phát triển cho mục đích học tập và nghiên cứu cá nhân (Software Engineering student).
* Vui lòng tuân thủ điều khoản sử dụng của Simplify.jobs khi thực hiện thu thập dữ liệu tự động.
