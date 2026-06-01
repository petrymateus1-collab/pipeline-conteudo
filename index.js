const express = require("express");
const axios = require("axios");
const multer = require("multer");
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());
const upload = multer({ dest: "/tmp/uploads/" });

const R2 = new S3Client({
  region: "auto",
  endpoint: "https://cc76425b059a5da95dc2e2cd752ed8e9.r2.cloudflarestorage.com",
  credentials: {
    accessKeyId: "54320ba9398ef8a26b6da49174acd202",
    secretAccessKey: "78b5405346dfbfa75bb87eca40cfdf7b6e959e635698e0d46ab22ee110878f99"
  }
});
const BUCKET = "pipeline-conteudo";
const R2_PUBLIC = "https://pub-4f2d74fa9c7c4f0089849a2be3a4f517.r2.dev";

function log(msg) { console.log("[" + new Date().toISOString() + "] " + msg); }
function run(cmd) { log("CMD: " + cmd.substring(0, 120)); return execSync(cmd, { stdio: "pipe" }).toString(); }
function randomBetween(min, max) { return Math.random() * (max - min) + min; }

async function downloadFile(url, destPath) {
  const r = await axios({ url, responseType: "stream" });
  return new Promise((res, rej) => {
    const w = fs.createWriteStream(destPath);
    r.data.pipe(w);
    w.on("finish", res);
    w.on("error", rej);
  });
}

async function downloadFromR2(key, dest) {
  const result = await R2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return new Promise((res, rej) => {
    const w = fs.createWriteStream(dest);
    result.Body.pipe(w);
    w.on("finish", res);
    w.on("error", rej);
  });
}

async function uploadToR2(localPath, key) {
  const buf = fs.readFileSync(localPath);
  await R2.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: "video/mp4" }));
  return R2_PUBLIC + "/" + key;
}

function getDuration(f) {
  return parseFloat(execSync('ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "' + f + '"').toString().trim());
}

function hasVideoStream(f) {
  try {
    const out = execSync('ffprobe -v error -select_streams v:0 -show_entries stream=codec_type -of csv=p=0 "' + f + '"').toString().trim();
    return out === "video";
  } catch(e) { return false; }
}

function transcreverAudio(audioPath, workDir) {
  try {
    log("Transcrevendo com Whisper tiny...");
    const result = spawnSync("/opt/venv/bin/whisper", [
      audioPath,
      "--model", "tiny",
      "--language", "en",
      "--output_format", "json",
      "--output_dir", workDir,
      "--fp16", "False"
    ], { encoding: "utf8", timeout: 180000, maxBuffer: 50 * 1024 * 1024 });
    if (result.status !== 0) {
      log("Whisper erro: " + (result.stderr || "").substring(0, 200));
      return null;
    }
    const base = path.basename(audioPath, path.extname(audioPath));
    const jsonPath = path.join(workDir, base + ".json");
    if (fs.existsSync(jsonPath)) {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      log("Transcricao OK: " + data.segments.length + " segmentos");
      return data;
    }
  } catch(e) { log("Erro Whisper: " + e.message); }
  return null;
}

const CTA_WORDS = {
  follow: ["follow", "following", "follower", "subscribe", "join"],
  like: ["like", "likes", "love", "heart", "tap"],
  comment: ["comment", "reply", "respond", "write", "type"],
  link: ["link", "bio", "click", "visit", "swipe", "below"]
};

const CTA_TEXT = {
  follow: "TAP FOLLOW ->",
  like: "TAP LIKE ->",
  comment: "COMMENT BELOW",
  link: "LINK IN BIO v"
};

const CTA_POS = {
  follow:  { x: "w-200", y: "h-180" },
  like:    { x: "w-120", y: "h*0.82" },
  comment: { x: "w-120", y: "h*0.75" },
  link:    { x: "(w-tw)/2", y: "h-80" }
};

function detectarCTAs(transcricao) {
  if (!transcricao || !transcricao.segments) return [];
  const ctas = [];
  for (const seg of transcricao.segments) {
    const words = seg.words || [];
    for (const word of words) {
      const w = (word.word || "").toLowerCase().replace(/[^a-z]/g, "");
      for (const [tipo, lista] of Object.entries(CTA_WORDS)) {
        if (lista.includes(w)) {
          ctas.push({ tipo, start: word.start || seg.start, end: (word.end || seg.end) + 2 });
          break;
        }
      }
    }
  }
  log("CTAs: " + ctas.length);
  return ctas;
}

function gerarVF(transcricao, ctas) {
  let vf = "format=yuv420p";
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

  if (transcricao && transcricao.segments) {
    for (const seg of transcricao.segments) {
      const texto = (seg.text || "").trim()
        .replace(/\\/g, "")
        .replace(/'/g, "\u2019")
        .replace(/:/g, "\\:")
        .replace(/,/g, "\\,")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]")
        .substring(0, 120);
      if (!texto) continue;
      const st = (seg.start || 0).toFixed(2);
      const et = (seg.end || 0).toFixed(2);
      vf += ",drawtext=fontfile='" + font + "':text='" + texto + "':fontsize=46:fontcolor=white:borderw=3:bordercolor=black:x=(w-tw)/2:y=h*0.72:enable='between(t," + st + "," + et + ")'";
    }
  }

  for (const cta of ctas) {
    const texto = CTA_TEXT[cta.tipo];
    const pos = CTA_POS[cta.tipo];
    const st = (cta.start || 0).toFixed(2);
    const et = (cta.end || 0).toFixed(2);
    vf += ",drawtext=fontfile='" + font + "':text='" + texto + "':fontsize=44:fontcolor=yellow:borderw=3:bordercolor=black:x=" + pos.x + ":y=" + pos.y + ":enable='between(t," + st + "," + et + ")'";
  }

  return vf;
}

