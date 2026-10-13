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

// สร้าง GitHub App
const githubApp = () => {
  const appId = process.env.GITHUB_APP_ID
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY
    ?.replace(/\\n/g, '\n')
  const installationId = Number(process.env.GITHUB_INSTALLATION_ID)

  if (!appId || !privateKey || !Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error(
      'การตั้งค่า GitHub App ไม่ครบ กรุณาตรวจ GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY และ GITHUB_INSTALLATION_ID'
    )
  }

  return new GitHubApp({
    appId,
    privateKey,
  })
}

const getGitHubClient = async () => {
  const installationId = Number(process.env.GITHUB_INSTALLATION_ID)

  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error('GITHUB_INSTALLATION_ID ไม่ถูกต้อง')
  }

  return githubApp().getInstallationOctokit(installationId)
}

// ตรวจสอบการตั้งค่า Repository
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

const requireAuth = (req, res, next) =>
  req.session?.authenticated
    ? next()
    : res.status(401).json({
        error: 'กรุณาเข้าสู่ระบบผู้ดูแลก่อนใช้งาน',
      })

// แปลงข้อความ HTML เป็น Pixel ID
function parseIds(html) {
  const init = [
    ...html.matchAll(
      /(?:window\.)?fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d+)['"]/gi
    ),
  ].map((m) => m[1])

  const noscript = [
    ...html.matchAll(
      /<img\b(?=[^>]*facebook\.com\/tr\?id=)(?=[^>]*noscript=1)[^>]*>/gi
    ),
  ]
    .map((m) => m[0].match(/[?&]id=(\d+)/i)?.[1])
    .filter(Boolean)

  if (!init.length && !noscript.length) {
    throw new Error(
      'ไม่พบ Facebook Pixel ใน fbq init หรือ noscript กรุณาตรวจรูปแบบในไฟล์ HTML'
    )
  }

  // ใช้ลำดับจาก fbq init ก่อน แล้วรวม ID ที่พบเฉพาะใน noscript
  return [...new Set([...init, ...noscript])]
}

// แทนที่ Pixel ID ใน fbq init และ noscript
function rewritePixelIds(html, ids) {
  const initRegex =
    /(?:window\.)?fbq\s*\(\s*['"]init['"]\s*,\s*['"]\d+['"]\s*\)\s*;?/gi

  const imgRegex =
    /<img\b(?=[^>]*facebook\.com\/tr\?id=)(?=[^>]*noscript=1)[^>]*>/gi

  const initMatches = [...html.matchAll(initRegex)]
  const imgMatches = [...html.matchAll(imgRegex)]

  if (!initMatches.length) {
    throw new Error('ไม่พบ fbq init ในไฟล์ HTML จึงหยุดการบันทึก')
  }

  if (!imgMatches.length) {
    throw new Error('ไม่พบ Facebook Pixel noscript ในไฟล์ HTML จึงหยุดการบันทึก')
  }

  // สร้างส่วน fbq init ตามรายการ ID ใหม่
  function rebuildInit(source, matches, values) {
    const firstIndex = matches[0].index
    const lastMatch = matches[matches.length - 1]
    const lastEnd = lastMatch.index + lastMatch[0].length

    const before = source.slice(0, firstIndex)
    const after = source.slice(lastEnd)

    const replacement = values
      .map((id) => `fbq('init', '${id}');`)
      .join('\n    ')

    return before + replacement + after
  }

  // สร้างส่วน noscript ตามรายการ ID ใหม่
  function rebuildNoscript(source, matches, values) {
    const firstIndex = matches[0].index
    const lastMatch = matches[matches.length - 1]
    const lastEnd = lastMatch.index + lastMatch[0].length

    const before = source.slice(0, firstIndex)
    const after = source.slice(lastEnd)

    const replacement = values
      .map((id) =>
        lastMatch[0].replace(
          /([?&]id=)\d+/i,
          (_match, prefix) => `${prefix}${id}`
        )
      )
      .join('\n')

    return before + replacement + after
  }

  let result = rebuildInit(html, initMatches, ids)
  const updatedImgMatches = [...result.matchAll(imgRegex)]

  if (!updatedImgMatches.length) {
    throw new Error('ไม่พบ noscript หลังประมวลผล fbq init')
  }

  result = rebuildNoscript(result, updatedImgMatches, ids)

  return result
}

// อ่านข้อมูลสถานะ
app.get('/api/status', (req, res) => {
  res.json({
    configured: configured(),
    authenticated: Boolean(req.session?.authenticated),
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

  req.session.authenticated = true
  req.session.username = user.username

  res.json({
    ok: true,
    username: user.username,
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
app.get('/api/pages/:id', requireAuth, async (req, res) => {
  try {
    const page = pageById(req.params.id)

    if (!page) {
      return res.status(404).json({
        error: 'ไม่พบเซลเพจ หรือยังไม่ได้ตั้งค่า Repository ใน src/config.js',
      })
    }

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
})

// บันทึก Pixel ID และ Commit กลับ GitHub
app.post('/api/pages/:id/commit', requireAuth, async (req, res) => {
  try {
    const page = pageById(req.params.id)

    if (!page) {
      return res.status(404).json({
        error: 'ไม่พบเซลเพจ หรือยังไม่ได้ตั้งค่า Repository ใน src/config.js',
      })
    }

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

    const gh = await getGitHubClient()

    // อ่านไฟล์เดิมเพื่อรับ SHA สำหรับ Commit
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
    const updated = rewritePixelIds(original, ids.map(String))

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
          req.body?.message || `Update Facebook Pixel IDs (${ids.length})`
        ).slice(0, 120),
        content: Buffer.from(updated, 'utf8').toString('base64'),
        sha: file.sha,
        branch: page.branch,
      }
    )

    res.json({
      ok: true,
      commitUrl: commitResponse.data.commit.html_url,
      ids: ids.length,
    })
  } catch (error) {
    console.error('Commit Pixel ID ไม่สำเร็จ:', error)

    res.status(error.status || 400).json({
      error: error.message || 'Commit ไม่สำเร็จ',
    })
  }
})

// เสิร์ฟหน้าเว็บ React ที่ build แล้ว
app.use(express.static(path.join(__dirname, 'dist')))

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

app.listen(port, () => {
  console.log(`Pixel Control listening on :${port}`)
})
