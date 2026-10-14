import 'dotenv/config';

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import session from 'express-session';
import helmet from 'helmet';
import { App as GitHubApp } from '@octokit/app';

import { SALES_PAGES } from './src/config.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, 'dist');

const PORT = Number(process.env.PORT || 3001);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_COOKIE = 'pixel_manager_session';

app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '1mb' }));

// --------------------------------------------------
// 1. Users and configuration
// --------------------------------------------------

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim();

const USERS = Array.from({ length: 5 }, (_, index) => {
  const number = index + 1;

  return {
    username: (process.env[`USER_${number}_USERNAME`] || '').trim(),
    password: process.env[`USER_${number}_PASSWORD`] || '',
  };
}).filter((user) => user.username && user.password);

const getUser = (username) =>
  USERS.find((user) => user.username === username);

function isConfigured() {
  return Boolean(
    process.env.SESSION_SECRET &&
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY &&
    process.env.GITHUB_INSTALLATION_ID &&
    ADMIN_USERNAME &&
    getUser(ADMIN_USERNAME) &&
    USERS.length > 0
  );
}

// --------------------------------------------------
// 2. Session
// --------------------------------------------------

app.use(
  session({
    name: SESSION_COOKIE,
    secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PRODUCTION,
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);

// --------------------------------------------------
// 3. GitHub App
// --------------------------------------------------

let githubApp = null;

function getGitHubApp() {
  if (!isConfigured()) {
    throw new Error('Server configuration is incomplete. Check environment variables.');
  }

  if (!githubApp) {
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');

    githubApp = new GitHubApp({
      appId: process.env.GITHUB_APP_ID,
      privateKey,
    });
  }

  return githubApp;
}

async function getInstallationOctokit() {
  const installationId = Number(process.env.GITHUB_INSTALLATION_ID);

  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error('GITHUB_INSTALLATION_ID is invalid.');
  }

  return getGitHubApp().getInstallationOctokit(installationId);
}

// --------------------------------------------------
// 4. Authentication and page permissions
// --------------------------------------------------

function requireAuth(req, res, next) {
  if (!req.session?.authenticated || !req.session?.username) {
    return res.status(401).json({
      error: 'กรุณาเข้าสู่ระบบก่อน',
      code: 'UNAUTHENTICATED',
    });
  }

  next();
}

function isAdmin(req) {
  return Boolean(
    req.session?.authenticated &&
    req.session?.username === ADMIN_USERNAME
  );
}

function canAccessPage(username, page) {
  if (username === ADMIN_USERNAME) {
    return true;
  }

  if (page.adminOnly) {
    return false;
  }

  return (
    Array.isArray(page.assignedTo) &&
    page.assignedTo.includes(username)
  );
}

function availablePages(username) {
  return SALES_PAGES.filter((page) =>
    canAccessPage(username, page)
  );
}

function findPage(pageId) {
  return SALES_PAGES.find((page) => page.id === pageId);
}

function requirePageAccess(req, res, next) {
  const page = findPage(req.params.id);

  if (!page) {
    return res.status(404).json({
      error: 'ไม่พบเซลเพจนี้',
      code: 'PAGE_NOT_FOUND',
    });
  }

  if (!canAccessPage(req.session.username, page)) {
    return res.status(403).json({
      error: 'คุณไม่มีสิทธิ์เข้าถึงเซลเพจนี้',
      code: 'FORBIDDEN',
    });
  }

  if (
    !page.owner ||
    !page.repo ||
    !page.branch ||
    !page.path ||
    [page.owner, page.repo, page.branch, page.path].some(
      (value) => String(value).startsWith('YOUR_')
    )
  ) {
    return res.status(500).json({
      error: 'ข้อมูล GitHub ของเซลเพจยังตั้งค่าไม่ครบ',
      code: 'PAGE_CONFIG_INCOMPLETE',
    });
  }

  req.salesPage = page;
  next();
}

// --------------------------------------------------
// 5. Helpers for reading and updating Pixel IDs
// --------------------------------------------------

function decodeGitHubFile(content) {
  return Buffer.from(content, 'base64').toString('utf8');
}

function extractPixelIds(html) {
  const ids = [];
  const pattern =
    /\bfbq\s*\(\s*['"]init['"]\s*,\s*['"](\d+)['"]\s*\)/g;

  let match;

  while ((match = pattern.exec(html)) !== null) {
    ids.push(match[1]);
  }

  return ids;
}

function normalizePixelIds(value) {
  const rawIds = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,;]+/)
      : null;

  if (!rawIds) {
    throw new Error('กรุณาส่ง Pixel ID เป็นรายการ');
  }

  const ids = rawIds.map((id) => String(id).trim());

  if (ids.some((id) => !/^\d{1,30}$/.test(id))) {
    throw new Error('Pixel ID ต้องเป็นตัวเลขเท่านั้น');
  }

  return ids;
}

function replacePixelIds(html, newIds) {
  let index = 0;

  const updatedHtml = html.replace(
    /(\bfbq\s*\(\s*['"]init['"]\s*,\s*['"])\d+(['"]\s*\))/g,
    (fullMatch, before, after) => {
      if (index >= newIds.length) {
        return fullMatch;
      }

      const replacement = `${before}${newIds[index]}${after}`;
      index += 1;

      return replacement;
    }
  );

  if (index !== newIds.length) {
    throw new Error(
      `จำนวน Pixel ID ใหม่ (${newIds.length}) ไม่ตรงกับตำแหน่งที่พบในไฟล์ (${index})`
    );
  }

  return updatedHtml;
}

async function readPageFile(page) {
  const octokit = await getInstallationOctokit();

  const response = await octokit.request(
    'GET /repos/{owner}/{repo}/contents/{path}',
    {
      owner: page.owner,
      repo: page.repo,
      path: page.path,
      ref: page.branch,
    }
  );

  if (Array.isArray(response.data) || response.data.type !== 'file') {
    throw new Error('ตำแหน่งที่กำหนดใน GitHub ไม่ใช่ไฟล์');
  }

  return {
    html: decodeGitHubFile(response.data.content),
    sha: response.data.sha,
  };
}

// --------------------------------------------------
// 6. API: Status
// --------------------------------------------------

app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');

  return res.json({
    configured: isConfigured(),
    authenticated: Boolean(
      req.session?.authenticated && req.session?.username
    ),
    username: req.session?.username || null,
    isAdmin: isAdmin(req),
  });
});

// --------------------------------------------------
// 7. API: Login
// --------------------------------------------------

app.post('/api/login', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (!isConfigured()) {
    return res.status(500).json({
      error: 'การตั้งค่าเซิร์ฟเวอร์ไม่ครบ กรุณาตรวจสอบไฟล์ .env',
      code: 'SERVER_NOT_CONFIGURED',
    });
  }

  const username =
    typeof req.body?.username === 'string'
      ? req.body.username.trim()
      : '';

  const password =
    typeof req.body?.password === 'string'
      ? req.body.password
      : '';

  const user = getUser(username);

  if (!user || user.password !== password) {
    return res.status(401).json({
      error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
      code: 'INVALID_CREDENTIALS',
    });
  }

  req.session.regenerate((error) => {
    if (error) {
      console.error('Session regeneration failed:', error);

      return res.status(500).json({
        error: 'ไม่สามารถสร้างเซสชันได้',
      });
    }

    req.session.authenticated = true;
    req.session.username = user.username;

    req.session.save((saveError) => {
      if (saveError) {
        console.error('Session save failed:', saveError);

        return res.status(500).json({
          error: 'ไม่สามารถบันทึกเซสชันได้',
        });
      }

      return res.json({
        ok: true,
        username: user.username,
        isAdmin: user.username === ADMIN_USERNAME,
      });
    });
  });
});

// --------------------------------------------------
// 8. API: Logout
// --------------------------------------------------

app.post('/api/logout', (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (!req.session) {
    return res.json({ ok: true });
  }

  req.session.destroy((error) => {
    if (error) {
      console.error('Session destroy failed:', error);

      return res.status(500).json({
        error: 'ออกจากระบบไม่สำเร็จ',
      });
    }

    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PRODUCTION,
    });

    return res.json({ ok: true });
  });
});

