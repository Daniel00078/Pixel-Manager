
import 'dotenv/config'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import session from 'express-session'
import helmet from 'helmet'
import { App as GitHubApp } from '@octokit/app'
import { SALES_PAGES } from './src/config.js'

const app = express()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT || 3001)
const production = process.env.NODE_ENV === 'production'

app.set('trust proxy', 1)
app.use(helmet({ contentSecurityPolicy: false }))
app.use(express.json({ limit: '1mb' }))

app.use(session({
  name: 'pixel_manager_session',
  secret: process.env.SESSION_SECRET || 'development-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: production,
    maxAge: 8 * 60 * 60 * 1000,
  },
}))

// ตรวจสอบ Environment Variables
const configured = () => Boolean(
  process.env.GITHUB_APP_ID &&
  process.env.GITHUB_APP_PRIVATE_KEY &&
  process.env.GITHUB_INSTALLATION_ID &&
  process.env.SESSION_SECRET &&
  Array.from({ length: 5 }, (_, i) => i + 1).every(
    (i) =>
      process.env[`USER_${i}_USERNAME`] &&
      process.env[`USER_${i}_PASSWORD`]
  )
)

// ผู้ใช้งาน 5 บัญชี
const users = () =>
  Array.from({ length: 5 }, (_, i) => ({
    username: process.env[`USER_${i + 1}_USERNAME`],
    password: process.env[`USER_${i + 1}_PASSWORD`],
  })).filter((u) => u.username && u.password)

// ตรวจสอบว่าเป็นแอดมินหรือไม่
const isAdmin = (req) => Boolean(
  req.session?.authenticated &&
  req.session?.username &&
  process.env.ADMIN_USERNAME &&
  req.session.username === process.env.ADMIN_USERNAME
)

// สร้าง GitHub App
const githubApp = () => {
  const appId = process.env.GITHUB_APP_ID
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY
    ?.replace(/\\n/g, '\n')
  const installationId = Number(process.env.GITHUB_INSTALLATION_ID)

  if (
    !appId ||
    !privateKey ||
    !Number.isSafeInteger(installationId) ||
    installationId <= 0
  ) {
    throw new Error(
      'การตั้งค่า GitHub App ไม่ครบ กรุณาตรวจ GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY และ GITHUB_INSTALLATION_ID'
    )
  }

  return new GitHubApp({ appId, privateKey })
}

const getGitHubClient = async () => {
  const installationId = Number(process.env.GITHUB_INSTALLATION_ID)

  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error('GITHUB_INSTALLATION_ID ไม่ถูกต้อง')
  }

  return githubApp().getInstallationOctokit(installationId)
}

// ค้นหาเซลเพจที่ตั้งค่า Repository ถูกต้อง
const pageById = (id) =>
  SALES_PAGES.find(
    (page) =>
      page.id === id &&
      page.owner &&
      page.repo &&
      page.branch &&
      page.path &&
      !page.owner.startsWith('YOUR_') &&
      !page.repo.startsWith('YOUR_')
  )

// ตรวจสอบการเข้าสู่ระบบ
const requireAuth = (req, res, next) => {
  if (!req.session?.authenticated) {
    return res.status(401).json({
      error: 'กรุณาเข้าสู่ระบบก่อนใช้งาน',
    })
  }

  next()
}

// ตรวจสอบสิทธิ์ของเซลเพจ
const requirePageAccess = (req, res, next) => {
  const page = pageById(req.params.id)

  if (!page) {
    return res.status(404).json({
      error: 'ไม่พบเซลเพจ หรือยังไม่ได้ตั้งค่า Repository ใน src/config.js',
    })
  }

  // หน้า adminOnly ต้องเป็นแอดมินเท่านั้น
  if (page.adminOnly && !isAdmin(req)) {
    return res.status(403).json({
      error: 'เซลเพจนี้อนุญาตให้แอดมินใช้งานเท่านั้น',
    })
  }

  next()
}

