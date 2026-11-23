// =====================================================================
// ПУБЛІЧНИЙ БОТ
// Доступ відкритий для всіх, без списку дозволених і без оплати.
// Таблиці в Supabase: pub_users, pub_packs.
// =====================================================================

const sharp = require("sharp");
const ffmpegPath = require("ffmpeg-static");
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");

const execFileP = promisify(execFile);

const TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const SECRET = process.env.WEBHOOK_SECRET;
const ADMIN_ID = String(process.env.ADMIN_ID || "").trim();
const API = `https://api.telegram.org/bot${TOKEN}`;

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

// ---------- Telegram ----------
async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function tgForm(method, form) {
  const r = await fetch(`${API}/${method}`, { method: "POST", body: form });
  return r.json();
}

const send = (chatId, text, markup) =>
  tg("sendMessage", {
    chat_id: chatId,
    text,
    ...(markup ? { reply_markup: markup } : {}),
  });

async function downloadFile(fileId) {
  const info = await tg("getFile", { file_id: fileId });
  if (!info.ok) {
    throw new Error("Не вдалося отримати файл (можливо, він більший за 20 МБ).");
  }
  const res = await fetch(
    `https://api.telegram.org/file/bot${TOKEN}/${info.result.file_path}`
  );
  return Buffer.from(await res.arrayBuffer());
}

// ---------- Supabase ----------
const sbHeaders = {
  apikey: SB_KEY,
  "Content-Type": "application/json",
  // Старий ключ (eyJ...) це JWT і потребує Bearer. Новий (sb_secret_...) ні.
  ...(SB_KEY && SB_KEY.startsWith("eyJ")
    ? { Authorization: `Bearer ${SB_KEY}` }
    : {}),
};

// Запасна пам'ять на випадок, якщо база даних недоступна
const mem = new Map();

async function getState(userId) {
  const local = mem.get(userId);
  // Якщо останній запис у базу не вдався, віримо пам'яті
  if (local && local.dirty) return local.data;
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/pub_users?user_id=eq.${userId}&select=*`,
      { headers: sbHeaders }
    );
    const rows = await r.json();
    if (!r.ok) {
      console.error("Supabase GET error:", r.status, JSON.stringify(rows));
      return local ? local.data : {};
    }
    if (Array.isArray(rows) && rows[0]) return rows[0];
    return local ? local.data : {};
  } catch (e) {
    console.error("Supabase GET exception:", e);
    return local ? local.data : {};
  }
}

// Зберігає стан у базу і в пам'ять. Повертає true, якщо база прийняла запис.
async function saveState(userId, fields) {
  const prev = (mem.get(userId) || {}).data || {};
  const data = { ...prev, ...fields };
  let ok = false;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/pub_users?on_conflict=user_id`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: userId, ...fields }),
    });
    ok = r.ok;
    if (!r.ok) console.error("Supabase SAVE error:", r.status, await r.text());
  } catch (e) {
    console.error("Supabase SAVE exception:", e);
  }
  mem.set(userId, { data, dirty: !ok });
  return ok;
}

async function debugSupabase(userId) {
  const keyType = !SB_KEY
    ? "НЕМАЄ"
    : SB_KEY.startsWith("eyJ")
    ? "старий JWT-ключ"
    : SB_KEY.startsWith("sb_secret_")
    ? "новий secret-ключ"
    : SB_KEY.startsWith("sb_publishable_")
    ? "publishable (НЕ ПІДХОДИТЬ, потрібен secret/service_role)"
    : "невідомий формат";
  const lines = [
    `SUPABASE_URL: ${SB_URL ? "є" : "НЕМАЄ"}`,
    `SUPABASE_KEY: ${keyType}`,
  ];

  try {
    const g = await fetch(
      `${SB_URL}/rest/v1/pub_users?user_id=eq.${userId}&select=*`,
      { headers: sbHeaders }
    );
    lines.push(`Читання: ${g.status} ${(await g.text()).slice(0, 250)}`);
  } catch (e) {
    lines.push(`Читання: помилка з'єднання ${e.message}`);
  }

  try {
    const w = await fetch(`${SB_URL}/rest/v1/pub_users?on_conflict=user_id`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: userId }),
    });
    lines.push(`Запис: ${w.status} ${(await w.text()).slice(0, 250)}`);
  } catch (e) {
    lines.push(`Запис: помилка з'єднання ${e.message}`);
  }

  for (const t of ["pub_users", "pub_packs"]) {
    try {
      const a = await fetch(`${SB_URL}/rest/v1/${t}?select=*&limit=1`, { headers: sbHeaders });
      lines.push(`${t}: ${a.status} ${a.ok ? "ок" : (await a.text()).slice(0, 200)}`);
    } catch (e) {
      lines.push(`${t}: помилка з'єднання ${e.message}`);
    }
  }

  return lines.join("\n");
}

