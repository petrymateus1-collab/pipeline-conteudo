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

// Converte PNG em clipe MP4 com duração fixa
function pngToClip(pngPath, clipPath, dur) {
  run('ffmpeg -y -loop 1 -i "' + pngPath + '" -vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p" -t ' + dur + ' -c:v libx264 -preset fast -crf 23 "' + clipPath + '"');
}

async function montarVideo(videoPath, workDir, assets) {
  const jobId = uuidv4().substring(0, 8);
  const outputPath = path.join(workDir, "output_" + jobId + ".mp4");
  log("Iniciando montagem job " + jobId);

  const normalizedPath = path.join(workDir, "norm_" + jobId + ".mp4");
  run('ffmpeg -y -i "' + videoPath + '" -vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p" -c:v libx264 -preset fast -crf 23 -c:a aac -ar 44100 -ac 2 "' + normalizedPath + '"');

  if (!hasVideoStream(normalizedPath)) throw new Error("Normalizacao falhou - sem stream de video");

  const durTotal = getDuration(normalizedPath);
  log("Duracao: " + durTotal + "s");

  const pngs = (assets.pngs || []).sort(() => Math.random() - 0.5).slice(0, 3);
  log("Usando " + pngs.length + " PNGs");

  // Converte cada PNG em clipe MP4
  const pngClips = [];
  const pngTimings = [];
  pngs.forEach((p, i) => {
    const dur = randomBetween(3, 5);
    const st = randomBetween(3, Math.max(4, durTotal * 0.15 + i * (durTotal / (pngs.length + 1))));
    const et = Math.min(st + dur, durTotal - 2);
    const clipPath = path.join(workDir, "clip_" + i + ".mp4");
    pngToClip(p, clipPath, dur);
    pngClips.push(clipPath);
    pngTimings.push({ st: st.toFixed(2), et: et.toFixed(2), dur: dur.toFixed(2) });
    log("PNG " + i + " convertido: st=" + st.toFixed(2) + "s dur=" + dur.toFixed(2) + "s");
  });

  // Monta inputs
  let inputFiles = [normalizedPath];
  if (assets.music) inputFiles.push(assets.music);
  if (assets.sfxIn && fs.existsSync(assets.sfxIn)) inputFiles.push(assets.sfxIn);
  if (assets.sfxOut && fs.existsSync(assets.sfxOut)) inputFiles.push(assets.sfxOut);
  pngClips.forEach(c => inputFiles.push(c));

  const vidIdx = 0;
  const musIdx = 1;
  const sfxInIdx = (assets.sfxIn && fs.existsSync(assets.sfxIn)) ? 2 : -1;
  const sfxOutIdx = sfxInIdx >= 0 ? ((assets.sfxOut && fs.existsSync(assets.sfxOut)) ? 3 : -1) : ((assets.sfxOut && fs.existsSync(assets.sfxOut)) ? 2 : -1);
  const clipStartIdx = inputFiles.indexOf(pngClips[0]);

  const inputArgs = inputFiles.map(f => '-i "' + f + '"').join(" ");

  let filters = [];
  let lastVideo = vidIdx + ":v";

  // Overlay de cada clipe PNG no momento certo
  pngClips.forEach((c, i) => {
    const idx = clipStartIdx + i;
    const { st, et } = pngTimings[i];
    filters.push("[" + idx + ":v]fade=t=in:st=0:d=0.15,fade=t=out:st=" + (parseFloat(pngTimings[i].dur) - 0.15).toFixed(2) + ":d=0.15[fp" + i + "]");
    filters.push("[" + lastVideo + "][fp" + i + "]overlay=0:0:enable='between(t," + st + "," + et + ")'[vp" + i + "]");
    lastVideo = "vp" + i;
  });

  filters.push("[" + lastVideo + "]fade=t=in:st=0:d=0.3,fade=t=out:st=" + (durTotal - 0.3).toFixed(2) + ":d=0.3[vfinal]");

  // Áudio
  let afilters = [];
  afilters.push("[" + musIdx + ":a]atrim=0:" + durTotal + ",asetpts=PTS-STARTPTS,volume=0.15,afade=t=out:st=" + (durTotal - 2).toFixed(2) + ":d=2[mus]");
  afilters.push("[" + vidIdx + ":a]volume=1.0[orig]");
  let amix = "[mus][orig]";
  let amixN = 2;

  // SFX: cada PNG tem seu próprio INPUT e OUTPUT sincronizados
  pngTimings.forEach((t, i) => {
    if (sfxInIdx >= 0) {
      const dIn = Math.round(parseFloat(t.st) * 1000);
      afilters.push("[" + sfxInIdx + ":a]adelay=" + dIn + "|" + dIn + ",volume=0.8[sin" + i + "]");
      amix += "[sin" + i + "]";
      amixN++;
    }
    if (sfxOutIdx >= 0) {
      const dOut = Math.round(parseFloat(t.et) * 1000);
      afilters.push("[" + sfxOutIdx + ":a]adelay