// แปลง HTML เป็นรายการ Pixel ID
function parseIds(html) {
  const init = [
    ...html.matchAll(
      /fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d+)['"]\s*\)/gi
    ),
  ].map((m) => m[1])

  const noscript = [
    ...html.matchAll(
      /<img\b(?=[^>]*\bsrc\s*=\s*["'][^"']*facebook\.com\/tr\?[^"']*["'])(?=[^>]*\bnoscript=1)[^>]*>/gi
    ),
  ]
    .map((m) => m[0].match(/[?&]id=(\d+)/i)?.[1])
    .filter(Boolean)

  const ids = [...new Set([...init, ...noscript])]

  if (!ids.length) {
    throw new Error(
      'ไม่พบ Facebook Pixel ในไฟล์ HTML กรุณาตรวจรูปแบบ fbq init หรือ noscript'
    )
  }

  return ids
}

// แทนที่ Pixel ID โดยรักษาโค้ด HTML ส่วนอื่นไว้
function rewritePixelIds(html, ids) {
  const initRegex =
    /fbq\s*\(\s*['"]init['"]\s*,\s*['"]\d+['"]\s*\)\s*;?/gi

  const imgRegex =
    /<img\b(?=[^>]*\bsrc\s*=\s*["'][^"']*facebook\.com\/tr\?[^"']*["'])(?=[^>]*\bnoscript=1)[^>]*>/gi

  let initCount = 0

  let result = html.replace(initRegex, () => {
    initCount++

    // ใส่รายการใหม่ ณ ตำแหน่งแรก ลบ init เก่าที่เหลือ
    if (initCount === 1) {
      return ids.map((id) => `fbq('init', '${id}');`).join('\n    ')
    }

    return ''
  })

  if (initCount === 0) {
    throw new Error('ไม่พบ fbq init ในไฟล์ HTML จึงหยุดการบันทึก')
  }

  // อัปเดต noscript หากมีอยู่ในไฟล์
  let imgCount = 0

  result = result.replace(imgRegex, (img) => {
    imgCount++

    if (imgCount > 1) {
      return ''
    }

    const updatedImages = ids.map((id) => {
      if (!/[?&]id=\d+/i.test(img)) {
        throw new Error('ไม่พบ Pixel ID ใน URL ของ noscript')
      }

      return img.replace(
        /([?&]id=)\d+/i,
        (_, prefix) => `${prefix}${id}`
      )
    })

    return updatedImages.join('\n')
  })

  return result
}

// สถานะระบบ
app.get('/api/status', (req, res) => {
  res.json({
    configured: configured(),
    authenticated: Boolean(req.session?.authenticated),
    username: req.session?.username || null,
    isAdmin: isAdmin(req),
  })
})

// เข้าสู่ระบบ
app.post('/api/login', (req, res) => {
  if (!configured()) {
    return res.status(503).json({
      error: 'เซิร์ฟเวอร์ยังตั้งค่าไม่ครบ กรุณาตรวจ Environment Variables บน Render',
    })
  }

  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')

  const user = users().find(
    (u) => u.username === username && u.password === password
  )

  if (!user) {
    return res.status(401).json({
      error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
    })
  }

  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).json({
        error: 'สร้างเซสชันเข้าสู่ระบบไม่สำเร็จ',
      })
    }

    req.session.authenticated = true
    req.session.username = user.username

    req.session.save((saveError) => {
      if (saveError) {
        return res.status(500).json({
          error: 'บันทึกเซสชันไม่สำเร็จ',
        })
      }

      res.json({
        ok: true,
        username: user.username,
        isAdmin: Boolean(
          process.env.ADMIN_USERNAME &&
          user.username === process.env.ADMIN_USERNAME
        ),
      })
    })
  })
})

// ออกจากระบบ
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({
        error: 'ออกจากระบบไม่สำเร็จ',
      })
    }

    res.clearCookie('pixel_manager_session')
    res.json({ ok: true })
  })
})

// โหลด Pixel ID จาก GitHub
app.get(
  '/api/pages/:id',
  requireAuth,
  requirePageAccess,
  async (req, res) => {
    try {
      const page = pageById(req.params.id)
      const gh = await getGitHubClient()

      const response = await gh.request(
        'GET /repos/{owner}/{repo}/contents/{path}',
        {
          owner: page.owner,
          repo: page.repo,
          path: page.path,
          ref: page.branch,
        }
      )

      const data = response.data

      if (Array.isArray(data) || !data.content || data.type !== 'file') {
        throw new Error('ปลายทางไม่ใช่ไฟล์ หรือไฟล์ไม่มีเนื้อหา')
      }

      const html = Buffer.from(data.content, 'base64').toString('utf8')
      const ids = parseIds(html)

      res.json({
        ids,
        sha: data.sha,
      })
    } catch (error) {
      console.error('โหลด Pixel ID ไม่สำเร็จ:', error)

      res.status(error.status || 400).json({
        error: error.message || 'โหลด Pixel ID ไม่สำเร็จ',
      })
    }
  }
)

// บันทึก Pixel ID และ Commit กลับ GitHub
app.post(
  '/api/pages/:id/commit',
  requireAuth,
  requirePageAccess,
  async (req, res) => {
    try {
      const page = pageById(req.params.id)
      const ids = req.body?.ids

      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.some((id) => !/^\d{5,25}$/.test(String(id))) ||
        new Set(ids.map(String)).size !== ids.length
      ) {
        return res.status(400).json({
          error: 'Pixel ID ต้องเป็นตัวเลข 5–25 หลัก ไม่ซ้ำกัน และต้องมีอย่างน้อยหนึ่งรายการ',
        })
      }

      const normalizedIds = ids.map(String)
      const gh = await getGitHubClient()

      const response = await gh.request(
        'GET /repos/{owner}/{repo}/contents/{path}',
        {
          owner: page.owner,
          repo: page.repo,
          path: page.path,
          ref: page.branch,
        }
      )

      const file = response.data

      if (Array.isArray(file) || !file.content || file.type !== 'file') {
        throw new Error('อ่านไฟล์ HTML ไม่สำเร็จ')
      }

      const original = Buffer.from(file.content, 'base64').toString('utf8')
      const updated = rewritePixelIds(original, normalizedIds)

      if (updated === original) {
        return res.status(400).json({
          error: 'ไม่มีการเปลี่ยนแปลงจากค่าเดิม',
        })
      }

      const commitResponse = await gh.request(
        'PUT /repos/{owner}/{repo}/contents/{path}',
        {
          owner: page.owner,
          repo: page.repo,
          path: page.path,
          message: String(
            req.body?.message ||
            `Update Facebook Pixel IDs (${normalizedIds.length})`
          ).slice(0, 120),
          content: Buffer.from(updated, 'utf8').toString('base64'),
          sha: file.sha,
          branch: page.branch,
        }
      )

      res.json({
        ok: true,
        commitUrl: commitResponse.data.commit.html_url,
        ids: normalizedIds.length,
      })
    } catch (error) {
      console.error('Commit Pixel ID ไม่สำเร็จ:', error)

      res.status(error.status || 400).json({
        error: error.message || 'Commit ไม่สำเร็จ',
      })
    }
  }
)

// เสิร์ฟหน้าเว็บ React ที่ build แล้ว
app.use(express.static(path.join(__dirname, 'dist')))

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

app.listen(port, () => {
  console.log(`Pixel Control listening on :${port}`)
})