// ---------- Наявні набори (таблиця packs) ----------
const makePackName = (ts, userId) => `p${ts}u${userId}_by_${BOT_USERNAME}`;
const tsOf = (name) => ((name || "").match(/^p([0-9a-z]+)u\d+_by_/i) || [])[1];

async function sbJson(path, opts = {}) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders, ...opts });
    if (!r.ok) {
      console.error("Supabase error:", path, r.status, await r.text());
      return null;
    }
    const t = await r.text();
    return t ? JSON.parse(t) : [];
  } catch (e) {
    console.error("Supabase exception:", path, e);
    return null;
  }
}

async function recordPack(row) {
  const res = await sbJson("pub_packs?on_conflict=pack_name", {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(row),
  });
  return res !== null;
}

const listPacks = (userId) =>
  sbJson(`pub_packs?user_id=eq.${userId}&select=*&order=created_at.desc&limit=10`);

async function getPackRow(userId, name) {
  const rows = await sbJson(
    `pub_packs?user_id=eq.${userId}&pack_name=eq.${encodeURIComponent(name)}&select=*`
  );
  return (rows && rows[0]) || null;
}

async function findCloneRow(userId, source) {
  const rows = await sbJson(
    `pub_packs?user_id=eq.${userId}&source_set=eq.${encodeURIComponent(source)}&select=*&limit=1`
  );
  return (rows && rows[0]) || null;
}

const deletePackRow = (name) =>
  sbJson(`pub_packs?pack_name=eq.${encodeURIComponent(name)}`, { method: "DELETE" });

const updatePackRow = (name, fields) =>
  sbJson(`pub_packs?pack_name=eq.${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });

// ---------- Кнопки і тексти ----------
const MAIN_MENU = {
  inline_keyboard: [
    [{ text: "🖼 Створити стікер-пак", callback_data: "new:sticker" }],
    [{ text: "😀 Створити емоджі", callback_data: "new:emoji" }],
    [{ text: "📚 Мої набори", callback_data: "my:list" }],
    [{ text: "📥 Скопіювати старий набір", callback_data: "cl:start" }],
  ],
};

const STICKER_TYPES = {
  inline_keyboard: [
    [
      { text: "🎞 Анімовані", callback_data: "t:sticker:video" },
      { text: "🖼 Звичайні", callback_data: "t:sticker:static" },
    ],
    [{ text: "🔀 Змішаний (анімовані + звичайні)", callback_data: "t:sticker:mixed" }],
  ],
};

const EMOJI_TYPES = {
  inline_keyboard: [
    [{ text: "🎨 Адаптивні (міняють колір)", callback_data: "t:emoji:adaptive" }],
    [{ text: "😀 Звичайні", callback_data: "t:emoji:mixed" }],
  ],
};

const LABELS = {
  "sticker:static": "звичайні наліпки",
  "sticker:video": "анімовані наліпки",
  "sticker:mixed": "змішані наліпки (і анімовані, і звичайні)",
  "emoji:static": "звичайні емоджі",
  "emoji:adaptive": "адаптивні емоджі",
  "emoji:video": "анімовані емоджі",
  "emoji:mixed": "звичайні емоджі (будь-які)",
};

const WHAT_TO_SEND = {
  "sticker:static":
    "Надсилай картинки. Щоб фон був прозорим, надсилай їх як ФАЙЛ (скріпка → Файл).",
  "sticker:video":
    "Надсилай відео або GIF. Береться перші 3 секунди, без звуку.",
  "sticker:mixed":
    "Надсилай що завгодно: картинки стануть звичайними наліпками, а відео чи GIF анімованими (перші 3 секунди). Усе потрапить в один набір.",
  "emoji:static":
    "Надсилай картинки. Вони стануть квадратними 100×100. Для прозорого фону надсилай як ФАЙЛ.",
  "emoji:adaptive":
    "Надсилай що завгодно: фото, картинки, відео, GIF, готові наліпки чи емоджі. Усе стане однотонним силуетом, а колір підлаштується під текст. Найкраще виходять прості іконки на прозорому фоні (як ФАЙЛ). Якщо фон непрозорий, темні елементи залишаться, а світлі зникнуть.",
  "emoji:video":
    "Надсилай відео або GIF. Береться перші 3 секунди, без звуку, розмір 100×100.",
  "emoji:mixed":
    "Надсилай що завгодно: картинки, відео, GIF, готові кастомні емоджі або звичайні наліпки (крім анімованих TGS). Усе стане емоджі 100×100.",
};

const HELP_TEXT =
  "Я роблю наліпки та кастомні емоджі 🙂\n\n" +
  "/newsticker — створити стікер-пак (можна додавати картинки, відео, GIF і готові наліпки)\n" +
  "/newemoji — створити набір емоджі (адаптивні або звичайні)\n" +
  "/mypacks — мої набори (додати, перейменувати, видалити)\n" +
  "/clonepack — скопіювати старий набір, щоб його можна було редагувати\n" +
  "/done — завершити набір\n" +
  "/cancel — скасувати\n" +
  "/id — дізнатись свій Telegram ID\n\n" +
  "Як це працює: обираєш тип, пишеш назву набору, а потім надсилаєш картинки чи відео. Кожен файл додається в набір.\n\n" +
  "Щоб прив'язати до наліпки своє емоджі, напиши його в підписі до файлу (за замовчуванням 😀).";

function setLink(st) {
  const base = st.kind === "emoji" ? "addemoji" : "addstickers";
  return `https://t.me/${base}/${st.pack_name}`;
}

