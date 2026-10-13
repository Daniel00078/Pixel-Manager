require("dotenv").config();

const express = require("express");
const session = require("express-session");
const cors = require("cors");
const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");
const SALES_PAGES = require("./src/config").default;

const app = express();
const PORT = process.env.PORT || 3000;

const FRONTEND_URL = process.env.FRONTEND_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);

app.use(
  session({
    name: "pixel_manager_session",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);

// ---------- Accounts ----------

function getAccountSlot(username) {
  for (let slot = 1; slot <= 5; slot++) {
    if (
      process.env[`USER_${slot}_USERNAME`] &&
      process.env[`USER_${slot}_USERNAME`] === username
    ) {
      return slot;
    }
  }

  return null;
}

function isAuthenticated(req) {
  return Boolean(
    req.session &&
    req.session.authenticated &&
    req.session.username
  );
}

function isAdmin(req) {
  return Boolean(
    isAuthenticated(req) &&
    process.env.ADMIN_USERNAME &&
    req.session.username === process.env.ADMIN_USERNAME
  );
}

function pageById(id) {
  return SALES_PAGES.find((page) => page.id === id);
}

function canAccessPage(req, page) {
  if (!isAuthenticated(req) || !page) {
    return false;
  }

  // Admin เข้าได้ทุกเซลเพจ รวมถึง Pd
  if (isAdmin(req)) {
    return true;
  }

  // ห้ามบัญชีทั่วไปเข้าเซลเพจที่กำหนดเป็น Admin-only
  if (page.adminOnly) {
    return false;
  }

  const slot = getAccountSlot(req.session.username);

  return Boolean(
    slot &&
    Array.isArray(page.allowedUserSlots) &&
    page.allowedUserSlots.includes(slot)
  );
}

function accessiblePageIds(req) {
  if (!isAuthenticated(req)) {
    return [];
  }

  return SALES_PAGES
    .filter((page) => canAccessPage(req, page))
    .map((page) => page.id);
}

// ---------- Authentication middleware ----------

function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({
      error: "กรุณาเข้าสู่ระบบก่อน",
    });
  }

  next();
}

function requirePageAccess(req, res, next) {
  const page = pageById(req.params.id);

  if (!page) {
    return res.status(404).json({
      error: "ไม่พบเซลเพจนี้",
    });
  }

  if (!canAccessPage(req, page)) {
    return res.status(403).json({
      error: "บัญชีของคุณไม่มีสิทธิ์เข้าถึงเซลเพจนี้",
    });
  }

  req.salesPage = page;
  next();
}

// ---------- GitHub App ----------

function validateGitHubConfig() {
  return Boolean(
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY &&
    process.env.GITHUB_INSTALLATION_ID
  );
}

function getPrivateKey() {
  return process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
}

async function getGitHubClient() {
  if (!validateGitHubConfig()) {
    throw new Error("ยังตั้งค่า GitHub App ไม่ครบ");
  }

  const auth = createAppAuth({
    appId: process.env.GITHUB_APP_ID,
    privateKey: getPrivateKey(),
    installationId: process.env.GITHUB_INSTALLATION_ID,
  });

  const installationAuth = await auth({
    type: "installation",
  });

  return new Octokit({
    auth: installationAuth.token,
  });
}

// ---------- Pixel ID helpers ----------

// รองรับ ID ที่ส่งมาเป็น string หรือ array
function normalizePixelIds(value) {
  const input = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,\s]+/);

  const ids = input
    .map((item) => String(item).trim())
    .filter(Boolean);

  for (const id of ids) {
    if (!/^\d+$/.test(id)) {
      throw new Error(`Pixel ID ไม่ถูกต้อง: ${id}`);
    }
  }

  return [...new Set(ids)];
}

// ดึง Pixel IDs จากโค้ด Facebook Pixel ที่พบใน HTML
function extractPixelIds(html) {
  const ids = new Set();

  const patterns = [
    /fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d+)['"]/g,
    /_fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d+)['"]/g,
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(html)) !== null) {
      ids.add(match[1]);
    }
  }

  return [...ids];
}

