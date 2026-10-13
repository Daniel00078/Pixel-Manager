
import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Code2,
  ExternalLink,
  FileCode2,
  GitCommitHorizontal,
  Github,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  UploadCloud,
  AlertTriangle,
  LogOut,
} from 'lucide-react'
import { SALES_PAGES } from './config'
import './styles.css'

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(
      data.error || data.message || `Request failed (${response.status})`
    )
  }

  return data
}

function App() {
  const [selectedId, setSelectedId] = useState(
    SALES_PAGES.find((page) => !page.adminOnly)?.id ?? ''
  )

  const [pixelRows, setPixelRows] = useState([])
  const [status, setStatus] = useState({ type: 'idle', message: '' })
  const [commitUrl, setCommitUrl] = useState('')
  const [commitMessage, setCommitMessage] = useState(
    'Update Facebook Pixel ID'
  )
  const [busy, setBusy] = useState(false)
  const [showSecurity, setShowSecurity] = useState(false)

  const [authenticated, setAuthenticated] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [serverConfigured, setServerConfigured] = useState(false)

  const [username, setUsername] = useState('user1')
  const [password, setPassword] = useState('')

  // กรองหน้า adminOnly ออกจากรายการของผู้ใช้ทั่วไป
  const visiblePages = useMemo(
    () =>
      SALES_PAGES.filter(
        (page) => !page.adminOnly || (authenticated && isAdmin)
      ),
    [authenticated, isAdmin]
  )

  const selected = useMemo(
    () => visiblePages.find((page) => page.id === selectedId),
    [visiblePages, selectedId]
  )

  const repoIsConfigured = Boolean(
    selected &&
      selected.owner !== 'YOUR_GITHUB_USERNAME' &&
      !selected.repo.startsWith('YOUR_SALES_PAGE_REPO')
  )

  const desiredPixelIds = pixelRows
    .map((row) => row.value.trim())
    .filter(Boolean)

  const pixelIsValid =
    pixelRows.length > 0 &&
    pixelRows.every((row) => /^\d{5,25}$/.test(row.value.trim())) &&
    new Set(desiredPixelIds).size === desiredPixelIds.length

  // อ่านสถานะและสิทธิ์จากเซิร์ฟเวอร์
  async function refreshAuth() {
    try {
      const data = await api('/api/status')

      setServerConfigured(Boolean(data.configured))
      setAuthenticated(Boolean(data.authenticated))
      setIsAdmin(Boolean(data.authenticated && data.isAdmin))

      if (!data.authenticated) {
        setPixelRows([])
      }
    } catch {
      setServerConfigured(false)
      setAuthenticated(false)
      setIsAdmin(false)
      setPixelRows([])
    }
  }

  // ล็อกอิน
  async function login(e) {
    e?.preventDefault()

    setBusy(true)

    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      })

      setPassword('')
      setAuthenticated(true)
      setIsAdmin(Boolean(data.isAdmin))

      setStatus({
        type: 'success',
        message: data.isAdmin
          ? 'เข้าสู่ระบบแอดมินสำเร็จ'
          : 'เข้าสู่ระบบสำเร็จ',
      })
    } catch (error) {
      setStatus({ type: 'error', message: error.message })
    } finally {
      setBusy(false)
    }
  }

  // ออกจากระบบ
  async function logout() {
    try {
      await api('/api/logout', {
        method: 'POST',
        body: '{}',
      })
    } catch {
      // ล้างสถานะบนหน้าจอแม้ API ออกจากระบบมีปัญหา
    }

    setAuthenticated(false)
    setIsAdmin(false)
    setPixelRows([])
    setCommitUrl('')
    setSelectedId(
      SALES_PAGES.find((page) => !page.adminOnly)?.id ?? ''
    )
    setStatus({ type: 'idle', message: 'ออกจากระบบแล้ว' })
  }

  // โหลด Pixel ID จาก GitHub
  async function loadCurrentPixelIds(pageId = selectedId) {
    if (!authenticated || !pageId) return

    const page = SALES_PAGES.find((item) => item.id === pageId)

    // ป้องกันไม่ให้หน้าเว็บพยายามโหลดหน้าที่ไม่มีสิทธิ์
    if (page?.adminOnly && !isAdmin) {
      setPixelRows([])
      setStatus({
        type: 'error',
        message: 'เซลเพจนี้อนุญาตให้แอดมินใช้งานเท่านั้น',
      })
      return
    }

    setBusy(true)
    setStatus({
      type: 'working',
      message: 'กำลังโหลด Pixel ID เดิมจาก GitHub…',
    })

    try {
      const data = await api(
        `/api/pages/${encodeURIComponent(pageId)}`
      )

      setPixelRows(
        data.ids.map((value, index) => ({
          key: `${Date.now()}-${index}-${Math.random()}`,
          value,
        }))
      )

      setStatus({
        type: 'success',
        message: `โหลด Pixel ID เดิม ${data.ids.length} รายการแล้ว`,
      })
    } catch (error) {
      setPixelRows([])
      setStatus({ type: 'error', message: error.message })
    } finally {
      setBusy(false)
    }
  }

  // บันทึก Pixel ID และ Commit กลับ GitHub
  async function commitPixel() {
    if (!selected) {
      setStatus({
        type: 'error',
        message: 'กรุณาเลือกเซลเพจที่คุณมีสิทธิ์ใช้งาน',
      })
      return
    }

    if (selected.adminOnly && !isAdmin) {
      setStatus({
        type: 'error',
        message: 'เซลเพจนี้อนุญาตให้แอดมินใช้งานเท่านั้น',
      })
      return
    }

    if (!pixelIsValid) {
      setStatus({
        type: 'error',
        message:
          'กรอก Pixel ID ทุกช่องให้เป็นตัวเลข 5–25 หลักและห้ามซ้ำ หากต้องการลบให้กดปุ่มลบของช่องนั้น',
      })
      return
    }

    setBusy(true)
    setCommitUrl('')
    setStatus({
      type: 'working',
      message: 'กำลังบันทึกและ Commit ไปยัง GitHub…',
    })

    try {
      const data = await api(
        `/api/pages/${encodeURIComponent(selectedId)}/commit`,
        {
          method: 'POST',
          body: JSON.stringify({
            ids: desiredPixelIds,
            message: commitMessage,
          }),
        }
      )

      setCommitUrl(data.commitUrl)

      setStatus({
        type: 'success',
        message: `Commit สำเร็จ ซิงก์ ${data.ids} Pixel ID แล้ว`,
      })

      await loadCurrentPixelIds(selectedId)
    } catch (error) {
      setStatus({ type: 'error', message: error.message })
    } finally {
      setBusy(false)
    }
  }

  // ตรวจสอบสถานะเซสชันเมื่อเปิดหน้าเว็บ
  useEffect(() => {
    refreshAuth()
  }, [])

  // หากเลือกหน้า adminOnly อยู่ แต่ไม่มีสิทธิ์ ให้เปลี่ยนหน้า
  useEffect(() => {
    if (visiblePages.length === 0) {
      setSelectedId('')
      setPixelRows([])
      setCommitUrl('')
      return
    }

    if (!visiblePages.some((page) => page.id === selectedId)) {
      setSelectedId(visiblePages[0].id)
      setPixelRows([])
      setCommitUrl('')
      setStatus({ type: 'idle', message: '' })
    }
  }, [visiblePages, selectedId])

  // โหลด Pixel ID เมื่อเข้าสู่ระบบหรือเปลี่ยนเซลเพจ
  useEffect(() => {
    if (authenticated && selectedId && selected) {
      loadCurrentPixelIds(selectedId)
    }
    // loadCurrentPixelIds ใช้ selectedId และสิทธิ์ปัจจุบัน
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, selectedId, isAdmin])

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Activity size={23} strokeWidth={2.5} />
          </div>
          <div>
            <div className="brand-name">
              PIXEL<span>CONTROL</span>
            </div>
            <div className="brand-sub">SALES PAGE TOOLS</div>
          </div>
        </div>

        <div className="side-label">WORKSPACE</div>
        <div className="nav-item active">
          <Code2 size={18} />
          Pixel Manager
          <span className="nav-dot" />
        </div>

        <div className="side-card">
          <div className="side-card-icon">
            <ShieldCheck size={18} />
          </div>
          <div className="side-card-title">GitHub App integration</div>
          <div className="side-card-text">
            เก็บสิทธิ์ GitHub ไว้บนเซิร์ฟเวอร์ ไม่ส่ง Token ไปยังเบราว์เซอร์
          </div>
        </div>

        <div className="sidebar-bottom">
          <div className="connection-dot" />
          <span>
            {!authenticated
              ? 'Sign-in required'
              : isAdmin
                ? 'Admin connected'
                : 'User connected'}
          </span>
          <div className="sidebar-version">v2.0.0</div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> <strong>Pixel Manager</strong>
          </div>

          <div className="topbar-right">
            <span className="status-pill">
              <span className="live-dot" />
              {authenticated
                ? isAdmin
                  ? 'ADMIN CONNECTED'
                  : 'CONNECTED'
                : 'SECURE LOGIN'}
            </span>

            {authenticated && (
              <button
                className="icon-button"
                onClick={logout}
                title="ออกจากระบบ"
              >
                <LogOut size={16} />
              </button>
            )}

            <div className="avatar">PC</div>
          </div>
        </header>

        <section className="page-heading">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-line" />
              TRACKING CONFIGURATION
            </div>
            <h1>
              Pixel <span>Manager</span>
            </h1>
            <p>
              จัดการ Facebook Pixel ID แยกรายการของเซลเพจแต่ละ Repository
              ได้จากที่เดียว
            </p>
          </div>
          <div className="heading-icon">
            <Activity size={30} />
          </div>
        </section>

        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-icon green">
              <FileCode2 size={19} />
            </div>
            <div>
              <div className="stat-label">CONFIGURED PAGES</div>
              <div className="stat-value">
                {visiblePages.length.toString().padStart(2, '0')}{' '}
                <span>pages</span>
              </div>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon blue">
              <Github size={19} />
            </div>
            <div>
              <div className="stat-label">INTEGRATION</div>
              <div className="stat-value small-value">GitHub App</div>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon amber">
              <LockKeyhole size={19} />
            </div>
            <div>
              <div className="stat-label">CREDENTIALS</div>
              <div className="stat-value small-value">Server-side</div>
            </div>
          </div>
        </div>

        <div className="workspace-grid">
          <section className="panel editor-panel">
            <div className="panel-heading">
              <div className="panel-heading-icon">
                <Code2 size={19} />
              </div>
              <div>
                <h2>แก้ไข Pixel ID</h2>
                <p>ระบบโหลด ID เดิมอัตโนมัติหลังเข้าสู่ระบบ</p>
              </div>
              <span className="step-label">STEP 01</span>
            </div>

            {!serverConfigured && (
              <div className="security-details">
                <b>เซิร์ฟเวอร์ยังตั้งค่าไม่ครบ</b>
                <p>
                  ต้องตั้งค่า GitHub App และค่าลับใน Environment Variables
                  บนเซิร์ฟเวอร์ก่อน จึงจะใช้งานได้
                </p>
              </div>
            )}

            {!authenticated ? (
              <form className="field-group" onSubmit={login}>
                <label htmlFor="login-username">
                  ชื่อผู้ใช้ <span className="required">*</span>
                </label>

                <div className="input-wrap">
                  <LockKeyhole size={17} />
                  <input
                    id="login-username"
                    autoComplete="username"
                    placeholder="ใส่ชื่อผู้ใช้"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                  />
                </div>

                <label htmlFor="admin-password">
                  รหัสผ่าน <span className="required">*</span>
                </label>

                <div className="input-wrap">
                  <LockKeyhole size={17} />
                  <input
                    id="admin-password"
                    type="password"
                    autoComplete="current-password"
                    placeholder="ใส่รหัสผ่าน"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>

                <div className="field-hint">
                  <LockKeyhole size={14} />
                  รหัสผ่านใช้ยืนยันสิทธิ์กับเซิร์ฟเวอร์เท่านั้น
                  ไม่ใช่ GitHub Token
                </div>

                <button
                  className="commit-button"
                  type="submit"
                  disabled={busy || !serverConfigured || !password}
                >
                  {busy ? (
                    <RefreshCw className="spin" size={18} />
                  ) : (
                    <LockKeyhole size={18} />
                  )}
                  {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
                  <ArrowUpRight size={17} className="button-arrow" />
                </button>
              </form>
            ) : (
              <>
                <div className="field-group">
                  <label htmlFor="page-select">
                    เลือกเซลเพจ <span className="required">*</span>
                  </label>

                  <div className="select-wrap">
                    <select
                      id="page-select"
                      value={selectedId}
                      onChange={(e) => {
                        setSelectedId(e.target.value)
                        setPixelRows([])
                        setStatus({ type: 'idle', message: '' })
                        setCommitUrl('')
                      }}
                    >
                      {visiblePages.map((page) => (
                        <option key={page.id} value={page.id}>
                          {page.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={17} />
                  </div>

                  {selected && (
                    <div className="repo-summary">
                      <div className="repo-icon">
                        <Github size={17} />
                      </div>

                      <div className="repo-meta">
                        <strong>
                          {selected.owner} / {selected.repo}
                        </strong>
                        <span>
                          <FileCode2 size={13} /> {selected.path}
                          <span className="meta-sep"> · </span>
                          branch: {selected.branch}
                        </span>
                      </div>

                      <a
                        className="external-link"
                        href={`https://github.com/${selected.owner}/${selected.repo}`}
                        target="_blank"
                        rel="noreferrer"
                        title="เปิด Repository"
                      >
                        <ExternalLink size={15} />
                      </a>
                    </div>
                  )}
                </div>

                <div className="field-group">
                  <label>
                    รายการ Facebook Pixel ID{' '}
                    <span className="required">*</span>
                  </label>

                  <button
                    className="load-pixels-button"
                    type="button"
                    onClick={() => loadCurrentPixelIds()}
                    disabled={busy || !selected}
                  >
                    <RefreshCw size={13} />
                    โหลด Pixel ID เดิมจาก GitHub
                  </button>

                  <div className="pixel-rows">
                    {pixelRows.length === 0 && (
                      <div className="pixel-empty">
                        {busy
                          ? 'กำลังอ่านไฟล์จาก GitHub…'
                          : 'ไม่พบรายการที่โหลดได้ กดโหลดอีกครั้งหรือตรวจสอบรูปแบบ Pixel ใน index.html'}
                      </div>
                    )}

                    {pixelRows.map((row, index) => (
                      <div className="pixel-row" key={row.key}>
                        <div className="pixel-row-number">
                          {String(index + 1).padStart(2, '0')}
                        </div>

                        <div className="pixel-row-input">
                          <label htmlFor={`pixel-row-${row.key}`}>
                            Pixel ID {index + 1}
                          </label>
                          <input
                            id={`pixel-row-${row.key}`}
                            inputMode="numeric"
                            autoComplete="off"
                            spellCheck="false"
                            placeholder="ใส่ตัวเลข Pixel ID"
                            value={row.value}
                            onChange={(e) =>
                              setPixelRows((rows) =>
                                rows.map((item) =>
                                  item.key === row.key
                                    ? {
                                        ...item,
                                        value: e.target.value.replace(
                                          /\D/g,
                                          ''
                                        ),
                                      }
                                    : item
                                )
                              )
                            }
                          />
                        </div>

                        <button
                          className="pixel-remove-button"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            setPixelRows((rows) =>
                              rows.filter((item) => item.key !== row.key)
                            )
                          }
                          aria-label={`ลบ Pixel ID ${index + 1}`}
                          title="ลบเฉพาะช่องนี้"
                        >
                          ลบ
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="pixel-actions">
                    <button
                      className="add-pixel-button"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setPixelRows((rows) => [
                          ...rows,
                          {
                            key: `${Date.now()}-${Math.random()}`,
                            value: '',
                          },
                        ])
                      }
                    >
                      + เพิ่มช่อง Pixel ID
                    </button>

                    <div className="pixel-list-summary">
                      {pixelRows.length} ช่อง · แก้ไขหรือลบเฉพาะช่องที่เลือก
                    </div>
                  </div>

                  <div className="field-hint">
                    <CircleHelp size={14} />
                    เมื่อ Commit ระบบจะซิงก์ ID ทั้งหมดที่แสดงให้ตรงกันใน
                    fbq init และ noscript
                  </div>
                </div>

                <div className="field-group">
                  <label htmlFor="commit-message">Commit message</label>
                  <div className="input-wrap">
                    <GitCommitHorizontal size={17} />
                    <input
                      id="commit-message"
                      value={commitMessage}
                      onChange={(e) => setCommitMessage(e.target.value)}
                      maxLength={120}
                    />
                  </div>
                </div>

                <div className="divider" />

                <button
                  className="commit-button"
                  disabled={busy || !selected || !pixelIsValid}
                  onClick={commitPixel}
                >
                  {busy ? (
                    <RefreshCw className="spin" size={18} />
                  ) : (
                    <UploadCloud size={19} />
                  )}
                  {busy
                    ? 'กำลังดำเนินการ…'
                    : 'ซิงก์ Pixel IDs และ Commit Git'}
                  {!busy && (
                    <ArrowUpRight size={17} className="button-arrow" />
                  )}
                </button>

                <div className="button-note">
                  <LockKeyhole size={12} />
                  GitHub App ทำงานบนเซิร์ฟเวอร์ ไม่ใช้ Token ในหน้าเว็บ
                </div>
              </>
            )}
          </section>

          <aside className="right-column">
            <section className="panel target-panel">
              <div className="panel-heading compact">
                <div className="panel-heading-icon">
                  <Github size={18} />
                </div>
                <div>
                  <h2>Target Repository</h2>
                  <p>ปลายทางที่จะได้รับการแก้ไข</p>
                </div>
              </div>

              <div className="target-detail">
                <div className="detail-label">REPOSITORY</div>
                <div className="detail-value">
                  {selected ? `${selected.owner}/${selected.repo}` : '—'}
                </div>
              </div>

              <div className="target-detail">
                <div className="detail-label">TARGET FILE</div>
                <div className="file-chip">
                  <FileCode2 size={15} />
                  {selected?.path || '—'}
                </div>
              </div>

              <div className="target-detail">
                <div className="detail-label">BRANCH</div>
                <div className="branch-chip">
                  <GitCommitHorizontal size={14} />
                  {selected?.branch || '—'}
                </div>
              </div>

              <div className="target-footer">
                <span className="target-footer-dot" />
                {repoIsConfigured
                  ? 'Repository configured'
                  : 'กรุณาแก้ src/config.js ก่อนใช้งาน'}
              </div>
            </section>

            <section className="notice-card">
              <div className="notice-head">
                <div className="notice-icon">
                  <ShieldCheck size={18} />
                </div>
                <strong>Security notice</strong>
              </div>

              <p>
                GitHub App private key และ installation token
                จะอยู่ฝั่งเซิร์ฟเวอร์เท่านั้น ห้ามนำไฟล์ .env ขึ้น GitHub
              </p>

              <button
                type="button"
                onClick={() => setShowSecurity((v) => !v)}
              >
                ดูขั้นตอนตั้งค่าความปลอดภัย
                <ArrowUpRight size={14} />
              </button>

              {showSecurity && (
                <div className="security-details">
                  <ol>
                    <li>
                      กำหนด GitHub App permissions: Contents — Read and write
                    </li>
                    <li>
                      ติดตั้ง App เฉพาะ Repository ที่ต้องการจัดการ
                    </li>
                    <li>
                      ตั้งค่า GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY,
                      GITHUB_INSTALLATION_ID, SESSION_SECRET และ ADMIN_USERNAME
                      บนเซิร์ฟเวอร์
                    </li>
                    <li>
                      กำหนด USER_1 ถึง USER_5 ทั้ง username และ password
                    </li>
                    <li>ห้ามเปิดเผย private key หรือไฟล์ .env</li>
                  </ol>
                </div>
              )}
            </section>

            <section className="activity-panel">
              <div className="activity-title">
                <span className="activity-title-icon">
                  <GitCommitHorizontal size={17} />
                </span>
                <strong>สถานะการทำงาน</strong>
              </div>

              <div className={`activity-status ${status.type}`}>
                <div className="activity-status-icon">
                  {status.type === 'success' ? (
                    <Check size={17} />
                  ) : status.type === 'error' ? (
                    <AlertTriangle size={17} />
                  ) : status.type === 'working' ? (
                    <RefreshCw className="spin" size={16} />
                  ) : (
                    <Activity size={17} />
                  )}
                </div>

                <div>
                  <div className="activity-status-title">
                    {status.type === 'success'
                      ? 'Action completed'
                      : status.type === 'error'
                        ? 'Action required'
                        : status.type === 'working'
                          ? 'Processing request'
                          : 'Ready to update'}
                  </div>
                  <p>
                    {status.message ||
                      'เข้าสู่ระบบเพื่อโหลด Pixel ID เดิมจาก GitHub'}
                  </p>
                </div>
              </div>

              {commitUrl && (
                <a
                  className="commit-result-link"
                  href={commitUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  ดู Commit บน GitHub <ExternalLink size={14} />
                </a>
              )}
            </section>
          </aside>
        </div>

        <footer className="footer">
          <span>
            PIXEL CONTROL <span className="footer-sep">/</span> REACT EDITION
          </span>
          <span>GitHub App · server-side credentials</span>
        </footer>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
