import React, { useCallback, useEffect, useMemo, useState } from 'react'
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
  const [selectedId, setSelectedId] = useState('')

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
  const [currentUsername, setCurrentUsername] = useState('')
  const [accessiblePageIds, setAccessiblePageIds] = useState([])

  // แยกข้อมูลฟอร์มล็อกอินออกจากผู้ใช้ที่ล็อกอินแล้ว
  const [loginUsername, setLoginUsername] = useState('')
  const [password, setPassword] = useState('')

  // ใช้รายการสิทธิ์จาก Backend เป็นหลัก
  const visiblePages = useMemo(() => {
    if (!authenticated) return []

    return SALES_PAGES.filter((page) =>
      accessiblePageIds.includes(page.id)
    )
  }, [authenticated, accessiblePageIds])

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

  // อ่านสถานะการล็อกอินและสิทธิ์จาก Backend
  const refreshAuth = useCallback(async () => {
    try {
      const data = await api('/api/status')

      const loggedIn = Boolean(data.authenticated)

      setServerConfigured(Boolean(data.configured))
      setAuthenticated(loggedIn)
      setIsAdmin(Boolean(loggedIn && data.isAdmin))
      setCurrentUsername(loggedIn ? data.username || '' : '')
      setAccessiblePageIds(
        loggedIn && Array.isArray(data.accessiblePageIds)
          ? data.accessiblePageIds
          : []
      )

      if (!loggedIn) {
        setPixelRows([])
        setSelectedId('')
      }
    } catch {
      setServerConfigured(false)
      setAuthenticated(false)
      setIsAdmin(false)
      setCurrentUsername('')
      setAccessiblePageIds([])
      setPixelRows([])
      setSelectedId('')
    }
  }, [])

  // ล็อกอิน
  async function login(e) {
    e?.preventDefault()

    setBusy(true)
    setStatus({ type: 'idle', message: '' })

    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username: loginUsername.trim(),
          password,
        }),
      })

      const pageIds = Array.isArray(data.accessiblePageIds)
        ? data.accessiblePageIds
        : []

      setPassword('')
      setAuthenticated(true)
      setCurrentUsername(data.username || loginUsername.trim())
      setIsAdmin(Boolean(data.isAdmin))
      setAccessiblePageIds(pageIds)
      setSelectedId(pageIds[0] || '')
      setPixelRows([])
      setCommitUrl('')

      setStatus({
        type: 'success',
        message: data.isAdmin
          ? 'เข้าสู่ระบบแอดมินสำเร็จ'
          : 'เข้าสู่ระบบสำเร็จ',
      })

      // ตรวจสอบสิทธิ์ล่าสุดจากเซิร์ฟเวอร์อีกครั้ง
      await refreshAuth()
    } catch (error) {
      setStatus({ type: 'error', message: error.message })
    } finally {
      setBusy(false)
    }
  }

  // ออกจากระบบ
  async function logout() {
    setBusy(true)

    try {
      await api('/api/logout', {
        method: 'POST',
        body: '{}',
      })
    } catch {
      // ล้างสถานะหน้าเว็บแม้ API logout มีปัญหา
    }

    setAuthenticated(false)
    setIsAdmin(false)
    setCurrentUsername('')
    setAccessiblePageIds([])
    setPixelRows([])
    setCommitUrl('')
    setSelectedId('')
    setLoginUsername('')
    setPassword('')
    setBusy(false)
    setStatus({ type: 'idle', message: 'ออกจากระบบแล้ว' })
  }

  // โหลด Pixel IDs จาก GitHub
  const loadCurrentPixelIds = useCallback(
    async (pageId = selectedId) => {
      if (!authenticated || !pageId) return

      // ป้องกันการโหลดหน้าเว็บที่ไม่ได้อยู่ในสิทธิ์ปัจจุบัน
      if (!accessiblePageIds.includes(pageId)) {
        setPixelRows([])
        setStatus({
          type: 'error',
          message: 'บัญชีของคุณไม่มีสิทธิ์เข้าถึงเซลเพจนี้',
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

        // รองรับทั้ง API รูปแบบเดิมที่ใช้ ids และรูปแบบ pixelIds
        const ids = Array.isArray(data.ids)
          ? data.ids
          : Array.isArray(data.pixelIds)
            ? data.pixelIds
            : []

        setPixelRows(
          ids.map((value, index) => ({
            key: `${Date.now()}-${index}-${Math.random()}`,
            value: String(value),
          }))
        )

        setStatus({
          type: 'success',
          message: `โหลด Pixel ID เดิม ${ids.length} รายการแล้ว`,
        })
      } catch (error) {
        setPixelRows([])
        setStatus({ type: 'error', message: error.message })
      } finally {
        setBusy(false)
      }
    },
    [authenticated, accessiblePageIds, selectedId]
  )

  // บันทึก Pixel IDs และ Commit กลับ GitHub
  async function commitPixel() {
    if (!selected || !accessiblePageIds.includes(selected.id)) {
      setStatus({
        type: 'error',
        message: 'กรุณาเลือกเซลเพจที่คุณมีสิทธิ์ใช้งาน',
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
        `/api/pages/${encodeURIComponent(selected.id)}/commit`,
        {
          method: 'POST',
          body: JSON.stringify({
            ids: desiredPixelIds,
            message: commitMessage,
          }),
        }
      )

      setCommitUrl(data.commitUrl || '')

      const syncedCount = Array.isArray(data.ids)
        ? data.ids.length
        : typeof data.ids === 'number'
          ? data.ids
          : desiredPixelIds.length

      setStatus({
        type: 'success',
        message: `Commit สำเร็จ ซิงก์ ${syncedCount} Pixel ID แล้ว`,
      })

      await loadCurrentPixelIds(selected.id)
    } catch (error) {
      setStatus({ type: 'error', message: error.message })
    } finally {
      setBusy(false)
    }
  }

  // ตรวจสอบเซสชันเมื่อเปิดเว็บ
  useEffect(() => {
    refreshAuth()
  }, [refreshAuth])

  // เลือกหน้าแรกที่ได้รับอนุญาตโดยอัตโนมัติ
  useEffect(() => {
    if (!authenticated || visiblePages.length === 0) {
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
  }, [authenticated, visiblePages, selectedId])

  // โหลดข้อมูลเมื่อเลือกเซลเพจที่มีสิทธิ์
  useEffect(() => {
    if (
      authenticated &&
      selectedId &&
      accessiblePageIds.includes(selectedId)
    ) {
      loadCurrentPixelIds(selectedId)
    }
  }, [
    authenticated,
    selectedId,
    accessiblePageIds,
    loadCurrentPixelIds,
  ])

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
                disabled={busy}
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
                    value={loginUsername}
                    onChange={(e) => setLoginUsername(e.target.value)}
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

                  {visiblePages.length > 0 ? (
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
                  ) : (
                    <div className="security-details">
                      บัญชีนี้ยังไม่ได้รับสิทธิ์เข้าถึงเซลเพจใด ๆ
                      กรุณาติดต่อ Admin
                    </div>
                  )}
                </div>

                {selected && (
                  <>
                    <div className="field-group">
                      <label>
                        รายการ Facebook Pixel ID{' '}
                        <span className="required">*</span>
                      </label>

                      <button
                        className="load-pixels-button"
                        type="button"
                        onClick={() => loadCurrentPixelIds(selected.id)}
                        disabled={busy}
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
                                disabled={busy}
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
                                  rows.filter(
                                    (item) => item.key !== row.key
                                  )
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
                      <label htmlFor="commit-message">
                        Commit message
                      </label>
                      <div className="input-wrap">
                        <GitCommitHorizontal size={17} />
                        <input
                          id="commit-message"
                          value={commitMessage}
                          onChange={(e) =>
                            setCommitMessage(e.target.value)
                          }
                          maxLength={120}
                          disabled={busy}
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
                        <ArrowUpRight
                          size={17}
                          className="button-arrow"
                        />
                      )}
                    </button>

                    <div className="button-note">
                      <LockKeyhole size={12} />
                      GitHub App ทำงานบนเซิร์ฟเวอร์ ไม่ใช้ Token ในหน้าเว็บ
                    </div>
                  </>
                )}
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

              <button
                className="load-pixels-button"
                type="button"
                onClick={() => setShowSecurity((value) => !value)}
              >
                <ShieldCheck size={14} />
                {showSecurity ? 'ซ่อนคำแนะนำความปลอดภัย' : 'คำแนะนำความปลอดภัย'}
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
                      GITHUB_INSTALLATION_ID, SESSION_SECRET และ
                      ADMIN_USERNAME บนเซิร์ฟเวอร์
                    </li>
                    <li>
                      กำหนด USER_1 ถึง USER_5 ทั้ง username และ password
                    </li>
                    <li>
                      กำหนด accessiblePageIds จาก Backend และตรวจสิทธิ์
                      ทุก API ที่อ่านหรือ Commit
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