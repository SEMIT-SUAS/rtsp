const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 8080;

const cameras = require("./cameras.json");
const hlsPath = path.join(__dirname, "hls");

if (!fs.existsSync(hlsPath)) fs.mkdirSync(hlsPath);

cameras.forEach(cam => {
  const camPath = path.join(hlsPath, cam.id);
  if (!fs.existsSync(camPath)) fs.mkdirSync(camPath);

  const ffmpeg = spawn("ffmpeg", [
  "-rtsp_transport", "tcp",            // Usa TCP (mais estável para rede)
  "-i", cam.url,
  "-an",                                // Remove áudio para economizar
  "-c:v", "libx264",
  "-preset", "ultrafast",               // Reduz carga na CPU
  "-tune", "zerolatency",
  "-profile:v", "baseline",
  "-level", "3.0",
  "-f", "hls",
  "-hls_time", "2",                     // Segmentos menores (reduz atraso)
  "-hls_list_size", "4",               // Playlist menor
  "-hls_flags", "delete_segments+omit_endlist+append_list",
  "-hls_segment_filename", `${camPath}/seg_%03d.ts`,
  `${camPath}/playlist.m3u8`
]);

  ffmpeg.stderr.on("data", data => console.log(`[${cam.id}] ${data.toString()}`));
  ffmpeg.on("exit", code => console.log(`[${cam.id}] ffmpeg exited: ${code}`));
});

// Adicionar os cabeçalhos Access-Control-Allow-Origin
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Range");
    next();
});

// Servir arquivos HLS e página estática
app.use("/hls", express.static(hlsPath));
app.use("/", express.static(path.join(__dirname, "public")));

app.get("/api/cameras", (req, res) => {
  res.json(cameras.map(cam => ({
    id: cam.id,
    hls: `/hls/${cam.id}/playlist.m3u8`
  })));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});