// --------------------------------------------------
// 9. API: List pages
// IMPORTANT: This route must be before the frontend fallback.
// --------------------------------------------------

app.get('/api/pages', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');

  const username = req.session.username;

  const pages = availablePages(username).map((page) => ({
    id: page.id,
    name: page.name,
    description: page.description || '',
    branch: page.branch,
    path: page.path,
  }));

  return res.status(200).json({ pages });
});

// --------------------------------------------------
// 10. API: Read Pixel IDs from a page
// --------------------------------------------------

app.get(
  '/api/pages/:id',
  requireAuth,
  requirePageAccess,
  async (req, res) => {
    res.set('Cache-Control', 'no-store');

    try {
      const { html, sha } = await readPageFile(req.salesPage);

      return res.json({
        ids: extractPixelIds(html),
        sha,
      });
    } catch (error) {
      console.error('Read page failed:', error);

      return res.status(502).json({
        error: 'อ่านไฟล์จาก GitHub ไม่สำเร็จ',
        details: error.message,
      });
    }
  }
);

// --------------------------------------------------
// 11. API: Save Pixel IDs to GitHub
// --------------------------------------------------

app.post(
  '/api/pages/:id/commit',
  requireAuth,
  requirePageAccess,
  async (req, res) => {
    res.set('Cache-Control', 'no-store');

    try {
      const suppliedIds = req.body?.ids ?? req.body?.pixelIds;
      const newIds = normalizePixelIds(suppliedIds);

      const page = req.salesPage;
      const { html, sha } = await readPageFile(page);
      const oldIds = extractPixelIds(html);

      if (oldIds.length !== newIds.length) {
        return res.status(400).json({
          error: `จำนวน Pixel ID ใหม่ต้องเท่ากับจำนวนเดิม (${oldIds.length})`,
          existingCount: oldIds.length,
          receivedCount: newIds.length,
        });
      }

      const updatedHtml = replacePixelIds(html, newIds);
      const octokit = await getInstallationOctokit();

      const response = await octokit.request(
        'PUT /repos/{owner}/{repo}/contents/{path}',
        {
          owner: page.owner,
          repo: page.repo,
          path: page.path,
          branch: page.branch,
          message: `Update Facebook Pixel IDs for ${page.name || page.id}`,
          content: Buffer.from(updatedHtml, 'utf8').toString('base64'),
          sha,
        }
      );

      return res.json({
        ok: true,
        ids: newIds,
        commit: response.data.commit?.sha || null,
        url: response.data.commit?.html_url || null,
      });
    } catch (error) {
      console.error('Commit page failed:', error);

      return res.status(500).json({
        error: 'บันทึก Pixel ID ไปยัง GitHub ไม่สำเร็จ',
        details: error.message,
      });
    }
  }
);

// --------------------------------------------------
// 12. Unknown API endpoints must return JSON, not HTML.
// This must be before express.static and the frontend fallback.
// --------------------------------------------------

app.use('/api', (req, res) => {
  res.set('Cache-Control', 'no-store');

  return res.status(404).json({
    error: 'ไม่พบ API endpoint',
    path: req.originalUrl,
  });
});

// --------------------------------------------------
// 13. Frontend static files
// --------------------------------------------------

app.use(express.static(distPath));

// --------------------------------------------------
// 14. Frontend fallback
// Do not use this to handle /api requests.
// --------------------------------------------------

app.get(/.*/, (req, res, next) => {
  res.sendFile(path.join(distPath, 'index.html'), (error) => {
    if (error) {
      next(error);
    }
  });
});

// --------------------------------------------------
// 15. Error handler
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error('Unhandled server error:', error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    error: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์',
  });
});

// --------------------------------------------------
// 16. Start server
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`Pixel Control listening on http://localhost:${PORT}`);
  console.log(`Environment configured: ${isConfigured()}`);
});