async function montarVideo(videoPath, workDir, assets) {
  const jobId = uuidv4().substring(0, 8);
  const outputPath = path.join(workDir, "output_" + jobId + ".mp4");
  log("Iniciando montagem job " + jobId);

  const normalizedPath = path.join(workDir, "norm_" + jobId + ".mp4");
  run('ffmpeg -y -i "' + videoPath + '" -vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 23 -c:a aac -ar 44100 -ac 2 "' + normalizedPath + '"');

  if (!hasVideoStream(normalizedPath)) throw new Error("Normalizacao falhou");

  const durTotal = getDuration(normalizedPath);
  log("Duracao: " + durTotal + "s");

  const audioPath = path.join(workDir, "audio_" + jobId + ".wav");
  run('ffmpeg -y -i "' + normalizedPath + '" -vn -ar 16000 -ac 1 "' + audioPath + '"');

  const transcricao = transcreverAudio(audioPath, workDir);
  const ctas = detectarCTAs(transcricao);
  const vf = gerarVF(transcricao, ctas);

  let inputFiles = [normalizedPath];
  if (assets.music) inputFiles.push(assets.music);
  const sfxInAvail = assets.sfxIn && fs.existsSync(assets.sfxIn);
  const sfxOutAvail = assets.sfxOut && fs.existsSync(assets.sfxOut);
  if (sfxInAvail) inputFiles.push(assets.sfxIn);
  if (sfxOutAvail) inputFiles.push(assets.sfxOut);

  const musIdx = 1;
  const sfxInIdx = sfxInAvail ? 2 : -1;
  const sfxOutIdx = sfxInAvail ? (sfxOutAvail ? 3 : -1) : (sfxOutAvail ? 2 : -1);
  const inputArgs = inputFiles.map(f => '-i "' + f + '"').join(" ");

  let afilters = [];
  afilters.push("[" + musIdx + ":a]atrim=0:" + durTotal + ",asetpts=PTS-STARTPTS,volume=0.15,afade=t=out:st=" + (durTotal - 2).toFixed(2) + ":d=2[mus]");
  afilters.push("[0:a]volume=1.0[orig]");
  let amix = "[mus][orig]";
  let amixN = 2;

  if (sfxInIdx >= 0) {
    afilters.push("[" + sfxInIdx + ":a]adelay=0|0,volume=0.8[sin0]");
    amix += "[sin0]";
    amixN++;
  }
  if (sfxOutIdx >= 0) {
    const dOut = Math.round(Math.max(0, (durTotal - 1.5)) * 1000);
    afilters.push("[" + sfxOutIdx + ":a]adelay=" + dOut + "|" + dOut + ",volume=0.8[sout0]");
    amix += "[sout0]";
    amixN++;
  }

  afilters.push(amix + "amix=inputs=" + amixN + ":duration=first:dropout_transition=2[afinal]");
  const fc = afilters.join(";");

  run('ffmpeg -y ' + inputArgs +
    ' -filter_complex "' + fc + '"' +
    ' -map "0:v" -vf "' + vf + '"' +
    ' -map "[afinal]"' +
    ' -c:v libx264 -preset fast -crf 23' +
    ' -c:a aac -b:a 128k -ar 44100' +
    ' -t ' + durTotal +
    ' "' + outputPath + '"');

  log("Video montado: " + outputPath);
  return outputPath;
}

app.post("/processar", upload.single("video"), async (req, res) => {
  const workDir = "/tmp/job_" + uuidv4().substring(0, 8);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    let videoPath;
    if (req.file) {
      videoPath = req.file.path;
    } else if (req.body && req.body.video_url) {
      videoPath = path.join(workDir, "input.mp4");
      log("Baixando video: " + req.body.video_url);
      await downloadFile(req.body.video_url, videoPath);
    } else {
      return res.status(400).json({ error: "Envie video_url no body ou arquivo via multipart" });
    }

    const musicPath = path.join(workDir, "music.mp3");
    const sfxInPath = path.join(workDir, "sfx_in.mp3");
    const sfxOutPath = path.join(workDir, "sfx_out.mp3");
    let assets = { music: null, sfxIn: null, sfxOut: null };

    try { await downloadFromR2("assets/musicas/LAST_HOPE.mp3", musicPath); assets.music = musicPath; log("Musica OK"); } catch(e) { log("Musica nao encontrada"); }
    try { await downloadFromR2("assets/efeitos-sonoros/INPUT.mp3", sfxInPath); assets.sfxIn = sfxInPath; log("SFX in OK"); } catch(e) { log("SFX in nao encontrado"); }
    try { await downloadFromR2("assets/efeitos-sonoros/OUTPUT.mp3", sfxOutPath); assets.sfxOut = sfxOutPath; log("SFX out OK"); } catch(e) { log("SFX out nao encontrado"); }

    if (!assets.music) {
      const sil = path.join(workDir, "silence.mp3");
      run('ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 120 "' + sil + '"');
      assets.music = sil;
    }

    const outputPath = await montarVideo(videoPath, workDir, assets);
    const r2Key = "videos/" + uuidv4() + ".mp4";
    const publicUrl = await uploadToR2(outputPath, r2Key);
    fs.rmSync(workDir, { recursive: true, force: true });
    res.json({ success: true, url: publicUrl, r2_key: r2Key });
  } catch(err) {
    log("ERRO: " + err.message);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(_) {}
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/ffmpeg", (req, res) => {
  try { res.json({ ffmpeg: execSync("ffmpeg -version").toString().split("\n")[0] }); }
  catch(e) { res.status(500).json({ error: "FFmpeg nao encontrado" }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Servico rodando na porta " + PORT));