// ---------- Обробка зображень ----------
async function toAdaptive(buf) {
  // Робимо з картинки білий силует: колір потім підставить сам Telegram
  const { data, info } = await sharp(buf)
    .resize(100, 100, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) {
      hasAlpha = true;
      break;
    }
  }

  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 4) {
    let alpha = data[i + 3];
    if (!hasAlpha) {
      // Немає прозорості: темні пікселі стають непрозорими
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      alpha = Math.max(0, Math.min(255, Math.round(255 - lum)));
    }
    out[i] = 255;
    out[i + 1] = 255;
    out[i + 2] = 255;
    out[i + 3] = alpha;
  }

  return sharp(out, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .resize(100, 100, { fit: "contain", background: TRANSPARENT })
    .png()
    .toBuffer();
}

// ---------- Обробка відео (ffmpeg) ----------
function getFfmpeg() {
  if (!ffmpegPath) throw new Error("ffmpeg недоступний на сервері.");
  const dest = "/tmp/ffmpeg";
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(ffmpegPath, dest);
    fs.chmodSync(dest, 0o755);
  }
  return dest;
}

const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const WHITE = "lutrgb=r=255:g=255:b=255";

// Чи є прозорість у першому кадрі: true / false, або null, якщо не вдалося прочитати
async function videoHasAlpha(ff, input, decoderArgs) {
  try {
    const { stdout } = await execFileP(
      ff,
      [
        "-v", "error",
        ...decoderArgs,
        "-i", input,
        "-frames:v", "1",
        "-vf", "scale=64:64",
        "-f", "rawvideo",
        "-pix_fmt", "rgba",
        "pipe:1",
      ],
      { encoding: "buffer", timeout: 20000, maxBuffer: 10 * 1024 * 1024 }
    );
    for (let i = 3; i < stdout.length; i += 4) {
      if (stdout[i] < 250) return true;
    }
    return stdout.length > 0 ? false : null;
  } catch (e) {
    return null;
  }
}

// adaptive = true: перетворюємо відео на білий силует, колір підставить Telegram
async function toWebm(buf, isEmoji, adaptive = false) {
  const ff = getFfmpeg();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const input = path.join("/tmp", `in_${id}`);
  const output = path.join("/tmp", `out_${id}.webm`);
  fs.writeFileSync(input, buf);

  // WEBM з прозорістю треба читати декодером libvpx
  let decoderArgs = buf.subarray(0, 4).equals(WEBM_MAGIC) ? ["-c:v", "libvpx-vp9"] : [];

  let silhouette = "";
  if (adaptive) {
    let hasAlpha = await videoHasAlpha(ff, input, decoderArgs);
    if (hasAlpha === null && decoderArgs.length) {
      decoderArgs = [];
      hasAlpha = await videoHasAlpha(ff, input, decoderArgs);
    }
    silhouette = hasAlpha
      ? `${WHITE},`
      : // Немає прозорості: темні пікселі стають непрозорими
        `split[a][b];[a]format=gray,negate[m];[b]${WHITE}[w];[w][m]alphamerge,format=rgba,`;
  }

  const size = isEmoji
    ? "scale=100:100:force_original_aspect_ratio=decrease,pad=100:100:(ow-iw)/2:(oh-ih)/2:color=0x00000000"
    : "scale='if(gt(iw,ih),512,-2)':'if(gt(iw,ih),-2,512)'";

  // Пробуємо від кращої якості до більш стиснутої, поки не влізе в 256 КБ
  const attempts = [
    { crf: 34, fps: 30 },
    { crf: 42, fps: 30 },
    { crf: 50, fps: 24 },
    { crf: 58, fps: 20 },
  ];

  const buildArgs = (a, dec) => [
    "-y",
    ...dec,
    "-i", input,
    "-t", "3",
    "-an",
    "-vf", `fps=${a.fps},format=rgba,${silhouette}${size}`,
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-b:v", "0",
    "-crf", String(a.crf),
    "-auto-alt-ref", "0",
    "-row-mt", "1",
    "-deadline", "good",
    "-cpu-used", "4",
    output,
  ];
  const opts = { timeout: 40000, maxBuffer: 20 * 1024 * 1024 };

  try {
    for (const a of attempts) {
      try {
        await execFileP(ff, buildArgs(a, decoderArgs), opts);
      } catch (e) {
        if (!decoderArgs.length) throw e;
        decoderArgs = []; // можливо, це не VP9, пробуємо звичайний декодер
        await execFileP(ff, buildArgs(a, decoderArgs), opts);
      }
      const out = fs.readFileSync(output);
      if (out.length <= 256 * 1024) return out;
    }
    throw new Error("Не вдалося стиснути відео до 256 КБ. Спробуй простіше або коротше.");
  } finally {
    for (const f of [input, output]) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
  }
}

