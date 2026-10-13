# Firmware ESP32-S3

Firmware này hợp nhất hai sketch gốc thành một chương trình duy nhất:

| Thiết bị | Slave | UART | Function | Dữ liệu/lệnh |
|---|---:|---|---|---|
| MTS5(LE) | 1 | 9600 8E1 | FC03/FC06 | Đo lường, status 515, OPEN 2305, CLOSE 2304 |
| PM3C-92 | 2 | 9600 8N1 | FC03/FC04 | Ba pha, công suất, PF, tần số, năng lượng |

ESP32 tự đổi parity trước mỗi transaction trên cùng UART2 và MAX485:

- RO → GPIO 38
- `/RE` → GPIO 35
- DE → GPIO 37
- DI → GPIO 36

## Hiệu chỉnh trạng thái MTS5

Sketch gốc chỉ đọc và in raw register 515, chưa có bảng ánh xạ bit. Vì điều khiển web bắt buộc phải xác minh trạng thái sau lệnh, firmware khóa OPEN/CLOSE cho tới khi hoàn thành bước này.

1. Giữ `ENABLE_REMOTE_CONTROL = false`.
2. Mở Serial Monitor ở 115200 baud, newline.
3. Đưa CB về OPEN bằng thao tác tại chỗ, gõ `STATUS`, ghi `RAW` và `HEX`.
4. Lặp lại với CLOSED và TRIPPED trong điều kiện thử nghiệm an toàn.
5. Nếu chỉ một số bit thể hiện trạng thái, đặt `MTS5_STATUS_MASK` theo các bit đó. Điền ba giá trị sau khi mask.
6. Đặt `MTS5_STATUS_MAPPING_CONFIGURED = true`, build lại và kiểm tra lệnh `STATUS` trả đúng `decoded=`.
7. Chỉ sau đó mới đặt `ENABLE_REMOTE_CONTROL = true`.

Ví dụ cấu hình nằm trong `include/device_config.h`. Các giá trị OPEN/CLOSED/TRIPPED mặc định chỉ là placeholder, không được dùng để tác động thiết bị thật.

## Build

Sao chép `include/secrets.example.h` thành `include/secrets.h`, điền cấu hình rồi chạy:

```text
pio run
pio run --target upload
pio device monitor
```

Các lệnh Serial hỗ trợ: `READ`, `STATUS`, `OPEN`, `CLOSE`, `HELP`. OPEN/CLOSE vẫn tuân thủ toàn bộ khóa an toàn trong `device_config.h`.
