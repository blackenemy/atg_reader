# Against the Gods Reader — อสูรพลิกฟ้า

เว็บอ่านนิยาย "Against the Gods อสูรพลิกฟ้า" (1–1900 บท) จาก PDF
แบบ on-demand ไม่ต้อง extract ทั้งหมดล่วงหน้า

---

## ความต้องการ

- Python 3.9+
- ไฟล์ PDF: `Against the Gods อสูรพลิกฟ้า1-1900.pdf` วางไว้ที่ `/Users/prot/Documents/`

---

## วิธีติดตั้ง (ครั้งแรก)

```bash
pip3 install flask pypdf
```

---

## วิธีรัน

```bash
cd /Users/prot/Documents
PORT=7777 python3 atg_reader/app.py
```

แล้วเปิดเบราว์เซอร์ที่ **http://localhost:7777**

---

## ฟีเจอร์

| ฟีเจอร์ | รายละเอียด |
|---|---|
| อ่านออนไลน์ | โหลดทีละบท ใช้เวลา ~0.5 วินาที |
| สารบัญ | 1,900 บท พร้อม index ครบ |
| Dark / Light theme | กดปุ่ม ☀️ / 🌙 |
| ปรับขนาดตัวอักษร | กด A- / A+ |
| กระโดดไปบทที่ต้องการ | พิมพ์เลขแล้วกด "ไป" |
| Keyboard shortcut | ← / → หรือ , / . เปลี่ยนบท |
| บันทึกที่อ่านค้าง | เก็บไว้ใน `cache/bookmark.json` — เปิดใหม่จะอ่านต่อจากตรงนั้นเลย |
| Cache บท | บทที่เคยโหลดแล้วเก็บใน `cache/chapters/` ไม่ต้อง extract ซ้ำ |

---

## โครงสร้างไฟล์

```
atg_reader/
├── app.py                  # Flask server (entry point)
├── README.md               # ไฟล์นี้
├── templates/
│   └── index.html          # หน้าเว็บ
├── static/
│   ├── style.css           # ธีม dark/light
│   └── script.js           # JavaScript ฝั่ง client
└── cache/
    ├── index.json          # แมปบทที่ → หน้า PDF (สร้างอัตโนมัติ)
    ├── bookmark.json       # ที่อ่านค้างล่าสุด (สร้างอัตโนมัติ)
    └── chapters/           # cache เนื้อหาแต่ละบท (สร้างอัตโนมัติ)
```

---

## หมายเหตุ

- ตอน run ครั้งแรก server จะสแกน PDF ทั้งหมด (~5 นาที) ใน background
  ระหว่างนั้นยังสามารถอ่านบทต้นๆ ได้ตามปกติ
- ถ้าต้องการเปลี่ยน port แก้ `PORT=7777` เป็นเลขที่ต้องการ
- ถ้าต้องการล้าง cache ลบโฟลเดอร์ `cache/` แล้วรันใหม่