async function prepare(buf, kind, variant) {
  if (variant === "video" || variant === "adaptive_video") {
    return {
      buffer: await toWebm(buf, kind === "emoji", variant === "adaptive_video"),
      mime: "video/webm",
      filename: "sticker.webm",
    };
  }

  if (kind === "emoji") {
    const out =
      variant === "adaptive"
        ? await toAdaptive(buf)
        : await sharp(buf)
            .resize(100, 100, { fit: "contain", background: TRANSPARENT })
            .png()
            .toBuffer();
    return { buffer: out, mime: "image/png", filename: "emoji.png" };
  }

  // Звичайна наліпка: WEBP, більша сторона 512, до 512 КБ
  let out;
  for (const q of [90, 75, 60, 40]) {
    out = await sharp(buf)
      .resize(512, 512, { fit: "inside" })
      .webp({ quality: q })
      .toBuffer();
    if (out.length <= 500 * 1024) break;
  }
  return { buffer: out, mime: "image/webp", filename: "sticker.webp" };
}

// ---------- Пошук файлу в повідомленні ----------
// Повертає { file, variant }, де variant це те, як саме обробляти цей файл
function pickFile(msg, variant) {
  const mime = msg.document?.mime_type || "";
  const video =
    msg.video ||
    msg.animation ||
    msg.video_note ||
    (msg.document && (mime.startsWith("video/") || mime === "image/gif")
      ? msg.document
      : null);
  const image = msg.photo
    ? msg.photo[msg.photo.length - 1]
    : msg.document && mime.startsWith("image/")
    ? msg.document
    : null;

  if (variant === "adaptive") {
    if (video) return { file: video, variant: "adaptive_video" };
    if (image) return { file: image, variant: "adaptive" };
    return null;
  }
  if (variant === "video") return video ? { file: video, variant: "video" } : null;
  if (variant === "mixed") {
    if (video) return { file: video, variant: "video" };
    if (image) return { file: image, variant: "static" };
    return null;
  }
  return image ? { file: image, variant } : null;
}

// ---------- Завантаження в Telegram ----------
// source: { buffer, mime, filename } для нового файлу або { fileId } для готової наліпки
async function uploadToSet(userId, st, source, emoji, format) {
  const isEmoji = st.kind === "emoji";
  const inputSticker = {
    sticker: source.fileId || "attach://file0",
    format,
    emoji_list: [emoji],
  };

  const baseForm = () => {
    const f = new FormData();
    f.append("user_id", String(userId));
    f.append("name", st.pack_name);
    if (source.buffer) {
      f.append("file0", new Blob([source.buffer], { type: source.mime }), source.filename);
    }
    return f;
  };

  const add = () => {
    const f = baseForm();
    f.append("sticker", JSON.stringify(inputSticker));
    return tgForm("addStickerToSet", f);
  };

  const create = () => {
    const f = baseForm();
    f.append("title", st.title || "Мій набір");
    f.append("stickers", JSON.stringify([inputSticker]));
    if (isEmoji) f.append("sticker_type", "custom_emoji");
    if (st.variant === "adaptive") f.append("needs_repainting", "true");
    return tgForm("createNewStickerSet", f);
  };

  const exists = (await tg("getStickerSet", { name: st.pack_name })).ok;
  if (exists) return add();

  const res = await create();
  // Якщо файли прийшли одночасно і набір уже хтось створив, просто додаємо
  if (!res.ok && /already occupied|already exists/i.test(res.description || "")) {
    return add();
  }
  return res;
}

