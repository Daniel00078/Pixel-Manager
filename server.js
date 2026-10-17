
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
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim();

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));

// --------------------------------------------------
// Users and configuration
// --------------------------------------------------

const USERS = Array.from({ length: 5 }, (_, index) => {
  const n = index + 1;
  return {
    username: (process.env[`USER_${n}_USERNAME`] || '').trim(),
    password: process.env[`USER_${n}_PASSWORD`] || '',
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
    getUser(ADMIN_USERNAME) &&
    USERS.length > 0
  );
}

// --------------------------------------------------
// Session
// --------------------------------------------------

app.set('trust proxy', 1);

app.use(
  session({
    name: SESSION_COOKIE,
    secret:
      process.env.SESSION_SECRET ||
      'development-only-change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: IS_PRODUCTION ? 'none' : 'lax',
      secure: IS_PRODUCTION,
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);

// --------------------------------------------------
// GitHub App
// --------------------------------------------------

let githubApp;

function getGitHubApp() {
  if (!isConfigured()) {
    throw new Error(
      'Server configuration incomplete. Check environment variables.'
    );
  }

  if (!githubApp) {
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY.replace(
      /\\n/g,
      '\n'
    );

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
// Authentication and permissions
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
  if (username === ADMIN_USERNAME) return true;
  if (page.adminOnly) return false;

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

function requirePageAccess(req, res, next) {
  const page = SALES_PAGES.find(
    (item) => item.id === req.params.id
  );

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
// Pixel ID helpers
// --------------------------------------------------

function decodeGitHubFile(content) {
  return Buffer.from(content, 'base64').toString('utf8');
}

function extractPixelIds(html) {
  const ids = [];
  const pattern =
    /\bfbq\s*\(\s*(['"])init\1\s*,\s*(['"])(\d+)\2\s*\)/g;

  let match;
  while ((match = pattern.exec(html)) !== null) {
    ids.push(match[3]);
  }

  return ids;
}

function normalizePixelIds(value) {
  if (!Array.isArray(value)) {
    throw new Error('กรุณาส่ง Pixel ID ในรูปแบบรายการ');
  }

  const ids = value.map((item) => String(item).trim());

  if (ids.length === 0) {
    throw new Error('ต้องมี Pixel ID อย่างน้อย 1 รายการ');
  }

  if (ids.some((id) => !/^\d{5,25}$/.test(id))) {
    throw new Error('Pixel ID ต้องเป็นตัวเลข 5–25 หลัก');
  }

  if (new Set(ids).size !== ids.length) {
    throw new Error('Pixel ID ห้ามซ้ำกัน');
  }

  return ids;
}

/**
 * Replace all fbq init calls with the new list.
 * Supports increasing or decreasing the number of IDs.
 */
function replaceInitIds(html, newIds) {
  const pattern =
    /\bfbq\s*\(\s*(['"])init\1\s*,\s*(['"])\d+\2\s*\)\s*;?/g;

  const matches = [...html.matchAll(pattern)];

  if (matches.length === 0) {
    throw new Error(
      'ไม่พบ fbq init ใน index.html จึงไม่สามารถแก้ Pixel ID ได้'
    );
  }

  const first = matches[0];
  const quote = first[1];
  const indent =
    html.slice(0, first.index).match(/(?:^|\n)([ \t]*)[^\n]*$/)?.[1] ||
    '    ';

  const replacement = newIds
    .map((id) => `fbq(${quote}init${quote}, ${quote}${id}${quote});`)
    .join('\n' + indent);

  let output = '';
  let cursor = 0;

  matches.forEach((match, index) => {
    output += html.slice(cursor, match.index);

    if (index === 0) {
      output += replacement;
    }

    cursor = match.index + match[0].length;
  });

  output += html.slice(cursor);
  return output;
}

/**
 * Replace the noscript tracking images so their IDs match fbq init.
 * Clones the existing image markup to preserve its query parameters.
 */
function replaceNoscriptIds(html, newIds) {
  const imgPattern =
    /<img\b(?=[^>]*\bsrc\s*=\s*["'][^"']*facebook\.com\/tr\?[^"']*["'])[^>]*\/?>/gi;

  const matches = [...html.matchAll(imgPattern)];

  if (matches.length === 0) {
    throw new Error(
      'ไม่พบ Facebook Pixel noscript image ใน index.html'
    );
  }

  const firstImage = matches[0][0];

  if (!/[?&]id=\d+/.test(firstImage)) {
    throw new Error(
      'ไม่พบพารามิเตอร์ id ใน noscript image'
    );
  }

  const replacement = newIds
    .map((id) =>
      firstImage.replace(
        /([?&]id=)\d+/,
        (_, prefix) => `${prefix}${id}`
      )
    )
    .join('\n');

  let output = '';
  let cursor = 0;

  matches.forEach((match, index) => {
    output += html.slice(cursor, match.index);

    if (index === 0) {
      output += replacement;
    }

    cursor = match.index + match[0].length;
  });

  output += html.slice(cursor);
  return output;
}

function rewritePixelIds(html, newIds) {
  let updated = replaceInitIds(html, newIds);
  updated = replaceNoscriptIds(updated, newIds);

  const finalIds = extractPixelIds(updated);

  if (
    finalIds.length !== newIds.length ||
    finalIds.some((id, index) => id !== newIds[index])
  ) {
    throw new Error('ตรวจสอบ Pixel ID หลังแก้ไขไม่ผ่าน');
  }

  const noscriptIds = [
    ...updated.matchAll(
      /<img\b(?=[^>]*\bsrc\s*=\s*["'][^"']*facebook\.com\/tr\?[^"']*["'])[^>]*>/gi
    ),
  ].map((match) => {
    const id = match[0].match(/[?&]id=(\d+)/);
    return id?.[1] || '';
  });

  if (
    noscriptIds.length !== newIds.length ||
    noscriptIds.some((id, index) => id !== newIds[index])
  ) {
    throw new Error(
      'Pixel ID ใน noscript ไม่ตรงกับ fbq init หลังแก้ไข'
    );
  }

  return updated;
}

// --------------------------------------------------
// GitHub file helpers
// --------------------------------------------------

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

  if (
    Array.isArray(response.data) ||
    response.data.type !== 'file' ||
    !response.data.content
  ) {
    throw new Error(
      'ไม่พบไฟล์หรืออ่านเนื้อหาไฟล์จาก GitHub ไม่ได้'
    );
  }

  return {
    html: decodeGitHubFile(response.data.content),
    sha: response.data.sha,
  };
}

// --------------------------------------------------
// API: status
// --------------------------------------------------

app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.json({
    configured: isConfigured(),
    authenticated: Boolean(
      req.session?.authenticated && req.session?.username
    ),
    username: req.session?.username || null,
    isAdmin: isAdmin(req),
  });
});

// --------------------------------------------------
// API: login
// --------------------------------------------------

app.post('/api/login', (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (!isConfigured()) {
    return res.status(500).json({
      error: 'การตั้งค่าเซิร์ฟเวอร์ไม่ครบ กรุณาตรวจสอบ Environment Variables',
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
    });
  }

  req.session.regenerate((error) => {
    if (error) {
      console.error('Session regenerate error:', error);
      return res.status(500).json({
        error: 'สร้างเซสชันไม่สำเร็จ',
      });
    }

    req.session.authenticated = true;
    req.session.username = user.username;

    req.session.save((saveError) => {
      if (saveError) {
        console.error('Session save error:', saveError);
        return res.status(500).json({
          error: 'บันทึกเซสชันไม่สำเร็จ',
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
// API: logout
// --------------------------------------------------

app.post('/api/logout', (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (!req.session) {
    return res.json({ ok: true });
  }

  req.session.destroy((error) => {
    if (error) {
      console.error('Session destroy error:', error);
      return res.status(500).json({
        error: 'ออกจากระบบไม่สำเร็จ',
      });
    }

    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: IS_PRODUCTION ? 'none' : 'lax',
      secure: IS_PRODUCTION,
    });

    return res.json({ ok: true });
  });
});

// --------------------------------------------------
// API: list pages
// --------------------------------------------------

app.get('/api/pages', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');

  const pages = availablePages(req.session.username).map((page) => ({
    id: page.id,
    name: page.name,
    description: page.description || '',
    branch: page.branch,
    path: page.path,
  }));

  return res.json({ pages });
});

// --------------------------------------------------
// API: read Pixel IDs
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
      console.error('Read page error:', error);

      return res.status(502).json({
        error: 'อ่านไฟล์จาก GitHub ไม่สำเร็จ',
        details: error.message,
      });
    }
  }
);

// --------------------------------------------------
// API: commit Pixel IDs
// --------------------------------------------------

app.post(
  '/api/pages/:id/commit',
  requireAuth,
  requirePageAccess,
  async (req, res) => {
    res.set('Cache-Control', 'no-store');

    try {
      const newIds = normalizePixelIds(req.body?.ids);
      const page = req.salesPage;

      const { html, sha } = await readPageFile(page);
      const updatedHtml = rewritePixelIds(html, newIds);

      const octokit = await getInstallationOctokit();

      const message =
        typeof req.body?.message === 'string' &&
        req.body.message.trim()
          ? req.body.message.trim().slice(0, 120)
          : `Update Facebook Pixel IDs for ${page.name || page.id}`;

      const response = await octokit.request(
        'PUT /repos/{owner}/{repo}/contents/{path}',
        {
          owner: page.owner,
          repo: page.repo,
          path: page.path,
          branch: page.branch,
          message,
          content: Buffer.from(updatedHtml, 'utf8').toString('base64'),
          sha,
        }
      );

      const commitUrl =
        response.data.commit?.html_url ||
        response.data.content?.html_url ||
        '';

      return res.json({
        ok: true,
        ids: newIds,
        commit: response.data.commit?.sha || null,
        commitUrl,
        url: commitUrl,
      });
    } catch (error) {
      console.error('Commit Pixel IDs error:', error);

      return res.status(500).json({
        error: error.message || 'บันทึก Pixel ID ไปยัง GitHub ไม่สำเร็จ',
      });
    }
  }
);

// --------------------------------------------------
// Unknown API routes return JSON, never index.html
// --------------------------------------------------

app.use('/api', (req, res) => {
  res.set('Cache-Control', 'no-store');

  return res.status(404).json({
    error: 'ไม่พบ API endpoint',
    path: req.originalUrl,
  });
});

// --------------------------------------------------
// Frontend
// --------------------------------------------------

app.use(express.static(distPath));

app.get(/.*/, (req, res, next) => {
  res.sendFile(path.join(distPath, 'index.html'), (error) => {
    if (error) next(error);
  });
});

// --------------------------------------------------
// Error handler
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error('Unhandled server error:', error);

  if (res.headersSent) return next(error);

  return res.status(500).json({
    error: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์',
  });
});

// --------------------------------------------------
// Start
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`Pixel Control listening on port ${PORT}`);
  console.log(`Server configured: ${isConfigured()}`);
});
