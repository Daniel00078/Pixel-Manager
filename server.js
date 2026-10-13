import "dotenv/config";

import express from "express";
import session from "express-session";
import cors from "cors";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import SALES_PAGES from "./src/config.js";

const app = express();
const PORT = process.env.PORT || 3000;

const FRONTEND_URL = process.env.FRONTEND_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;

// ---------- App configuration ----------

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
    const configuredUsername = process.env[`USER_${slot}_USERNAME`];

    if (configuredUsername && configuredUsername === username) {
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

  // Admin สามารถเข้าถึงทุกเซลเพจ รวมถึง Pd
  if (isAdmin(req)) {
    return true;
  }

  // บัญชีทั่วไปเข้าเซลเพจที่เป็น Admin-only ไม่ได้
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
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error("ยังไม่ได้ตั้งค่า GITHUB_APP_PRIVATE_KEY");
  }

  // แปลงตัวอักษร \n ใน Environment Variable เป็น newline จริง
  return privateKey.replace(/\\n/g, "\n");
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

function normalizePixelIds(value) {
  const input = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[\n,\s]+/);

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

// ดึง Pixel IDs จากคำสั่ง fbq('init', 'PIXEL_ID')
function extractPixelIds(html) {
  const ids = new Set();

  const pattern =
    /fbq\s*\(\s*(['"])init\1\s*,\s*(['"])(\d+)\2\s*\)/g;

  let match;

  while ((match = pattern.exec(html)) !== null) {
    ids.add(match[3]);
  }

  return [...ids];
}

// เปลี่ยน Pixel IDs ในคำสั่ง fbq('init', '...')
function replacePixelIds(html, pixelIds) {
  const ids = normalizePixelIds(pixelIds);

  const marker =
    /fbq\s*\(\s*(['"])init\1\s*,\s*(['"])\d+\2\s*\)\s*;?/g;

  if (!marker.test(html)) {
    throw new Error(
      "ไม่พบคำสั่ง fbq('init', 'PIXEL_ID') ในไฟล์ HTML"
    );
  }

  marker.lastIndex = 0;

  let first = true;

  // แทนคำสั่ง init แรกด้วยรายการ ID ใหม่
  // และลบคำสั่ง init เดิมที่เหลือ
  const output = html.replace(marker, () => {
    if (!first) {
      return "";
    }

    first = false;

    return ids
      .map((id) => `fbq('init', '${id}');`)
      .join("\n");
  });

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
  const username = String(req.body?.username || "").trim();
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
    if (err) {
      return next(err);
    }

    req.session.authenticated = true;
    req.session.username = username;

    req.session.save((saveErr) => {
      if (saveErr) {
        return next(saveErr);
      }

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
    if (err) {
      return next(err);
    }

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

      // รองรับทั้ง pixelIds และ ids จากหน้าเว็บ
      const submittedIds = req.body?.pixelIds ?? req.body?.ids;
      const pixelIds = normalizePixelIds(submittedIds);

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

      const commitMessage = String(
        req.body?.message || `Update Facebook Pixel IDs for ${page.name}`
      ).trim();

      const result = await octokit.repos.createOrUpdateFileContents({
        owner: page.owner,
        repo: page.repo,
        path: page.path,
        branch: page.branch,
        sha: current.data.sha,
        message: commitMessage || `Update Facebook Pixel IDs for ${page.name}`,
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

// ---------- Start server ----------

app.listen(PORT, () => {
  console.log(`Pixel Manager API listening on port ${PORT}`);
});