// Додавання готової наліпки (яку користувач переслав боту)
async function importSticker(msg, st) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const sk = msg.sticker;
  const isEmojiPack = st.kind === "emoji";

  if (sk.type === "mask") {
    return send(chatId, "Маскові наліпки бот не підтримує 🙂");
  }
  const isCustomEmoji = sk.type === "custom_emoji";
  if (!isEmojiPack && isCustomEmoji) {
    return send(
      chatId,
      "Це кастомне емоджі, а зараз створюється набір наліпок. Для емоджі створи окремий набір: /newemoji"
    );
  }

  const format = sk.is_video ? "video" : sk.is_animated ? "animated" : "static";
  const v = st.variant;
  const ok =
    v === "mixed" ||
    v === "adaptive" ||
    (v === "static" && format === "static") ||
    (v === "video" && format !== "static");
  if (!ok) {
    const hint = isEmojiPack
      ? "Для будь-яких емоджі створи набір «Звичайні» (/newemoji)."
      : "Створи змішаний набір (/newsticker → Змішаний), щоб додавати будь-які.";
    const why =
      v === "adaptive"
        ? "В адаптивний набір можна додавати лише нерухомі зображення й емоджі."
        : format === "static"
        ? "Це нерухоме, а набір анімований."
        : "Це анімоване, а набір для нерухомих.";
    return send(chatId, `${why}\n${hint}`);
  }

  try {
    // Наліпки й готові кастомні емоджі додаємо напряму за file_id.
    // Звичайну наліпку для емоджі та неадаптивне емоджі для адаптивного набору перетворюємо.
    const direct =
      !isEmojiPack || (isCustomEmoji && (v !== "adaptive" || sk.needs_repainting));
    let source = { fileId: sk.file_id };
    let fmt = format;

    if (!direct) {
      if (format === "animated") {
        return send(
          chatId,
          "Анімовані (TGS) наліпки не можна перетворити на емоджі. Надішли відео чи GIF або готове кастомне емоджі."
        );
      }
      const buf = await downloadFile(sk.file_id);
      source = await prepare(
        buf,
        "emoji",
        format === "video"
          ? v === "adaptive"
            ? "adaptive_video"
            : "video"
          : v === "adaptive"
          ? "adaptive"
          : "static"
      );
      fmt = format === "video" ? "video" : "static";
    }

    const result = await uploadToSet(userId, st, source, sk.emoji || "😀", fmt);
    if (!result.ok) {
      return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${result.description}`);
    }
    return send(
      chatId,
      `${isEmojiPack ? "Емоджі" : "Наліпку"} додано ✅\n${setLink(st)}\n\nНадсилай ще або натисни /done, щоб завершити.`
    );
  } catch (e) {
    console.error(e);
    return send(chatId, `Не вийшло 😕\n${e.message}`);
  }
}

async function handleMedia(msg, st) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (msg.sticker) return importSticker(msg, st);

  const picked = pickFile(msg, st.variant);
  if (!picked) {
    return send(
      chatId,
      st.variant === "video"
        ? "Для анімованих потрібне відео або GIF 🎞"
        : st.variant === "mixed" || st.variant === "adaptive"
        ? "Надішли картинку, відео або GIF 🖼🎞"
        : "Надішли картинку 🖼 (краще як файл, щоб зберегти прозорість)."
    );
  }
  const f = picked.file;
  const variant = picked.variant;

  if (f.file_size && f.file_size > 20 * 1024 * 1024) {
    return send(chatId, "Файл завеликий: Telegram дозволяє боту брати до 20 МБ 😕");
  }

  const found = (msg.caption || "").match(/\p{Extended_Pictographic}/u);
  const emoji = found ? found[0] : "😀";

  const isVid = variant === "video" || variant === "adaptive_video";
  if (isVid) await send(chatId, "⏳ Обробляю відео...");

  try {
    const buf = await downloadFile(f.file_id);
    const file = await prepare(buf, st.kind, variant);
    const result = await uploadToSet(
      userId,
      st,
      file,
      emoji,
      isVid ? "video" : "static"
    );

    if (!result.ok) {
      return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${result.description}`);
    }
    return send(
      chatId,
      `Готово! ✅\n${setLink(st)}\n\nНадсилай ще або натисни /done, щоб завершити.`
    );
  } catch (e) {
    console.error(e);
    return send(chatId, `Не вийшло 😕\n${e.message}`);
  }
}

// ---------- Головна логіка ----------
function packKeyboard(ts) {
  return {
    inline_keyboard: [
      [
        { text: "➕ Додати", callback_data: `pa:${ts}` },
        { text: "✏️ Перейменувати", callback_data: `pr:${ts}` },
      ],
      [
        { text: "➖ Видалити елемент", callback_data: `px:${ts}` },
        { text: "🗑 Видалити набір", callback_data: `pd:${ts}` },
      ],
      [{ text: "⬅️ До списку", callback_data: "my:list" }],
    ],
  };
}

async function showMyPacks(chatId, userId) {
  const rows = await listPacks(userId);
  if (rows === null) {
    return send(
      chatId,
      "Не вдалося прочитати список 😕 Перевір, чи створена таблиця packs у Supabase."
    );
  }

  const checked = await Promise.all(
    rows.map(async (row) => {
      const r = await tg("getStickerSet", { name: row.pack_name });
      return { row, set: r.ok ? r.result : null, desc: r.description || "" };
    })
  );

  const alive = [];
  for (const c of checked) {
    if (c.set) {
      alive.push(c);
    } else if (
      /STICKERSET_INVALID|not found/i.test(c.desc) &&
      Date.now() - new Date(c.row.created_at).getTime() > 24 * 3600 * 1000
    ) {
      await deletePackRow(c.row.pack_name); // набір давно видалений
    }
  }

  if (!alive.length) {
    return send(
      chatId,
      "У тебе ще немає наборів, створених через цього бота.",
      MAIN_MENU
    );
  }

  const lines = alive.map((c, i) => {
    const label = LABELS[`${c.row.kind}:${c.row.variant}`] || "";
    return `${i + 1}. ${c.set.title} — ${c.set.stickers.length} шт.${label ? " · " + label : ""}`;
  });
  const keyboard = {
    inline_keyboard: alive.map((c, i) => [
      {
        text: `${i + 1}. ${(c.set.title || "").slice(0, 30)}`,
        callback_data: `pm:${tsOf(c.row.pack_name)}`,
      },
    ]),
  };
  return send(chatId, "📚 Твої набори:\n\n" + lines.join("\n") + "\n\nОбери набір, щоб ним керувати.", keyboard);
}

