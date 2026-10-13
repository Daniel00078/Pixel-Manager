/**
 * เพิ่ม/แก้รายการเซลเพจตรงนี้
 * owner: เจ้าของ Repository บน GitHub
 * repo: ชื่อ Repository
 * branch: branch ที่ต้องการแก้ไข
 * path: path ของไฟล์ HTML ภายใน Repository
 *
 * ใส่เฉพาะ Repository ที่คุณมีสิทธิ์แก้ไข
 */
export const SALES_PAGES = [
  {
    id: 'sales-page-01',
    name: 'Sales Page 01',
    description: 'หน้าเซลเพจหลัก',
    owner: 'Daniel00078',
    repo: 'sale-page',
    branch: 'main',
    path: 'index.html',
    currentPixelId: 'ใส่ Pixel ID ปัจจุบันถ้าทราบ',
  },
  {
    id: 'sales-page-02',
    name: 'Sales Page 02',
    description: 'หน้าเซลเพจสำรอง',
    owner: 'YOUR_GITHUB_USERNAME',
    repo: 'YOUR_SALES_PAGE_REPO_2',
    branch: 'main',
    path: 'index.html',
    currentPixelId: 'ใส่ Pixel ID ปัจจุบันถ้าทราบ',
  },
]
