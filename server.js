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
  cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 8 * 60 * 60 * 1000 },
}))

const configured = () => Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_INSTALLATION_ID && process.env.SESSION_SECRET && Array.from({ length: 5 }, (_, i) => i + 1).every((i) => process.env[`USER_${i}_USERNAME`] && process.env[`USER_${i}_PASSWORD`]))
const users = () => Array.from({ length: 5 }, (_, i) => ({ username: process.env[`USER_${i + 1}_USERNAME`], password: process.env[`USER_${i + 1}_PASSWORD`] })).filter((u) => u.username && u.password)
const githubApp = () => new GitHubApp({
  appId: process.env.GITHUB_APP_ID,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n'),
})
const pageById = (id) => SALES_PAGES.find((page) => page.id === id && page.owner && page.repo && !page.owner.startsWith('YOUR_') && !page.repo.startsWith('YOUR_'))
const requireAuth = (req, res, next) => req.session?.authenticated ? next() : res.status(401).json({ error: 'กรุณาเข้าสู่ระบบผู้ดูแลก่อนใช้งาน' })

function parseIds(html) {
  const init = [...html.matchAll(/(?:window\.)?fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d+)['"]/gi)].map((m) => m[1])
  const noscript = [...html.matchAll(/<img\b(?=[^>]*facebook\.com\/tr\?id=)(?=[^>]*noscript=1)[^>]*>/gi)].map((m) => m[0].match(/[?&]id=(\d+)/i)?.[1]).filter(Boolean)
  if (!init.length || !noscript.length) throw new Error('ไม่พบ Facebook Pixel ทั้งใน fbq init และ noscript ในรูปแบบที่รองรับ')
  // init order is the canonical order; include IDs found only in noscript as a safety net.
  return [...new Set([...init, ...noscript])]
}

function rewritePixelIds(html, ids) {
  const initRegex = /(?:window\.)?fbq\s*\(\s*['"]init['"]\s*,\s*['"]\d+['"]\s*\)\s*;?/gi
  const imgRegex = /<img\b(?=[^>]*facebook\.com\/tr\?id=)(?=[^>]*noscript=1)[^>]*>/gi
  const initMatches = [...html.matchAll(initRegex)]
  const imgMatches = [...html.matchAll(imgRegex)]
  if (!initMatches.length || !imgMatches.length) throw new Error('หยุดการบันทึก: ไม่พบ fbq init หรือ noscript ที่รองรับ')
  const rebuild = (source, matches, values, type) => {
    let out = '', cursor = 0
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]
      out += source.slice(cursor, m.index)
      if (i < values.length) {
        out += type === 'init'
          ? m[0].replace(/(['"])\d+(['"])/, (_x, a, b) => `${a}${values[i]}${b}`)
          : m[0].replace(/([?&]id=)\d+/i, (_x, prefix) => `${prefix}${values[i]}`)
      }
      if (i === matches.length - 1 && values.length > matches.length) {
        out += values.slice(matches.length).map((id) => type === 'init'
          ? `\n    fbq('init', '${id}');`
          : m[0].replace(/([?&]id=)\d+/i, (_x, prefix) => `${prefix}${id}`)).join(type === 'init' ? '' : '\n')
      }
      cursor = m.index + m[0].length
    }
    return out + source.slice(cursor)
  }
  let result = rebuild(html, initMatches, ids, 'init')
  result = rebuild(result, [...result.matchAll(imgRegex)], ids, 'noscript')
  return result
}

app.get('/api/status', (req, res) => res.json({ configured: configured(), authenticated: Boolean(req.session?.authenticated) }))
app.post('/api/login', (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'เซิร์ฟเวอร์ยังตั้งค่าไม่ครบ กรุณาตั้งค่า Environment Variables ตาม README' })
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const user = users().find((u) => u.username === username && u.password === password)
  if (!user) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' })
  req.session.authenticated = true
  req.session.username = user.username
  res.json({ ok: true, username: user.username })
})
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })))

app.get('/api/pages/:id', requireAuth, async (req, res) => {
  try {
    const page = pageById(req.params.id)
    if (!page) return res.status(404).json({ error: 'ไม่พบเซลเพจ หรือยังไม่ได้ตั้งค่า Repository ใน src/config.js' })
    const gh = await githubApp().getInstallationOctokit(Number(process.env.GITHUB_INSTALLATION_ID))
    const { data } = await gh.rest.repos.getContent({ owner: page.owner, repo: page.repo, path: page.path, ref: page.branch })
    if (Array.isArray(data) || !data.content) throw new Error('ปลายทางไม่ใช่ไฟล์ หรือไฟล์ไม่มีเนื้อหา')
    const html = Buffer.from(data.content, 'base64').toString('utf8')
    res.json({ ids: parseIds(html), sha: data.sha })
  } catch (e) { res.status(400).json({ error: e.message || 'โหลด Pixel ID ไม่สำเร็จ' }) }
})

app.post('/api/pages/:id/commit', requireAuth, async (req, res) => {
  try {
    const page = pageById(req.params.id)
    if (!page) return res.status(404).json({ error: 'ไม่พบเซลเพจ หรือยังไม่ได้ตั้งค่า Repository ใน src/config.js' })
    const ids = req.body?.ids
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => !/^\d{5,25}$/.test(String(id))) || new Set(ids).size !== ids.length) return res.status(400).json({ error: 'Pixel ID ต้องเป็นตัวเลข 5–25 หลัก ไม่ซ้ำกัน และต้องมีอย่างน้อยหนึ่งรายการ' })
    const gh = await githubApp().getInstallationOctokit(Number(process.env.GITHUB_INSTALLATION_ID))
    const { data: file } = await gh.rest.repos.getContent({ owner: page.owner, repo: page.repo, path: page.path, ref: page.branch })
    if (Array.isArray(file) || !file.content) throw new Error('อ่านไฟล์ HTML ไม่สำเร็จ')
    const original = Buffer.from(file.content, 'base64').toString('utf8')
    const updated = rewritePixelIds(original, ids.map(String))
    if (updated === original) return res.status(400).json({ error: 'ไม่มีการเปลี่ยนแปลงจากค่าเดิม' })
    const { data: result } = await gh.rest.repos.createOrUpdateFileContents({
      owner: page.owner, repo: page.repo, path: page.path,
      message: String(req.body?.message || `Update Facebook Pixel IDs (${ids.length})`).slice(0, 120),
      content: Buffer.from(updated, 'utf8').toString('base64'), sha: file.sha, branch: page.branch,
    })
    res.json({ ok: true, commitUrl: result.commit.html_url, ids: ids.length })
  } catch (e) { res.status(400).json({ error: e.message || 'Commit ไม่สำเร็จ' }) }
})

app.use(express.static(path.join(__dirname, 'dist')))
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')))

app.listen(port, () => console.log(`Pixel Control listening on :${port}`))