async function packAction(action, ts, chatId, userId) {
  const name = makePackName(ts, userId);
  const row = await getPackRow(userId, name);
  if (!row) return send(chatId, "Набір не знайдено 🤷 Відкрий /mypacks ще раз.");
  const link = setLink({ kind: row.kind, pack_name: name });

  if (action === "pm") {
    const r = await tg("getStickerSet", { name });
    if (!r.ok) return send(chatId, "Цього набору вже немає в Telegram.");
    return send(
      chatId,
      `«${r.result.title}» — ${r.result.stickers.length} шт.\n${link}`,
      packKeyboard(ts)
    );
  }

  if (action === "pa") {
    const variant = row.variant || "mixed";
    await saveState(userId, {
      kind: row.kind,
      variant,
      title: row.title,
      pack_name: name,
      step: "ready",
    });
    return send(
      chatId,
      `Додаємо в «${row.title}» ✅\n\n` +
        (WHAT_TO_SEND[`${row.kind}:${variant}`] ||
          "Надсилай файли або пересилай готові наліпки.") +
        "\n\nЩоб закінчити, натисни /done."
    );
  }

  if (action === "pr") {
    await saveState(userId, { kind: row.kind, title: row.title, pack_name: name, step: "rename" });
    return send(chatId, `Напиши нову назву для «${row.title}» (до 64 символів).`);
  }

  if (action === "px") {
    await saveState(userId, { kind: row.kind, title: row.title, pack_name: name, step: "remove" });
    return send(
      chatId,
      `Перешли мені наліпку (або емоджі) з набору «${row.title}», яку треба видалити.\nЩоб закінчити, натисни /done.`
    );
  }

  if (action === "pd") {
    return send(chatId, `Точно видалити набір «${row.title}»? Це незворотно.`, {
      inline_keyboard: [
        [
          { text: "Так, видалити", callback_data: `pdy:${ts}` },
          { text: "Скасувати", callback_data: `pm:${ts}` },
        ],
      ],
    });
  }

  if (action === "pdy") {
    const res = await tg("deleteStickerSet", { name });
    if (!res.ok) {
      return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${res.description}`);
    }
    await deletePackRow(name);
    await saveState(userId, { step: null, pack_name: null });
    return send(chatId, "Набір видалено 🗑", MAIN_MENU);
  }
}

async function startClone(chatId, userId) {
  await saveState(userId, { step: "clone" });
  return send(
    chatId,
    "Надішли мені будь-яку наліпку (або кастомне емоджі) з набору, який хочеш скопіювати.\n\n" +
      "Я зроблю його копію, яку зможу редагувати: додавати, видаляти, перейменовувати. " +
      "Telegram не дозволяє ботам змінювати набори, створені не ними, тому потрібна копія. " +
      "Користуйся цим для своїх наборів."
  );
}

// Копіює весь набір в новий, який належить боту
async function cloneSet(msg, st) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const sk = msg.sticker;

  if (!sk.set_name) {
    return send(
      chatId,
      "Ця наліпка не належить жодному набору. Надішли наліпку з набору, який хочеш скопіювати."
    );
  }
  const srcRes = await tg("getStickerSet", { name: sk.set_name });
  if (!srcRes.ok) {
    return send(chatId, `Не вдалося відкрити набір 😕\n${srcRes.description}`);
  }
  const src = srcRes.result;
  if (src.sticker_type === "mask") {
    return send(chatId, "Маскові набори бот не підтримує 🙂");
  }

  const isEmoji = src.sticker_type === "custom_emoji";
  const kind = isEmoji ? "emoji" : "sticker";
  const items = src.stickers;
  const toInput = (x) => ({
    sticker: x.file_id,
    format: x.is_video ? "video" : x.is_animated ? "animated" : "static",
    emoji_list: [x.emoji || "😀"],
  });

  // Можливо, цей набір уже копіювали і треба продовжити
  let name = null;
  let title = null;
  let i = 0;
  const prev = await findCloneRow(userId, src.name);
  if (prev) {
    const cur = await tg("getStickerSet", { name: prev.pack_name });
    if (cur.ok) {
      name = prev.pack_name;
      title = prev.title;
      i = cur.result.stickers.length;
    }
  }
  if (name && i >= items.length) {
    return send(
      chatId,
      `Цей набір уже повністю скопійовано ✅\n${setLink({ kind, pack_name: name })}\n\n` +
        "Щоб зробити нову копію, спершу видали стару в /mypacks."
    );
  }

  await send(chatId, `⏳ Копіюю «${src.title}» (${items.length} шт.)...`);
  const deadline = Date.now() + 45000;
  let failed = 0;

  if (!name) {
    name = makePackName(Date.now().toString(36), userId);
    title = `${src.title} (копія)`.slice(0, 64);
    const body = {
      user_id: userId,
      name,
      title,
      stickers: [toInput(items[0])],
      sticker_type: isEmoji ? "custom_emoji" : "regular",
    };
    if (isEmoji && items[0].needs_repainting) body.needs_repainting = true;
    const created = await tg("createNewStickerSet", body);
    if (!created.ok) {
      return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${created.description}`);
    }
    await recordPack({
      pack_name: name,
      user_id: userId,
      title,
      kind,
      variant: "mixed",
      source_set: src.name,
    });
    i = 1;
  }

  for (; i < items.length; i++) {
    if (Date.now() > deadline) break;
    const r = await tg("addStickerToSet", { user_id: userId, name, sticker: toInput(items[i]) });
    if (!r.ok) {
      failed++;
      console.error("clone add failed:", r.description);
    }
  }

  const link = setLink({ kind, pack_name: name });
  if (i < items.length) {
    return send(
      chatId,
      `Скопійовано ${i - failed} із ${items.length}, а далі не вистачило часу.\n${link}\n\n` +
        "Надішли наліпку з того ж набору ще раз, щоб продовжити."
    );
  }

  await saveState(userId, { kind, variant: "mixed", title, pack_name: name, step: "ready" });
  return send(
    chatId,
    `Готово! ✅ Скопійовано ${items.length - failed} із ${items.length}.\n${link}\n\n` +
      "Тепер можна додавати сюди нові наліпки або керувати набором через /mypacks." +
      (failed ? `\n(${failed} не вдалося скопіювати)` : "")
  );
}

