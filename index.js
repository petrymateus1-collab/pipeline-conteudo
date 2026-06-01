const express = require("express");
const axios = require("axios");
const multer = require("multer");
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { execSync } = require("child_process");
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

async function listAllPngs(prefix) {
  let keys = [];
  let token = undefined;
  do {
    const params = { Bucket: BUCKET, Prefix: prefix };
    if (token) params.ContinuationToken = token;
    const r = await R2.send(new ListObjectsV2Command(params));
    if (r.Contents) {
      for (const obj of r.Contents) {
        if (obj.Key.match(/\.(png|PNG)$/)) keys.push(obj.Key);
      }
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function montarVideo(videoPath, workDir, assets) {
  const jobId = uuidv4().substring(0, 8);
  const outputPath = path.join(workDir, "output_" + jobId + ".mp4");
  log("Iniciando montagem job " + jobId);

  const normalizedPath = path.join(workDir, "norm_" + jobId + ".mp4");
  run('ffmpeg -y -i "' + videoPath + '" -vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 23 -c:a aac -ar 44100 -ac 2 "' + normalizedPath + '"');

  if (!hasVideoStream(normalizedPath)) throw new Error("Normalizacao falhou - sem stream de video");

  const durTotal = getDuration(normalizedPath);
  log("Duracao: " + durTotal + "s");

  const pngs = (assets.pngs || []).sort(() => Math.random() - 0.5).slice(0, 4);

  let inputFiles = [normalizedPath];
  if (assets.music) inputFiles.push(assets.music);
  if (assets.sfxIn && fs.existsSync(assets.sfxIn)) inputFiles.push(assets.sfxIn);
  if (assets.sfxOut && fs.existsSync(assets.sfxOut)) inputFiles.push(assets.sfxOut);
  pngs.forEach(p => inputFiles.push(p));

  const vidIdx = 0;
  const musIdx = 1;
  const sfxInIdx = (assets.sfxIn && fs.existsSync(assets.sfxIn)) ? 2 : -1;
  const sfxOutIdx = sfxInIdx >= 0 ? ((assets.sfxOut && fs.existsSync(assets.sfxOut)) ? 3 : -1) : ((assets.sfxOut && fs.existsSync(assets.sfxOut)) ? 2 : -1);
  const pngStartIdx = pngs.length > 0 ? inputFiles.indexOf(pngs[0]) : -1;

  const inputArgs = inputFiles.map(f => '-i "' + f + '"').join(" ");

  let filters = [];
  let lastVideo = vidIdx + ":v";

  pngs.forEach((p, i) => {
    const idx = pngStartIdx + i;
    const st = randomBetween(2, Math.max(3, durTotal * 0.2 + i * (durTotal / (pngs.length + 1))));
    const dur = randomBetween(3, 5);
    const et = Math.min(st + dur, durTotal - 1);
    filters.push("[" + idx + ":v]scale=720:1280,setsar=1[sp" + i + "]");
    filters.push("[sp" + i + "]fade=t=in:st=0:d=0.15,fade=t=out:st=" + (dur - 0.15).toFixed(2) + ":d=0.15[fp" + i + "]");
    filters.push("[" + lastVideo + "][fp" + i + "]overlay=0:0:enable='between(t," + st.toFixed(2) + "," + et.toFixed(2) + ")'[vp" + i + "]");
    lastVideo = "vp" + i;
  });

  filters.push("[" + lastVideo + "]fade=t=in:st=0:d=0.3,fade=t=out:st=" + (durTotal - 0.3).toFixed(2) + ":d=0.3[vfinal]");

  let afilters = [];
  afilters.push("[" + musIdx + ":a]atrim=0:" + durTotal + ",asetpts=PTS-STARTPTS,volume=0.15,afade=t=out:st=" + (durTotal - 2).toFixed(2) + ":d=2[mus]");
  afilters.push("[" + vidIdx + ":a]volume=1.0[orig]");
  let amix = "[mus][orig]";
  let amixN = 2;
  if (sfxInIdx >= 0) { afilters.push("[" + sfxInIdx + ":a]adelay=0|0,volume=0.8[sin]"); amix += "[sin]"; amixN++; }
  if (sfxOutIdx >= 0) { const d = Math.round(Math.max(0, (durTotal - 1.5) * 1000)); afilters.push("[" + sfxOutIdx + ":a]adelay=" + d + "|" + d + ",volume=0.8[sout]"); amix += "[sout]"; amixN++; }
  afilters.push(amix + "amix=inputs=" + amixN + ":duration=first:dropout_transition=2[afinal]");

  const fc = [...filters, ...afilters].join(";");
  run('ffmpeg -y ' + inputArgs + ' -filter_complex "' + fc + '" -map "[vfinal]" -map "[afinal]" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -ar 44100 -t ' + durTotal + ' "' + outputPath + '"');

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
      log("Video recebido via upload");
    } else if (req.body && req.body.video_url) {
      videoPath = path.join(workDir, "input.mp4");
      log("Baixando video: " + req.body.video_url);
      await downloadFile(req.body.video_url, videoPath);
    } else {
      return res.status(400).json({ error: "Envie video_url no body ou arquivo via multipart" });
    }

    log("Baixando assets do R2...");
    const musicPath = path.join(workDir, "music.mp3");
    const sfxInPath = path.join(workDir, "sfx_in.mp3");
    const sfxOutPath = path.join(workDir, "sfx_out.mp3");
    let assets = { music: null, sfxIn: null, sfxOut: null, pngs: [] };

    try { await downloadFromR2("assets/musicas/LAST_HOPE.mp3", musicPath); assets.music = musicPath; log("Musica OK"); } catch(e) { log("Musica nao encontrada: " + e.message); }
    try { await downloadFromR2("assets/efeitos-sonoros/INPUT.mp3", sfxInPath); assets.sfxIn = sfxInPath; log("SFX entrada OK"); } catch(e) { log("SFX entrada nao encontrado: " + e.message); }
    try { await downloadFromR2("assets/efeitos-sonoros/OUTPUT.mp3", sfxOutPath); assets.sfxOut = sfxOutPath; log("SFX saida OK"); } catch(e) { log("SFX saida nao encontrado: " + e.message); }

    try {
      const pngKeys = await listAllPngs("assets/ilustracoes/");
      log("PNGs encontrados no R2: " + pngKeys.length);
      for (const key of pngKeys) {
        const fname = key.replace(/\//g, "_");
        const pp = path.join(workDir, fname);
        try { await downloadFromR2(key, pp); assets.pngs.push(pp); } catch(e) {}
      }
      log("PNGs baixados: " + assets.pngs.length);
    } catch(e) { log("Erro listando PNGs: " + e.message); }

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
