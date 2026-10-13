# Smart CB — Cloudflare Workers + D1 + ESP32-S3

Hệ thống giám sát PM3C-92 và điều khiển MTS5 bằng HTTP polling, không dùng WebSocket. Một Cloudflare Worker phục vụ cả dashboard và REST API; D1 lưu tài khoản, thiết bị, telemetry, lệnh và audit log.

## Thành phần

```text
Browser ──HTTPS──> Cloudflare Worker (TypeScript) ──SQL──> D1
                         ▲
                         │ HTTPS mỗi 2 giây
                         │
                     ESP32-S3 ──UART/RS485──> PM3C-92 + MTS5
```

- `src/`: API, xác thực, phân quyền và logic claim lệnh.
- `public/`: dashboard responsive, không cần framework/build frontend.
- `migrations/`: schema D1.
- `firmware/`: PlatformIO firmware cho ESP32-S3.
- `test/`: kiểm thử vòng đời đầy đủ từ setup đến hoàn tất lệnh.
- `docs/openapi.yaml`: hợp đồng REST API.

## Chạy local

Yêu cầu Node.js 20+.

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
# Thay SETUP_TOKEN trong .dev.vars bằng chuỗi ngẫu nhiên dài.
npm run db:migrate:local
npm run dev
```

Mở URL do Wrangler in ra. Lần đầu, dashboard hiển thị biểu mẫu tạo quản trị viên; dùng đúng `SETUP_TOKEN` trong `.dev.vars`.

Kiểm tra mã nguồn:

```powershell
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

> Trên Windows, Cloudflare Vitest có lỗi đã biết nếu đường dẫn dự án chứa ký tự Unicode. Nếu gặp `No such module "cloudflare:test-internal"`, chạy dự án qua một junction/path chỉ có ký tự ASCII; mã ứng dụng không liên quan đến lỗi này.

## Triển khai Cloudflare

1. Đăng nhập và tạo D1:

   ```powershell
   npx wrangler login
   npx wrangler d1 create smart-cb-db
   ```

2. Dán `database_id` trả về vào `wrangler.jsonc`, thay giá trị `REPLACE_WITH_D1_DATABASE_ID`.

3. Tạo secret khởi tạo. Dùng chuỗi ngẫu nhiên tối thiểu 32 byte:

   ```powershell
   npx wrangler secret put SETUP_TOKEN
   ```

4. Áp dụng schema và deploy:

   ```powershell
   npm run db:migrate:remote
   npm run deploy
   ```

5. Truy cập URL `workers.dev`, tạo tài khoản quản trị đầu tiên, sau đó vào **Thiết lập → Đăng ký thiết bị**. Khóa API thiết bị chỉ được trả về một lần.

## Nạp firmware ESP32-S3

1. Cài VS Code + PlatformIO.
2. Sao chép `firmware/include/secrets.example.h` thành `firmware/include/secrets.h`.
3. Điền Wi-Fi, URL Worker, `device id`, khóa API và root CA cho hostname Worker.
4. Register map PM3C-92 và MTS5 đã được tích hợp từ hai sketch thực tế bạn cung cấp. Firmware tự chuyển UART giữa MTS5 `ID 1 / 9600 8E1` và PM3C-92 `ID 2 / 9600 8N1` trước từng giao dịch.
5. Mở Serial Monitor, chạy `STATUS` khi CB ở từng trạng thái OPEN, CLOSED và TRIPPED. Ghi lại giá trị register 515, sau đó điền `MTS5_STATUS_*_VALUE` và bật `MTS5_STATUS_MAPPING_CONFIGURED` trong `device_config.h`.
6. Chỉ sau khi kiểm tra trên bàn thử, đổi `ENABLE_REMOTE_CONTROL` thành `true`. Lệnh thật dùng FC06: OPEN register `2305`, CLOSE register `2304`, giá trị `0x00AA`.
7. Mở thư mục `firmware/` bằng PlatformIO, build và upload.

Firmware cố ý khóa thao tác điều khiển khi chưa có mapping trạng thái register 515, chưa bật remote control hoặc CA chưa được cấu hình. Không dùng `setInsecure()` cho TLS.

## Luồng lệnh và chống thực thi lặp

1. Người dùng `ADMIN`/`OPERATOR` tạo lệnh `OPEN` hoặc `CLOSE`; lệnh mặc định hết hạn sau 30 giây.
2. D1 chỉ cho phép một lệnh `PENDING`/`CLAIMED` trên mỗi thiết bị.
3. ESP32 giữ nguyên `pollId` khi retry. `UPDATE ... RETURNING` claim lệnh nguyên tử, và cùng `pollId` luôn nhận lại cùng lệnh.
4. ESP32 kiểm tra `deviceId`, `pollId`, thời hạn, thời gian NTP, trạng thái CB và liên động điện áp trước khi tác động.
5. Lệnh được ghi vào NVS trước khi gửi Modbus. Nếu reset giữa chừng, firmware chỉ đọc/đối chiếu trạng thái và báo kết quả; không tự tác động lại.
6. API kết quả là idempotent: gửi lại cùng kết quả được chấp nhận nhưng không thực hiện lại lệnh.

## Bảo mật

- Dashboard dùng session ngẫu nhiên được băm trong D1; cookie `HttpOnly`, `SameSite=Strict`, `Secure` trên HTTPS.
- Mật khẩu dùng PBKDF2-SHA-256 với salt riêng và 210.000 vòng.
- Vai trò: `ADMIN`, `OPERATOR`, `VIEWER`.
- Mỗi ESP32 có khóa riêng; D1 chỉ lưu SHA-256 của khóa.
- Mọi câu SQL có dữ liệu đầu vào đều dùng prepared statement.
- Các thao tác quan trọng được lưu vào `audit_logs`.

## Endpoint chính

| Actor | Method | Path | Mục đích |
|---|---|---|---|
| Web | `POST` | `/api/auth/setup` | Tạo admin đầu tiên |
| Web | `POST` | `/api/auth/login` | Đăng nhập |
| Web | `GET` | `/api/dashboard` | Snapshot dashboard |
| Web | `POST` | `/api/devices` | Đăng ký ESP32 |
| Web | `POST` | `/api/commands` | Tạo lệnh OPEN/CLOSE |
| Device | `POST` | `/api/device/telemetry` | Gửi số đo/trạng thái |
| Device | `GET` | `/api/device/commands/next?pollId=...` | Claim lệnh kế tiếp |
| Device | `POST` | `/api/device/commands/result` | Báo kết quả idempotent |

## Lưu ý an toàn bắt buộc

Đây là phần mềm điều khiển thiết bị điện. Register map trong repo chỉ là placeholder, không phải thông số MTS5/PM3C-92. Việc đóng CB phải có liên động phần cứng, bảo vệ quá dòng/chạm đất, nút dừng tại chỗ và quy trình thử nghiệm phù hợp. Không dùng dashboard làm lớp bảo vệ an toàn duy nhất.