async function handleCallback(cq) {
  await tg("answerCallbackQuery", { callback_query_id: cq.id });
  const chatId = cq.message.chat.id;
  const userId = cq.from.id;
  const [a, kind, variant] = (cq.data || "").split(":");

  if (a === "my") return showMyPacks(chatId, userId);
  if (a === "cl") return startClone(chatId, userId);
  if (["pm", "pa", "pr", "px", "pd", "pdy"].includes(a)) {
    return packAction(a, kind, chatId, userId);
  }

  if (a === "new") {
    if (kind === "sticker") return beginPack(chatId, userId, "sticker", "mixed");
    return send(chatId, "Які емоджі створюємо?", EMOJI_TYPES);
  }

  if (a === "t" && LABELS[`${kind}:${variant}`]) {
    return beginPack(chatId, userId, kind, variant);
  }
}

async function beginPack(chatId, userId, kind, variant) {
  const saved = await saveState(userId, {
    kind,
    variant,
    step: "title",
    title: null,
    pack_name: null,
  });
  await send(
    chatId,
    (kind === "sticker"
      ? "Створюємо стікер-пак ✅"
      : `Обрано: ${LABELS[`${kind}:${variant}`]} ✅`) +
      "\n\nТепер напиши назву набору (до 64 символів)."
  );
  if (!saved) {
    await send(
      chatId,
      "⚠️ База даних не відповідає, тому бот може «забути» твій вибір. Адміністратору: напиши /debug."
    );
  }
}

const ADMIN_HELP = "\n\nКоманда адміністратора:\n/debug — перевірка бази даних";

