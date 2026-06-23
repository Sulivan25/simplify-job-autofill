Sử dụng
  
  1. Vào https://simplify.jobs/jobs, lọc job theo tiêu chí mong muốn
  2. Đặt "Số lượt cuộn tìm Job" (mỗi lượt cuộn load thêm một batch job mới)
  3. Nhấn Bắt Đầu Auto Apply
  4. Bot tự động:
    - Duyệt từng job card, click Apply
    - Chờ form tab mở, inject AI fill script
    - Dùng Simplify autofill (nếu có), sau đó AI fill phần còn lại
    - Click Next qua từng bước của multi-step form
    - Submit và đóng tab khi confirm thành công
    - Cập nhật trạng thái trong bảng (Đã nộp / Form tab không phản hồi)
  5. Nhấn Dừng Bot để dừng sau job hiện tại

  ---
  Debug
  
  Mở DevTools (F12) trên từng tab để xem log:

  - Listing tab — filter [Simplify Auto-Apply]: theo dõi flow click card, chờ form tab, cập nhật bảng
  - Form tab — filter [SAC Form]: theo dõi từng bước AI fill, số field được fill, trạng thái submit

  Overlay nhỏ góc trên phải của form tab hiển thị tên công ty và vị trí đang được fill.

  ---
  Cấu trúc thư mục

  ├── manifest.json      # Cấu hình extension, permissions
  ├── background.js      # Service worker: Gemini API, key rotation, tab lifecycle
  ├── content.js         # Listing tab: UI panel, auto-apply loop, semaphore lock
  ├── formAutofill.js    # Form tab: schema build, AI fill, multi-step, submit
  ├── styles.css         # Giao diện panel
  └── icon.png

  ---
  Lưu ý
  
  - Extension được phát triển cho mục đích cá nhân. Vui lòng tuân thủ điều khoản sử dụng của
  Simplify.jobs.
  - Một số form ATS (Workday, iCIMS) có cấu trúc phức tạp, có thể cần review thủ công.
  - Nếu form tab báo "Giữ tab để review thủ công", kiểm tra xem có field nào bị validation error
  không.