// เปลี่ยน Pixel IDs ในคำสั่ง fbq('init', '...')
function replacePixelIds(html, pixelIds) {
  const ids = normalizePixelIds(pixelIds);

  const marker = /fbq\s*\(\s*(['"])init\1\s*,\s*(['"])\d+\2\s*\)\s*;/g;

  if (!marker.test(html)) {
    throw new Error(
      "ไม่พบคำสั่ง fbq('init', 'PIXEL_ID') ในไฟล์ HTML"
    );
  }

  marker.lastIndex = 0;

  let first = true;

  // คงตำแหน่งคำสั่งแรกไว้ และลบคำสั่ง init เดิมที่เหลือ
  // จากนั้นสร้างคำสั่ง init เพิ่มสำหรับ ID ที่เหลือ
  let output = html.replace(marker, () => {
    if (first && ids.length > 0) {
      first = false;
      return `fbq('init', '${ids[0]}');`;
    }

    return "";
  });

  if (ids.length > 1) {
    const firstInit = `fbq('init', '${ids[0]}');`;
    const extraInits = ids
      .slice(1)
      .map((id) => `fbq('init', '${id}');`)
      .join("\n");

    output = output.replace(
      firstInit,
      `${firstInit}\n${extraInits}`
    );
  }

  if (ids.length === 0) {
    output = output.replace(
      /fbq\s*\(\s*(['"])init\1\s*,\s*(['"])\d+\2\s*\)\s*;/g,
      ""
    );
  }

  return output;
}

// ---------- API: status ----------

app.get("/api/status", (req, res) => {
  res.json({
    configured: validateGitHubConfig(),
    authenticated: isAuthenticated(req),
    username: isAuthenticated(req) ? req.session.username : null,
    isAdmin: isAdmin(req),
    accessiblePageIds: accessiblePageIds(req),
  });
});

// ---------- API: login ----------

app.post("/api/login", (req, res, next) => {
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");

  if (!username || !password) {
    return res.status(400).json({
      error: "กรุณากรอกชื่อบัญชีและรหัสผ่าน",
    });
  }

  let valid = false;

  for (let slot = 1; slot <= 5; slot++) {
    const expectedUsername = process.env[`USER_${slot}_USERNAME`];
    const expectedPassword = process.env[`USER_${slot}_PASSWORD`];

    if (
      expectedUsername &&
      expectedPassword &&
      username === expectedUsername &&
      password === expectedPassword
    ) {
      valid = true;
      break;
    }
  }

  if (!valid) {
    return res.status(401).json({
      error: "ชื่อบัญชีหรือรหัสผ่านไม่ถูกต้อง",
    });
  }

  req.session.regenerate((err) => {
    if (err) return next(err);

    req.session.authenticated = true;
    req.session.username = username;

    req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);

      res.json({
        success: true,
        username,
        isAdmin: isAdmin(req),
        accessiblePageIds: accessiblePageIds(req),
      });
    });
  });
});

// ---------- API: logout ----------

app.post("/api/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);

    res.clearCookie("pixel_manager_session", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
    });

    res.json({ success: true });
  });
});

// ---------- API: read Pixel IDs ----------

app.get(
  "/api/pages/:id",
  requireAuth,
  requirePageAccess,
  async (req, res, next) => {
    try {
      const page = req.salesPage;
      const octokit = await getGitHubClient();

      const response = await octokit.repos.getContent({
        owner: page.owner,
        repo: page.repo,
        path: page.path,
        ref: page.branch,
      });

      if (Array.isArray(response.data) || !response.data.content) {
        return res.status(400).json({
          error: "พาธนี้ไม่ได้ชี้ไปยังไฟล์ HTML",
        });
      }

      const html = Buffer.from(
        response.data.content,
        "base64"
      ).toString("utf8");

      res.json({
        id: page.id,
        name: page.name,
        pixelIds: extractPixelIds(html),
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------- API: commit Pixel IDs ----------

app.post(
  "/api/pages/:id/commit",
  requireAuth,
  requirePageAccess,
  async (req, res, next) => {
    try {
      const page = req.salesPage;
      const pixelIds = normalizePixelIds(req.body?.pixelIds);

      if (pixelIds.length === 0) {
        return res.status(400).json({
          error: "กรุณาระบุ Pixel ID อย่างน้อยหนึ่งรายการ",
        });
      }

      const octokit = await getGitHubClient();

      const current = await octokit.repos.getContent({
        owner: page.owner,
        repo: page.repo,
        path: page.path,
        ref: page.branch,
      });

      if (Array.isArray(current.data) || !current.data.content) {
        return res.status(400).json({
          error: "พาธนี้ไม่ได้ชี้ไปยังไฟล์ HTML",
        });
      }

      const oldHtml = Buffer.from(
        current.data.content,
        "base64"
      ).toString("utf8");

      const newHtml = replacePixelIds(oldHtml, pixelIds);

      if (newHtml === oldHtml) {
        return res.json({
          success: true,
          message: "ไม่มีการเปลี่ยนแปลง",
          pixelIds,
        });
      }

      const result = await octokit.repos.createOrUpdateFileContents({
        owner: page.owner,
        repo: page.repo,
        path: page.path,
        branch: page.branch,
        sha: current.data.sha,
        message: `Update Facebook Pixel IDs for ${page.name}`,
        content: Buffer.from(newHtml, "utf8").toString("base64"),
      });

      res.json({
        success: true,
        message: "Commit สำเร็จ",
        commitUrl: result.data.commit.html_url,
        pixelIds,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------- Error handler ----------

app.use((err, req, res, next) => {
  console.error("API error:", err.message);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    error: "เกิดข้อผิดพลาดในระบบ กรุณาตรวจสอบการตั้งค่า Backend",
  });
});

app.listen(PORT, () => {
  console.log(`Pixel Manager API listening on port ${PORT}`);
});