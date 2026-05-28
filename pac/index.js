const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcrypt");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const pool = require("./db");
const cameras = require("./cameras.json");

const router = express.Router();
const PORT = process.env.PORT || 8081;
const hlsPath = path.join(__dirname, "hls");
const ffmpegCommand = process.env.FFMPEG_PATH || "ffmpeg";
const streamStatus = new Map();
let streamsStarted = false;

if (!fs.existsSync(hlsPath)) {
  fs.mkdirSync(hlsPath, { recursive: true });
}

router.use(express.urlencoded({ extended: true }));
router.use(express.json());

router.use(
  session({
    store: new pgSession({
      pool,
      tableName: "session"
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: "pac.sid",
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000
    }
  })
);

async function saveAccessLog(userId, action, details, req) {
  try {
    await pool.query(
      `
      INSERT INTO access_logs (user_id, action, details, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [
        userId || null,
        action,
        details || null,
        req.ip || null,
        req.headers["user-agent"] || null
      ]
    );
  } catch (error) {
    console.error("Erro ao salvar log:", error.message);
  }
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }

  return res.redirect("/pac/login");
}

function normalizeRtspUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);

    if (!parsed.username && !parsed.password) {
      return rawUrl;
    }

    parsed.username = decodeURIComponent(parsed.username);
    parsed.password = decodeURIComponent(parsed.password);

    return parsed.toString();
  } catch (error) {
    console.error(`URL RTSP invalida: ${rawUrl}`, error.message);
    return rawUrl;
  }
}

function startStream(cam) {
  const camPath = path.join(hlsPath, cam.id);
  const rtspUrl = normalizeRtspUrl(cam.url);

  if (!fs.existsSync(camPath)) {
    fs.mkdirSync(camPath, { recursive: true });
  }

  streamStatus.set(cam.id, {
    state: "starting",
    message: "Inicializando stream",
    updatedAt: new Date().toISOString()
  });

  function run() {
    const ffmpeg = spawn(ffmpegCommand, [
      "-rtsp_transport", "tcp",
      "-fflags", "nobuffer",
      "-max_delay", "500000",
      "-i", rtspUrl,
      "-an",
      "-c:v", "copy",
      "-f", "hls",
      "-hls_time", "15",
      "-hls_list_size", "5",
      "-hls_flags", "delete_segments+append_list+omit_endlist",
      "-hls_segment_filename", path.join(camPath, "seg_%03d.ts"),
      path.join(camPath, "playlist.m3u8")
    ]);

    ffmpeg.stderr.on("data", (data) => {
      const message = data.toString().trim();
      console.log(`[pac:${cam.id}] ${message}`);
      streamStatus.set(cam.id, {
        state: "running",
        message,
        updatedAt: new Date().toISOString()
      });
    });

    ffmpeg.on("exit", (code) => {
      console.log(`[pac:${cam.id}] ffmpeg saiu com codigo ${code}. Reiniciando em 5s...`);
      streamStatus.set(cam.id, {
        state: "restarting",
        message: `ffmpeg saiu com codigo ${code}. Reiniciando em 5s...`,
        updatedAt: new Date().toISOString()
      });
      setTimeout(run, 5000);
    });

    ffmpeg.on("error", (error) => {
      console.error(`[pac:${cam.id}] erro ao iniciar ffmpeg:`, error);
      streamStatus.set(cam.id, {
        state: "error",
        message: error.code === "ENOENT"
          ? "ffmpeg nao encontrado. Configure FFMPEG_PATH ou adicione o ffmpeg ao PATH."
          : error.message,
        updatedAt: new Date().toISOString()
      });
      setTimeout(run, 5000);
    });
  }

  run();
}

function startStreamsOnce() {
  if (streamsStarted) return;
  streamsStarted = true;

  cameras.forEach((cam, i) => {
    setTimeout(() => startStream(cam), i * 2000);
  });
}

setInterval(() => {
  cameras.forEach((cam) => {
    const camPath = path.join(hlsPath, cam.id);

    fs.readdir(camPath, (err, files) => {
      if (err) return;

      files.forEach((file) => {
        const filePath = path.join(camPath, file);

        fs.stat(filePath, (err, stats) => {
          if (!err && Date.now() - stats.mtimeMs > 10 * 60 * 1000) {
            fs.unlink(filePath, () => {});
          }
        });
      });
    });
  });
}, 5 * 60 * 1000);

router.use("/css", express.static(path.join(__dirname, "public/css")));
router.use("/js", express.static(path.join(__dirname, "public/js")));

router.get("/", (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect("/pac/dashboard");
  }

  return res.redirect("/pac/login");
});

router.get("/login", (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect("/pac/dashboard");
  }

  res.sendFile(path.join(__dirname, "public/login.html"));
});

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query(
      `
      SELECT id, username, name, password_hash, role, is_active
      FROM users
      WHERE username = $1
      LIMIT 1
      `,
      [username]
    );

    if (result.rows.length === 0) {
      await saveAccessLog(null, "LOGIN_FAILED", `Usuario inexistente: ${username}`, req);
      return res.redirect("/pac/login?error=1");
    }

    const user = result.rows[0];

    if (!user.is_active) {
      await saveAccessLog(user.id, "LOGIN_FAILED", "Usuario inativo", req);
      return res.redirect("/pac/login?error=1");
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash);

    if (!passwordOk) {
      await saveAccessLog(user.id, "LOGIN_FAILED", "Senha invalida", req);
      return res.redirect("/pac/login?error=1");
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role
    };

    await saveAccessLog(user.id, "LOGIN_SUCCESS", "Login realizado com sucesso", req);

    return res.redirect("/pac/dashboard");
  } catch (error) {
    console.error("Erro no login:", error);
    return res.status(500).send("Erro interno no servidor");
  }
});

router.get("/logout", async (req, res) => {
  const userId = req.session?.user?.id || null;

  if (userId) {
    await saveAccessLog(userId, "LOGOUT", "Logout realizado", req);
  }

  req.session.destroy(() => {
    res.redirect("/pac/login");
  });
});

router.get("/dashboard", requireAuth, async (req, res) => {
  startStreamsOnce();
  await saveAccessLog(req.session.user.id, "VIEW_DASHBOARD", "Acessou o dashboard", req);
  res.sendFile(path.join(__dirname, "public/dashboard.html"));
});

router.get("/api/cameras", requireAuth, (req, res) => {
  const list = cameras.map((cam) => ({
    id: cam.id,
    name: cam.name,
    category: cam.category,
    hls: `/pac/hls/${cam.id}/playlist.m3u8`,
    status: streamStatus.get(cam.id) || {
      state: "unknown",
      message: "Sem info do stream",
      updatedAt: null
    }
  }));

  res.json(list);
});

router.use(
  "/hls",
  requireAuth,
  express.static(hlsPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".m3u8")) {
        res.setHeader("Cache-Control", "no-cache");
      } else {
        res.setHeader("Cache-Control", "public, max-age=30");
      }
    }
  })
);

//startStreamsOnce();

if (require.main === module) {
  const app = express();

  app.get("/", (req, res) => {
    res.redirect("/pac");
  });

  app.use("/pac", router);

  app.listen(PORT, () => {
    console.log(`Servidor PAC rodando em http://localhost:${PORT}/pac`);
  });
}

module.exports = router;