async function handleUpdate(update) {
  const cq = update.callback_query;
  const msg = update.message;
  const from = cq ? cq.from : msg && msg.from;
  if (!from) return;

  const userId = from.id;
  const chatId = cq ? cq.message.chat.id : msg.chat.id;
  const isAdmin = ADMIN_ID !== "" && String(userId) === ADMIN_ID;
  const text = msg ? (msg.text || "").trim() : "";
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : "";

  // /id: показує Telegram ID людини
  if (cmd === "/id") return send(chatId, `Твій Telegram ID: ${userId}`);

  if (cq) return handleCallback(cq);
  if (!msg) return;

  // Команди
  if (cmd) {
    if (cmd === "/start") {
      return send(
        chatId,
        "Привіт! 👋 Я роблю наліпки та кастомні емоджі.\nЩо створюємо?",
        MAIN_MENU
      );
    }
    if (cmd === "/help") {
      return send(chatId, HELP_TEXT + (isAdmin ? ADMIN_HELP : ""), MAIN_MENU);
    }
    if (cmd === "/newsticker" || cmd === "/sticker") {
      return beginPack(chatId, userId, "sticker", "mixed");
    }
    if (cmd === "/newemoji" || cmd === "/emoji") {
      return send(chatId, "Які емоджі створюємо?", EMOJI_TYPES);
    }
    if (cmd === "/mypacks" || cmd === "/mysets") return showMyPacks(chatId, userId);
    if (cmd === "/clonepack") return startClone(chatId, userId);
    if (cmd === "/cancel") {
      await saveState(userId, { step: null });
      return send(chatId, "Скасовано. Щоб почати знову, натисни /start", MAIN_MENU);
    }
    if (cmd === "/done") {
      const st = await getState(userId);
      await saveState(userId, { step: null });
      if (st.pack_name) {
        const exists = (await tg("getStickerSet", { name: st.pack_name })).ok;
        if (exists) {
          return send(chatId, `Набір завершено 🎉\n${setLink(st)}`, MAIN_MENU);
        }
      }
      return send(chatId, "Поки що нічого не створено. Почнемо?", MAIN_MENU);
    }

    // Команда адміністратора
    if (cmd === "/debug") {
      if (!isAdmin) return send(chatId, "Ця команда лише для адміністратора.");
      return send(chatId, await debugSupabase(userId));
    }

    return send(chatId, "Не знаю такої команди. Спробуй /help");
  }

  const st = await getState(userId);

  // Очікуємо назву набору
  if (st.step === "title") {
    if (!text) {
      return send(chatId, "Спершу напиши назву набору текстом ✍️");
    }
    if (text.length > 64) {
      return send(chatId, "Назва задовга, максимум 64 символи. Спробуй коротше.");
    }
    const packName = makePackName(Date.now().toString(36), userId);
    await saveState(userId, { title: text, pack_name: packName, step: "ready" });
    await recordPack({
      pack_name: packName,
      user_id: userId,
      title: text,
      kind: st.kind,
      variant: st.variant,
    });
    return send(
      chatId,
      `Назва: «${text}» ✅\n\n${WHAT_TO_SEND[`${st.kind}:${st.variant}`]}\n\n` +
        "Щоб прив'язати своє емоджі, напиши його в підписі до файлу. Краще надсилай файли по одному." +
        (st.kind === "sticker"
          ? "\n\nМожна також переслати мені готові наліпки з інших наборів, і я додам їх сюди."
          : "\n\nМожна також переслати готові кастомні емоджі, і я додам їх сюди.")
    );
  }

  // Перейменування набору
  if (st.step === "rename") {
    if (!text) return send(chatId, "Напиши нову назву текстом ✍️");
    if (text.length > 64) {
      return send(chatId, "Назва задовга, максимум 64 символи. Спробуй коротше.");
    }
    const res = await tg("setStickerSetTitle", { name: st.pack_name, title: text });
    if (!res.ok) {
      return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${res.description}`);
    }
    await updatePackRow(st.pack_name, { title: text });
    await saveState(userId, { step: null, title: text });
    return send(chatId, `Готово ✅ Нова назва: «${text}»`, MAIN_MENU);
  }

  // Видалення елемента з набору
  if (st.step === "remove") {
    const sk = msg.sticker;
    if (!sk) {
      return send(
        chatId,
        "Перешли мені наліпку (або емоджі) з цього набору, яку треба видалити. Щоб закінчити, натисни /done."
      );
    }
    if (sk.set_name !== st.pack_name) {
      return send(chatId, "Ця наліпка з іншого набору. Перешли наліпку з вибраного набору.");
    }
    const res = await tg("deleteStickerFromSet", { sticker: sk.file_id });
    if (!res.ok) {
      return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${res.description}`);
    }
    return send(chatId, "Видалено ✅ Пересилай ще або натисни /done.");
  }

  // Копіювання старого набору
  if (st.step === "clone") {
    if (!msg.sticker) {
      return send(
        chatId,
        "Надішли саме наліпку (або кастомне емоджі) з набору, який треба скопіювати. Щоб скасувати, натисни /cancel."
      );
    }
    return cloneSet(msg, st);
  }

  // Готові приймати файли
  if (st.step === "ready" && st.kind && st.variant && st.pack_name) {
    return handleMedia(msg, st);
  }

  await send(chatId, "Спершу створи набір 👇", MAIN_MENU);
  if (isAdmin) {
    // Автоматична діагностика для адміністратора
    await send(
      chatId,
      "🔧 Діагностика (бачиш лише ти).\nЩо бот пам'ятає про тебе: " +
        JSON.stringify(st) +
        "\n\n" +
        (await debugSupabase(userId))
    );
  }
}

// ---------- Точка входу для Vercel ----------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");

  // Перевірка, що запит справді від Telegram
  if (SECRET && req.headers["x-telegram-bot-api-secret-token"] !== SECRET) {
    return res.status(401).send("Unauthorized");
  }

  try {
    await handleUpdate(req.body);
  } catch (e) {
    console.error(e);
  }
  res.status(200).send("OK");
};
