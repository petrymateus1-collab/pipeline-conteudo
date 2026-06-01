const express = require("express");
const axios = require("axios");
const multer = require("multer");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const FormData = require("form-data");

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
const OPENAI_KEY = process.env.OPENAI_KEY;

function log(msg) { console.log("[" + new Date().toISOString() + "] " + msg); }
function run(cmd) { log("CMD: " + cmd.substring(0, 120)); return execSync(cmd, { stdio: "pipe" }).toString(); }

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

async function transcreverOpenAI(audioPath) {
  try {
    log("Transcrevendo com OpenAI Whisper...");
    const form = new FormData();
    form.append("file", fs.createReadStream(audioPath), { filename: "audio.mp3", contentType: "audio/mpeg" });
    form.append("model", "whisper-1");
    form.append("language", "en");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    const response = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
      headers: { ...form.getHeaders(), "Authorization": "Bearer " + OPENAI_KEY },
      maxBodyLength: Infinity,
      timeout: 60000
    });
    log("Transcricao OK: " + response.data.segments.length + " segmentos");
    return response.data;
  } catch(e) {
    log("Erro OpenAI: " + (e.response ? JSON.stringify(e.response.data) : e.message));
    return null;
  }
}

const CTA_WORDS = {
  follow: ["follow", "following", "follower", "subscribe", "join"],
  like: ["like", "likes", "love", "heart"],
  comment: ["comment", "reply", "respond", "write", "type"],
  link: ["link", "bio", "click", "visit", "swipe", "below"]
};

const CTA_POS = {
  follow:  { x: "w-170", y: "h-200" },
  like:    { x: "w-170", y: "h*0.60" },
  comment: { x: "w-170", y: "h*0.65" },
  link:    { x: "w-170", y: "h-200" }
};

function detectarCTAs(transcricao) {
  if (!transcricao || !transcricao.segments) return [];
  const ctas = [];
  for (const seg of transcricao.segments) {
    const texto = (seg.text || "").toLowerCase();
    for (const [tipo, palavras] of Object.entries(CTA_WORDS)) {
      if (palavras.some(p => texto.includes(p))) {
        ctas.push({ tipo, start: seg.start, end: seg.end + 2 });
        break;
      }
    }
  }
  log("CTAs detectados: " + ctas.length);
  return ctas;
}

function quebrarLinhas(texto, maxChars) {
  const palavras = texto.split(" ");
  const linhas = [];
  let linha = "";
  for (const p of palavras) {
    if ((linha + " " + p).trim().length <= maxChars) {
      linha = (linha + " " + p).trim();
    } else {
      if (linha) linhas.push(linha);
      linha = p;
    }
  }
  if (linha) linhas.push(linha);
  return linhas.slice(0, 3);
}

function escaparFFmpeg(texto) {
  return texto
    .replace(/\\/g, "")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/%/g, "\\%");
}

function gerarVF(transcricao) {
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  let vf = "format=yuv420p";
  const lh = 48;

  if (transcricao && transcricao.segments) {
    for (const seg of transcricao.segments) {
      const textoRaw = (seg.text || "").trim().substring(0, 120);
      if (!textoRaw) continue;
      const linhas = quebrarLinhas(textoRaw, 28);
      const totalAltura = linhas.length * lh;
      const yBase = "(h/2)-(" + totalAltura + "/2)";
      const st = seg.start.toFixed(2);
      const et = seg.end.toFixed(2);
      linhas.forEach((linha, i) => {
        const texto = escaparFFmpeg(linha);
        const y = "(" + yBase + ")+" + (i * lh);
        vf += ",drawtext=fontfile='" + font + "':text='" + texto + "':fontsize=40:fontcolor=white:borderw=3:bordercolor=black:x=(w-tw)/2:y=" + y + ":enable='between(t," + st + "," + et + ")'";
      });
    }
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

  const audioPath = path.join(workDir, "audio_" + jobId + ".mp3");
  run('ffmpeg -y -i "' + normalizedPath + '" -vn -ar 16000 -ac 1 -q:a 0 "' + audioPath + '"');

  const transcricao = await transcreverOpenAI(audioPath);
  const ctas = detectarCTAs(transcricao);
  const vf = gerarVF(transcricao);

  const setaPath = path.join(workDir, "seta_cta.png");
  let setaDisponivel = false;
  try {
    await downloadFromR2("assets/STICKERS/seta_cta.png", setaPath);
    setaDisponivel = true;
    log("Seta OK");
  } catch(e) { log("Seta nao encontrada"); }

  // Step 1: legendas
  const vidLegPath = path.join(workDir, "vid_leg_" + jobId + ".mp4");
  run('ffmpeg -y -i "' + normalizedPath + '" -vf "' + vf + '" -c:v libx264 -preset fast -crf 23 -c:a copy "' + vidLegPath + '"');

  // Step 2: seta CTA — cada CTA vira um passo separado
  let vidCtaPath = vidLegPath;
  if (setaDisponivel && ctas.length > 0) {
    let currentInput = vidLegPath;
    ctas.forEach((cta, i) => {
      const pos = CTA_POS[cta.tipo];
      const st = cta.start.toFixed(2);
      const et = cta.end.toFixed(2);
      const nextPath = path.join(workDir, "vid_cta_" + i + "_" + jobId + ".mp4");
      const fc = "[1:v]scale=160:160[s];[0:v][s]overlay=" + pos.x + ":" + pos.y + ":enable='between(t," + st + "," + et + ")'[v]";
      run('ffmpeg -y -i "' + currentInput + '" -i "' + setaPath + '" -filter_complex "' + fc + '" -map "[v]" -map "0:a" -c:v libx264 -preset fast -crf 23 -c:a copy "' + nextPath + '"');
      currentInput = nextPath;
    });
    vidCtaPath = path.join(workDir, "vid_cta_" + (ctas.length - 1) + "_" + jobId + ".mp4");
  }

  // Step 3: musica
  run('ffmpeg -y -i "' + vidCtaPath + '" -i "' + assets.music + '" -filter_complex "[1:a]atrim=0:' + durTotal + ',asetpts=PTS-STARTPTS,volume=0.13,afade=t=out:st=' + (durTotal - 2).toFixed(2) + ':d=2[mus];[0:a]volume=2.5[orig];[mus][orig]amix=inputs=2:duration=first:dropout_transition=2[afinal]" -map "0:v" -map "[afinal]" -c:v copy -c:a aac -b:a 128k -ar 44100 -t ' + durTotal + ' "' + outputPath + '"');

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
    let assets = { music: null };

    try { await downloadFromR2("assets/musicas/LAST_HOPE.mp3", musicPath); assets.music = musicPath; log("Musica OK"); } catch(e) { log("Musica nao encontrada"); }

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
