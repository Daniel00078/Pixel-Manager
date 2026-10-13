# Pixel Control — React + Express + GitHub App

หน้าแอดมินธีมดำเขียวสำหรับจัดการ Facebook Pixel หลาย ID ในหลาย GitHub repositories โดยอ่าน ID เดิมจาก HTML แยกช่อง และ Commit ให้ `fbq init` กับ `noscript` ตรงกัน

## สำคัญ
- ไม่มีช่อง GitHub Token ในหน้าเว็บ
- ใช้บัญชีผู้ใช้ 5 บัญชี กำหนดใน Environment Variables ฝั่งเซิร์ฟเวอร์ (ไม่ฝังรหัสผ่านใน React)
- ต้องมี Backend Node/Express เพื่อเก็บ session และใช้ GitHub App credentials อย่างปลอดภัย จึงไม่ใช่ static GitHub Pages อย่างเดียว
- ห้ามเผยแพร่ไฟล์ `.env` หรือ private key

## 1. ติดตั้ง
ติดตั้ง Node.js LTS แล้วรันในโฟลเดอร์โปรเจกต์:
```bash
npm install
cp .env.example .env
```
Windows PowerShell ใช้ `Copy-Item .env.example .env` แทน `cp` ได้

## 2. ตั้งค่าผู้ใช้ 5 คน
แก้ `.env` และตั้ง `USER_1_USERNAME` / `USER_1_PASSWORD` ถึง `USER_5_USERNAME` / `USER_5_PASSWORD` ให้ครบทั้ง 5 คน ใช้รหัสผ่านที่เดายากและไม่ซ้ำกับบริการอื่น

## 3. ตั้งค่า GitHub App
สร้าง GitHub App ใน GitHub Developer Settings และให้ Repository permissions: **Contents: Read and write** จากนั้นติดตั้ง App ให้เฉพาะ repositories ของเซลเพจ คัดลอก App ID, Private Key และ Installation ID ลง `.env` พร้อมตั้ง `SESSION_SECRET` เป็นค่าสุ่มยาว

## 4. ตั้งค่า repositories
แก้ `src/config.js` โดยกำหนด `owner`, `repo`, `branch` และ `path` ของทุกเซลเพจที่ต้องการจัดการ ตัวอย่างแรกชี้ไปที่ `Daniel00078/sale-page`

## 5. รันในเครื่องเพื่อพัฒนา
เปิด Terminal แรก:
```bash
npm run server
```
เปิด Terminal ที่สอง:
```bash
npm run dev
```
เปิด URL ที่ Vite แสดง (โดยปกติ `http://localhost:5173`) โดย API จะ proxy ไปยังเซิร์ฟเวอร์พอร์ต 3001

## 6. Build และรันแบบ production
```bash
npm run build
npm run server
```
เปิด `http://localhost:3001`

สำหรับใช้งานออนไลน์ ให้โฮสต์แอป Node.js ทั้งชุดบนบริการที่รองรับ Node.js และตั้ง environment variables ที่นั่น ไม่สามารถใช้ GitHub Pages เพียงอย่างเดียวเพื่อซ่อน GitHub App private key และให้ Commit อย่างปลอดภัยได้

## ข้อจำกัดของการโฮสต์
หากต้องการเผยแพร่ให้ทีมเข้าจากอินเทอร์เน็ต ต้องโฮสต์ Node backend บนบริการที่รองรับ Node.js และตั้ง environment variables ที่นั่น ส่วน React สามารถโฮสต์แยกได้ แต่ต้องตั้ง API URL/proxy ให้ถูกต้อง
