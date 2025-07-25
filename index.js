const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 8080;

const cameras = require("./cameras.json");
const hlsPath = path.join(__dirname, "hls");

// Cria pasta base HLS
if (!fs.existsSync(hlsPath)) fs.mkdirSync(hlsPath);

// Função para iniciar stream da câmera
function startStream(cam) {
  const camPath = path.join(hlsPath, cam.id);
  if (!fs.existsSync(camPath)) fs.mkdirSync(camPath);

  function run() {
    const ffmpeg = spawn("ffmpeg", [
      "-rtsp_transport", "tcp",
      "-i", cam.url,
      "-an",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-profile:v", "baseline",
      "-level", "3.0",
      "-f", "hls",
      "-hls_time", "10",
      "-hls_list_size", "30",
      "-hls_flags", "delete_segments+append_list",
      "-hls_segment_filename", `${camPath}/seg_%03d.ts`,
      `${camPath}/playlist.m3u8`
    ]);

    ffmpeg.stderr.on("data", data => console.log(`[${cam.id}] ${data.toString()}`));

    ffmpeg.on("exit", code => {
      console.log(`[${cam.id}] ffmpeg exited with code ${code}, reiniciando em 5s...`);
      setTimeout(run, 5000); // tenta reconectar após 5 segundos
    });
  }

  run();
}

// Inicia cada câmera com espaçamento de 2s
cameras.forEach((cam, i) => {
  setTimeout(() => startStream(cam), i * 2000);
});

// Limpeza periódica de arquivos antigos (>10 min)
setInterval(() => {
  cameras.forEach(cam => {
    const camPath = path.join(hlsPath, cam.id);
    fs.readdir(camPath, (err, files) => {
      if (err) return;
      files.forEach(file => {
        const filePath = path.join(camPath, file);
        fs.stat(filePath, (err, stats) => {
          if (!err && Date.now() - stats.mtimeMs > 10 * 60 * 1000) {
            fs.unlink(filePath, () => {});
          }
        });
      });
    });
  });
}, 5 * 60 * 1000); // a cada 5 minutos

// Cabeçalhos CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Range");
  next();
});

// Servir vídeos HLS com cache para .ts e no-cache para .m3u8
app.use("/hls", express.static(hlsPath, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".m3u8")) {
      res.setHeader("Cache-Control", "no-cache");
    } else {
      res.setHeader("Cache-Control", "public, max-age=60");
    }
  }
}));

// Servir página pública
app.use("/", express.static(path.join(__dirname, "public")));

// API com lista de câmeras
app.get("/api/cameras", (req, res) => {
  res.json(cameras.map(cam => ({
    id: cam.id,
    hls: `/hls/${cam.id}/playlist.m3u8`
  })));
});

// Inicia o servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
