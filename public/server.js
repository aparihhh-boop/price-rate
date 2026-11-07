const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = __dirname;
const DATA_FILE = path.resolve(process.env.MEOWMI_DATA_FILE || path.join(ROOT, "data", "meowmi.json"));
const DATA_DIR = path.dirname(DATA_FILE);
const OWNER_AUTH_FILE = path.join(DATA_DIR, "owner-auth.json");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ADMIN_PASSWORD = process.env.MEOWMI_ADMIN_PASSWORD;
const SESSION_TTL = 12 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const orderAttempts = new Map();
const lookupAttempts = new Map();
let ownerAuth = null;
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const initialStore = {
  games: [
    { id: "game-rov", name: "ROV", active: true },
    { id: "game-valorant", name: "VALORANT", active: true },
    { id: "game-roblox", name: "Roblox", active: true },
  ],
  skins: [],
  settings: { lineUrl: "", otherContactLabel: "", otherContactUrl: "" },
  orders: [],
  history: [],
};

let store;
let writeQueue = Promise.resolve();

async function loadOwnerAuth() {
  try {
    const saved = JSON.parse(await fs.readFile(OWNER_AUTH_FILE, "utf8"));
    if (!/^[a-f0-9]{32}$/i.test(saved.salt) || !/^[a-f0-9]{128}$/i.test(saved.hash)) {
      throw new Error("รูปแบบไฟล์รหัสผ่านเจ้าของร้านไม่ถูกต้อง");
    }
    return saved;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function loadStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const saved = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    const games = Array.isArray(saved.games) ? saved.games : initialStore.games;
    const skins = Array.isArray(saved.skins) ? saved.skins : initialStore.skins;
    const isLegacyDemo = !(saved.orders || []).length &&
      games.length === 3 &&
      games.some((game) => game.id === "game-genshin") &&
      games.some((game) => game.id === "game-hsr") &&
      games.some((game) => game.id === "game-valorant") &&
      skins.length === 3 &&
      skins.some((skin) => skin.id === "skin-moonlight") &&
      skins.some((skin) => skin.id === "skin-crystal") &&
      skins.some((skin) => skin.id === "skin-starlight");
    const loaded = {
      games: isLegacyDemo ? structuredClone(initialStore.games) : games,
      skins: (isLegacyDemo ? initialStore.skins : skins).map((skin) => ({
        ...skin,
        type: skin.type === "skin" ? "skin" : "package",
        quantity: Number.isFinite(Number(skin.quantity)) ? Number(skin.quantity) : null,
        unit: typeof skin.unit === "string" ? skin.unit : "",
        promoPrice: skin.promoPrice === null || skin.promoPrice === undefined || skin.promoPrice === ""
          ? null
          : Number.isFinite(Number(skin.promoPrice)) ? Number(skin.promoPrice) : null,
        promoLabel: typeof skin.promoLabel === "string" ? skin.promoLabel : "",
        imageUrl: typeof skin.imageUrl === "string" ? skin.imageUrl : "",
      })),
      settings: {
        ...initialStore.settings,
        ...(saved.settings && typeof saved.settings === "object" ? saved.settings : {}),
      },
      orders: Array.isArray(saved.orders) ? saved.orders : [],
      history: Array.isArray(saved.history) ? saved.history : [],
    };
    if (isLegacyDemo || !saved.settings || skins.some((skin) => skin.type === undefined || skin.promoPrice === undefined || skin.imageUrl === undefined)) {
      await fs.writeFile(DATA_FILE, JSON.stringify(loaded, null, 2), "utf8");
    }
    return loaded;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.writeFile(DATA_FILE, JSON.stringify(initialStore, null, 2), "utf8");
    return structuredClone(initialStore);
  }
}

function persistStore() {
  const contents = JSON.stringify(store, null, 2);
  writeQueue = writeQueue.then(async () => {
    const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, contents, "utf8");
    await fs.rename(temporaryFile, DATA_FILE);
  });
  return writeQueue;
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function readBody(request, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(Object.assign(new Error("คำขอมีขนาดใหญ่เกินไป"), { status: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error("รูปแบบข้อมูลไม่ถูกต้อง"), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function cleanText(value, maxLength = 180) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function requireText(value, label, maxLength = 180) {
  const text = cleanText(value, maxLength);
  if (!text) throw Object.assign(new Error(`กรุณากรอก${label}`), { status: 400 });
  return text;
}

function cleanImageUrl(value) {
  const imageUrl = cleanText(value, 2048);
  if (!imageUrl) return "";
  if (/^\/uploads\/[a-f0-9-]+\.(?:png|jpe?g|webp)$/i.test(imageUrl)) return imageUrl;
  try {
    const url = new URL(imageUrl);
    if (url.protocol === "https:" && !url.username && !url.password) return url.toString();
  } catch {
    // Invalid image URLs are rejected below.
  }
  throw Object.assign(new Error("รูปภาพต้องเป็น HTTPS URL หรือรูปที่อัปโหลดเข้าระบบ"), { status: 400 });
}

function getImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: "png", mimeType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { extension: "webp", mimeType: "image/webp" };
  }
  return null;
}

function addHistory(orderId, action, actor) {
  store.history.unshift({
    id: crypto.randomUUID(),
    orderId,
    action,
    actor,
    createdAt: new Date().toISOString(),
  });
}

function getSession(request) {
  const cookie = request.headers.cookie || "";
  const token = cookie.match(/(?:^|;\s*)meowmi_session=([a-f0-9]+)/)?.[1];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL;
  return token;
}

function requireOwner(request, response) {
  if (!getSession(request)) {
    sendJson(response, 401, { error: "กรุณาเข้าสู่ระบบเจ้าของร้านก่อน" });
    return false;
  }
  return true;
}

function startOwnerSession(response) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL });
  sendJson(response, 200, { ok: true }, {
    "Set-Cookie": `meowmi_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
  });
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function getOrder(orderId) {
  return store.orders.find((order) => order.id === orderId || order.orderNumber === orderId);
}

function orderSummary(order) {
  const paid = Number(order.paidAmount || 0);
  const cost = Number(order.cost || 0);
  return {
    ...order,
    remainingAmount: order.status === "ยกเลิก" ? 0 : Math.max(0, Number(order.total) - paid),
    profit: order.status === "สำเร็จ" ? paid - cost : 0,
    installments: (order.installments || []).map((installment) => ({
      ...installment,
      paid: installment.payments.reduce((sum, payment) => sum + payment.amount, 0),
      remaining: Math.max(0, installment.amount - installment.payments.reduce((sum, payment) => sum + payment.amount, 0)),
    })),
  };
}

async function notifyLineOwner(message) {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const ownerId = process.env.LINE_OWNER_USER_ID;
  if (!accessToken || !ownerId) return "not_configured";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const result = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: ownerId,
        messages: [{ type: "text", text: message.slice(0, 4900) }],
      }),
      signal: controller.signal,
    });
    if (!result.ok) {
      console.error(`LINE OA notification failed with HTTP ${result.status}`);
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.error("LINE OA notification failed:", error.message);
    return "failed";
  } finally {
    clearTimeout(timeout);
  }
}

function parseId(value) {
  return /^[a-zA-Z0-9-]{1,80}$/.test(value);
}

function allowRateLimitedRequest(request, attempts, maximum, windowMs) {
  const address = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = attempts.get(address);
  if (!entry || entry.resetAt <= now) {
    attempts.set(address, { count: 1, resetAt: now + windowMs });
    if (attempts.size > 1000) {
      for (const [key, value] of attempts) {
        if (value.resetAt <= now) attempts.delete(key);
      }
    }
    return true;
  }
  if (entry.count >= maximum) return false;
  entry.count += 1;
  return true;
}

async function handleApi(request, response, url) {
  const method = request.method;
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/api/catalog") {
    return sendJson(response, 200, {
      games: store.games.filter((game) => game.active),
      skins: store.skins.filter((skin) => skin.active && store.games.some((game) => game.id === skin.gameId && game.active)).map((skin) => ({
        id: skin.id,
        gameId: skin.gameId,
        type: skin.type || "package",
        name: skin.name,
        quantity: skin.quantity,
        unit: skin.unit,
        description: skin.description,
        price: skin.price,
        promoPrice: skin.promoPrice,
        promoLabel: skin.promoLabel,
      })),
      settings: store.settings,
    });
  }

  if (pathname === "/api/orders" || pathname.startsWith("/api/orders/")) {
    return sendJson(response, 410, { error: "เว็บนี้ใช้สำหรับค้นหาและดูราคา กรุณาติดต่อร้านเพื่อสั่งซื้อ" });
  }

  if (method === "POST" && pathname === "/api/orders") {
    if (!allowRateLimitedRequest(request, orderAttempts, 12, 15 * 60 * 1000)) {
      return sendJson(response, 429, { error: "ส่งคำขอหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่" });
    }
    const body = await readBody(request);
    const customerName = requireText(body.customerName, "ชื่อที่ใช้ติดต่อ", 80);
    const contact = requireText(body.contact, "ช่องทางติดต่อ", 120);
    const gameAccount = requireText(body.gameAccount, "ข้อมูลผู้เล่น", 100);
    const skin = store.skins.find((item) => item.id === body.skinId && item.active);
    if (!skin || !store.games.some((game) => game.id === skin.gameId && game.active)) {
      throw Object.assign(new Error("ไม่พบสินค้าที่เลือก กรุณาโหลดหน้าเว็บใหม่"), { status: 400 });
    }
    const game = store.games.find((item) => item.id === skin.gameId);
    const now = new Date();
    const datePart = now.toISOString().slice(2, 10).replaceAll("-", "");
    const orderNumber = `MM-${datePart}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const order = {
      id: crypto.randomUUID(),
      orderNumber,
      customerName,
      contact,
      gameAccount,
      gameId: game.id,
      gameName: game.name,
      skinId: skin.id,
      skinName: skin.name,
      quantity: skin.quantity,
      unit: skin.unit,
      total: Number(skin.price),
      cost: Number(skin.cost || 0),
      paidAmount: 0,
      status: "รอตรวจสอบ",
      note: cleanText(body.note, 500),
      installments: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    store.orders.unshift(order);
    addHistory(order.id, "ลูกค้าส่งคำขอสั่งซื้อ — รอตรวจสอบ", "ลูกค้า");
    await persistStore();
    const notification = await notifyLineOwner(
      `🐱 มีคำขอออเดอร์ใหม่ ${orderNumber}\nลูกค้า: ${customerName}\nสินค้า: ${game.name} / ${skin.name}\nยอด: ฿${order.total}\nกรุณาเข้าหลังบ้านเพื่อตรวจสอบก่อนยืนยัน`
    );
    return sendJson(response, 201, {
      order: { orderNumber, status: order.status, total: order.total },
      notification,
    });
  }

  if (method === "GET" && pathname === "/api/orders/lookup") {
    if (!allowRateLimitedRequest(request, lookupAttempts, 30, 15 * 60 * 1000)) {
      return sendJson(response, 429, { error: "ค้นหาบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่" });
    }
    const orderNumber = cleanText(url.searchParams.get("number"), 40);
    const contact = cleanText(url.searchParams.get("contact"), 120).toLowerCase();
    const order = store.orders.find((item) =>
      item.orderNumber.toLowerCase() === orderNumber.toLowerCase() &&
      item.contact.toLowerCase() === contact
    );
    if (!order) return sendJson(response, 404, { error: "ไม่พบออเดอร์ กรุณาตรวจเลขออเดอร์และช่องทางติดต่อ" });
    return sendJson(response, 200, {
      order: {
        orderNumber: order.orderNumber,
        gameName: order.gameName,
        skinName: order.skinName,
        quantity: order.quantity,
        unit: order.unit,
        total: order.total,
        paidAmount: order.paidAmount,
        remainingAmount: order.status === "ยกเลิก" ? 0 : Math.max(0, order.total - order.paidAmount),
        status: order.status,
        createdAt: order.createdAt,
        installments: orderSummary(order).installments,
      },
      history: store.history.filter((event) => event.orderId === order.id).map((event) => ({
        action: event.action,
        createdAt: event.createdAt,
      })),
    });
  }

  if (method === "POST" && pathname === "/api/admin/login") {
    if (!ADMIN_PASSWORD && !ownerAuth) return sendJson(response, 503, { error: "กรุณาตั้งรหัสผ่านเจ้าของร้านก่อน" });
    const address = request.socket.remoteAddress || "unknown";
    const attempts = loginAttempts.get(address) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
    if (attempts.resetAt < Date.now()) {
      attempts.count = 0;
      attempts.resetAt = Date.now() + 15 * 60 * 1000;
    }
    if (attempts.count >= 8) return sendJson(response, 429, { error: "ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอ 15 นาที" });
    const body = await readBody(request);
    const suppliedPassword = typeof body.password === "string" ? body.password : "";
    let passwordMatches = false;
    if (ADMIN_PASSWORD) {
      const expectedHash = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
      const suppliedHash = crypto.createHash("sha256").update(suppliedPassword).digest();
      passwordMatches = crypto.timingSafeEqual(expectedHash, suppliedHash);
    } else if (ownerAuth) {
      const expectedHash = Buffer.from(ownerAuth.hash, "hex");
      const suppliedHash = crypto.scryptSync(suppliedPassword, Buffer.from(ownerAuth.salt, "hex"), 64);
      passwordMatches = crypto.timingSafeEqual(expectedHash, suppliedHash);
    }
    if (!passwordMatches) {
      attempts.count += 1;
      loginAttempts.set(address, attempts);
      return sendJson(response, 401, { error: "รหัสผ่านไม่ถูกต้อง" });
    }
    loginAttempts.delete(address);
    return startOwnerSession(response);
  }

  if (method === "POST" && pathname === "/api/admin/setup") {
    if (ADMIN_PASSWORD || ownerAuth) return sendJson(response, 409, { error: "ตั้งรหัสผ่านเจ้าของร้านไว้แล้ว" });
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return sendJson(response, 403, { error: "ตั้งรหัสผ่านครั้งแรกได้จากเครื่องที่เปิดเซิร์ฟเวอร์เท่านั้น" });
    }
    const body = await readBody(request);
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 12 || password.length > 200) {
      return sendJson(response, 400, { error: "รหัสผ่านต้องมีความยาว 12 ถึง 200 ตัวอักษร" });
    }
    const salt = crypto.randomBytes(16);
    const auth = {
      salt: salt.toString("hex"),
      hash: crypto.scryptSync(password, salt, 64).toString("hex"),
    };
    try {
      await fs.writeFile(OWNER_AUTH_FILE, JSON.stringify(auth), { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error.code === "EEXIST") {
        ownerAuth = await loadOwnerAuth();
        return sendJson(response, 409, { error: "ตั้งรหัสผ่านเจ้าของร้านไว้แล้ว" });
      }
      throw error;
    }
    ownerAuth = auth;
    return startOwnerSession(response);
  }

  if (method === "GET" && pathname === "/api/admin/session") {
    return sendJson(response, 200, {
      authenticated: Boolean(getSession(request)),
      setupRequired: !ADMIN_PASSWORD && !ownerAuth,
    });
  }

  if (method === "POST" && pathname === "/api/admin/logout") {
    const token = getSession(request);
    if (token) sessions.delete(token);
    return sendJson(response, 200, { ok: true }, {
      "Set-Cookie": "meowmi_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    });
  }

  if (!pathname.startsWith("/api/admin/")) {
    return sendJson(response, 404, { error: "ไม่พบ API ที่เรียกใช้" });
  }
  if (!requireOwner(request, response)) return;

  if (method === "GET" && pathname === "/api/admin/catalog") {
    return sendJson(response, 200, { games: store.games, skins: store.skins, settings: store.settings });
  }

  if (method === "PATCH" && pathname === "/api/admin/settings") {
    const body = await readBody(request);
    const lineUrl = cleanText(body.lineUrl, 2048);
    const otherContactUrl = cleanText(body.otherContactUrl, 2048);
    for (const [label, value] of [["LINE OA", lineUrl], ["ช่องทางอื่น", otherContactUrl]]) {
      if (!value) continue;
      try {
        const parsed = new URL(value);
        if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
          throw new Error("invalid URL");
        }
      } catch {
        return sendJson(response, 400, { error: `ลิงก์${label}ต้องเป็น URL ที่ถูกต้อง` });
      }
    }
    store.settings = {
      lineUrl,
      otherContactLabel: cleanText(body.otherContactLabel, 40),
      otherContactUrl,
    };
    await persistStore();
    return sendJson(response, 200, { settings: store.settings });
  }

  if (method === "POST" && pathname === "/api/admin/images") {
    const body = await readBody(request, 7 * 1024 * 1024);
    const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl : "";
    const match = dataUrl.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) return sendJson(response, 400, { error: "รองรับรูป PNG, JPG หรือ WebP เท่านั้น" });
    const image = Buffer.from(match[1], "base64");
    if (!image.length || image.length > 5 * 1024 * 1024) {
      return sendJson(response, 413, { error: "รูปภาพต้องมีขนาดไม่เกิน 5 MB" });
    }
    const imageType = getImageType(image);
    if (!imageType) return sendJson(response, 400, { error: "ข้อมูลไฟล์ไม่ใช่รูป PNG, JPG หรือ WebP ที่ถูกต้อง" });
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const filename = `${crypto.randomUUID()}.${imageType.extension}`;
    await fs.writeFile(path.join(UPLOAD_DIR, filename), image, { flag: "wx" });
    return sendJson(response, 201, { imageUrl: `/uploads/${filename}` });
  }

  if (method === "POST" && pathname === "/api/admin/games") {
    const body = await readBody(request);
    const name = requireText(body.name, "ชื่อเกม", 80);
    const game = { id: crypto.randomUUID(), name, active: true };
    store.games.push(game);
    addHistory("", `เพิ่มเกม ${name}`, "เจ้าของร้าน");
    await persistStore();
    return sendJson(response, 201, { game });
  }

  const gameMatch = pathname.match(/^\/api\/admin\/games\/([^/]+)$/);
  if (method === "PATCH" && gameMatch && parseId(gameMatch[1])) {
    const body = await readBody(request);
    const game = store.games.find((item) => item.id === gameMatch[1]);
    if (!game) return sendJson(response, 404, { error: "ไม่พบเกม" });
    if (body.name !== undefined) game.name = requireText(body.name, "ชื่อเกม", 80);
    if (body.active !== undefined) game.active = Boolean(body.active);
    addHistory("", `แก้ไขเกม ${game.name}`, "เจ้าของร้าน");
    await persistStore();
    return sendJson(response, 200, { game });
  }

  if (method === "POST" && pathname === "/api/admin/skins") {
    const body = await readBody(request);
    const game = store.games.find((item) => item.id === body.gameId && item.active);
    if (!game) return sendJson(response, 400, { error: "กรุณาเลือกเกมที่เปิดใช้งาน" });
    const type = body.type === undefined || body.type === "package" ? "package" : body.type;
    if (type !== "package" && type !== "skin") return sendJson(response, 400, { error: "ประเภทสินค้าต้องเป็นแพ็กหรือ Skin" });
    const price = Number(body.price);
    const cost = body.cost === undefined || body.cost === "" ? 0 : Number(body.cost);
    const quantity = body.quantity === undefined || body.quantity === "" ? null : Number(body.quantity);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(cost) || cost < 0) {
      return sendJson(response, 400, { error: "กรุณาตรวจสอบราคาขายและต้นทุน (ต้นทุนต้องไม่ติดลบ)" });
    }
    if (type === "package" && (!Number.isInteger(quantity) || quantity <= 0)) {
      return sendJson(response, 400, { error: "จำนวนแต้ม/คูปองต้องเป็นจำนวนเต็มมากกว่า 0" });
    }
    if (type === "skin" && quantity !== null && (!Number.isInteger(quantity) || quantity <= 0)) {
      return sendJson(response, 400, { error: "จำนวนต้องเป็นจำนวนเต็มมากกว่า 0" });
    }
    const promoPrice = body.promoPrice === undefined || body.promoPrice === "" ? null : Number(body.promoPrice);
    if (promoPrice !== null && (!Number.isFinite(promoPrice) || promoPrice <= 0 || promoPrice >= price)) {
      return sendJson(response, 400, { error: "ราคาโปรโมชันต้องมากกว่า 0 และต่ำกว่าราคาปกติ" });
    }
    const skin = {
      id: crypto.randomUUID(),
      gameId: game.id,
      type,
      name: requireText(body.name, "ชื่อสินค้า", 100),
      quantity,
      unit: type === "package" ? requireText(body.unit, "หน่วยของแพ็ก", 30) : cleanText(body.unit, 30),
      description: cleanText(body.description, 250),
      price: Math.round(price * 100) / 100,
      cost: Math.round(cost * 100) / 100,
      promoPrice: promoPrice === null ? null : Math.round(promoPrice * 100) / 100,
      promoLabel: cleanText(body.promoLabel, 40),
      imageUrl: cleanImageUrl(body.imageUrl),
      active: true,
    };
    store.skins.push(skin);
    addHistory("", `เพิ่มสินค้า ${skin.name}`, "เจ้าของร้าน");
    await persistStore();
    return sendJson(response, 201, { skin });
  }

  const skinMatch = pathname.match(/^\/api\/admin\/skins\/([^/]+)$/);
  if (method === "PATCH" && skinMatch && parseId(skinMatch[1])) {
    const body = await readBody(request);
    const skin = store.skins.find((item) => item.id === skinMatch[1]);
    if (!skin) return sendJson(response, 404, { error: "ไม่พบสินค้า" });
    const type = body.type === undefined ? (skin.type || "package") : body.type;
    if (type !== "package" && type !== "skin") return sendJson(response, 400, { error: "ประเภทสินค้าต้องเป็นแพ็กหรือ Skin" });
    const price = body.price === undefined ? skin.price : Number(body.price);
    const cost = body.cost === undefined ? skin.cost : Number(body.cost);
    const quantity = body.quantity === undefined
      ? skin.quantity === null || skin.quantity === undefined ? null : Number(skin.quantity)
      : body.quantity === "" ? null : Number(body.quantity);
    const nextPrice = Math.round(price * 100) / 100;
    const promoPrice = body.promoPrice === undefined
      ? skin.promoPrice
      : body.promoPrice === "" ? null : Number(body.promoPrice);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(cost) || cost < 0) {
      return sendJson(response, 400, { error: "กรุณาตรวจสอบราคาขายและต้นทุน" });
    }
    if (type === "package" && (!Number.isInteger(quantity) || quantity <= 0)) {
      return sendJson(response, 400, { error: "จำนวนแต้ม/คูปองต้องเป็นจำนวนเต็มมากกว่า 0" });
    }
    if (type === "skin" && quantity !== null && (!Number.isInteger(quantity) || quantity <= 0)) {
      return sendJson(response, 400, { error: "จำนวนต้องเป็นจำนวนเต็มมากกว่า 0" });
    }
    if (promoPrice !== null && (!Number.isFinite(promoPrice) || promoPrice <= 0 || promoPrice >= nextPrice)) {
      return sendJson(response, 400, { error: "ราคาโปรโมชันต้องมากกว่า 0 และต่ำกว่าราคาปกติ" });
    }
    if (body.gameId !== undefined && !store.games.some((game) => game.id === body.gameId)) {
      return sendJson(response, 400, { error: "ไม่พบเกมที่เลือก" });
    }
    skin.type = type;
    skin.name = body.name === undefined ? skin.name : requireText(body.name, "ชื่อสินค้า", 100);
    skin.quantity = quantity;
    skin.unit = body.unit === undefined
      ? (type === "package" ? (skin.unit || "แพ็ก") : "")
      : type === "package" ? requireText(body.unit, "หน่วยของแพ็ก", 30) : cleanText(body.unit, 30);
    skin.description = body.description === undefined ? skin.description : cleanText(body.description, 250);
    skin.price = nextPrice;
    skin.cost = Math.round(cost * 100) / 100;
    skin.promoPrice = promoPrice === null ? null : Math.round(promoPrice * 100) / 100;
    if (body.promoLabel !== undefined) skin.promoLabel = cleanText(body.promoLabel, 40);
    if (body.imageUrl !== undefined) skin.imageUrl = cleanImageUrl(body.imageUrl);
    if (body.gameId !== undefined) skin.gameId = body.gameId;
    if (body.active !== undefined) skin.active = Boolean(body.active);
    addHistory("", `แก้ไขสินค้า/ราคา ${skin.name}`, "เจ้าของร้าน");
    await persistStore();
    return sendJson(response, 200, { skin });
  }

  if (method === "GET" && pathname === "/api/admin/orders") {
    const status = url.searchParams.get("status");
    const orders = store.orders
      .filter((order) => !status || status === "ทั้งหมด" || order.status === status)
      .map(orderSummary);
    return sendJson(response, 200, { orders });
  }

  if (method === "GET" && pathname === "/api/admin/history") {
    return sendJson(response, 200, {
      history: store.history.slice(0, 500),
      customers: [...new Map(store.orders.map((order) => [
        order.contact.toLowerCase(),
        {
          name: order.customerName,
          contact: order.contact,
          orderCount: store.orders.filter((item) => item.contact.toLowerCase() === order.contact.toLowerCase()).length,
          totalSpent: store.orders.filter((item) => item.contact.toLowerCase() === order.contact.toLowerCase())
            .reduce((sum, item) => sum + Number(item.paidAmount || 0), 0),
          lastOrderAt: store.orders
            .filter((item) => item.contact.toLowerCase() === order.contact.toLowerCase())
            .reduce((latest, item) => item.createdAt > latest ? item.createdAt : latest, ""),
        },
      ])).values()],
    });
  }

  if (method === "GET" && pathname === "/api/admin/summary") {
    const completed = store.orders.filter((order) => order.status === "สำเร็จ");
    const now = new Date();
    const thisMonth = store.orders.filter((order) => {
      const date = new Date(order.createdAt);
      return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
    });
    return sendJson(response, 200, {
      totalOrders: store.orders.length,
      pendingOrders: store.orders.filter((order) => order.status === "รอตรวจสอบ").length,
      monthlySales: thisMonth.reduce((sum, order) => sum + Number(order.paidAmount || 0), 0),
      profit: completed.reduce((sum, order) => sum + Number(order.paidAmount || 0) - Number(order.cost || 0), 0),
      outstanding: store.orders.filter((order) => order.status !== "ยกเลิก")
        .reduce((sum, order) => sum + Math.max(0, Number(order.total) - Number(order.paidAmount || 0)), 0),
      recentOrders: store.orders.slice(0, 8).map(orderSummary),
    });
  }

  const orderMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if ((method === "PATCH" || method === "POST") && orderMatch && parseId(orderMatch[1])) {
    const order = getOrder(orderMatch[1]);
    if (!order) return sendJson(response, 404, { error: "ไม่พบออเดอร์" });
    const body = await readBody(request);

    if (method === "PATCH") {
      const transitions = {
        "รอตรวจสอบ": ["ยืนยันแล้ว", "ยกเลิก"],
        "ยืนยันแล้ว": ["กำลังดำเนินการ", "ยกเลิก"],
        "กำลังดำเนินการ": ["สำเร็จ", "ยกเลิก"],
        "สำเร็จ": [],
        "ยกเลิก": [],
      };
      if (!transitions[order.status]?.includes(body.status)) {
        return sendJson(response, 400, { error: "ไม่สามารถเปลี่ยนสถานะออเดอร์จากขั้นตอนปัจจุบันได้" });
      }
      if (body.cost !== undefined) {
        const cost = Number(body.cost);
        if (!Number.isFinite(cost) || cost < 0) return sendJson(response, 400, { error: "ต้นทุนไม่ถูกต้อง" });
        order.cost = cost;
      }
      order.status = body.status;
      order.updatedAt = new Date().toISOString();
      addHistory(order.id, `เปลี่ยนสถานะเป็น ${order.status}`, "เจ้าของร้าน");
      await persistStore();
      const notification = await notifyLineOwner(`🐱 อัปเดตออเดอร์ ${order.orderNumber}\nสถานะ: ${order.status}`);
      return sendJson(response, 200, { order: orderSummary(order), notification });
    }

    if (body.action === "payment") {
      const amount = Number(body.amount);
      const outstanding = Math.max(0, order.total - order.paidAmount);
      if (!["ยืนยันแล้ว", "กำลังดำเนินการ", "สำเร็จ"].includes(order.status)) {
        return sendJson(response, 400, { error: "ยืนยันออเดอร์ก่อนบันทึกรับชำระ" });
      }
      if (!Number.isFinite(amount) || amount <= 0 || amount > outstanding) {
        return sendJson(response, 400, { error: `ยอดชำระต้องมากกว่า 0 และไม่เกินยอดคงเหลือ ฿${outstanding}` });
      }
      const installment = body.installmentId && order.installments.find((item) => item.id === body.installmentId);
      if (body.installmentId && !installment) return sendJson(response, 404, { error: "ไม่พบงวดผ่อนที่เลือก" });
      const installmentPaid = installment
        ? installment.payments.reduce((sum, payment) => sum + Number(payment.amount), 0)
        : 0;
      if (installment && amount > installment.amount - installmentPaid) {
        return sendJson(response, 400, { error: "ยอดชำระเกินยอดคงเหลือของงวดนี้" });
      }
      order.paidAmount = Math.round((order.paidAmount + amount) * 100) / 100;
      order.payments = order.payments || [];
      order.payments.push({ amount, note: cleanText(body.note, 160), createdAt: new Date().toISOString() });
      order.updatedAt = new Date().toISOString();
      if (installment) installment.payments.push({ amount, createdAt: new Date().toISOString() });
      addHistory(order.id, `บันทึกรับชำระ ฿${amount.toLocaleString("th-TH")}`, "เจ้าของร้าน");
      await persistStore();
      const notification = await notifyLineOwner(`💰 รับชำระออเดอร์ ${order.orderNumber} ฿${amount.toLocaleString("th-TH")}\nคงเหลือ ฿${Math.max(0, order.total - order.paidAmount).toLocaleString("th-TH")}`);
      return sendJson(response, 200, { order: orderSummary(order), notification });
    }

    if (body.action === "installment") {
      if (!["ยืนยันแล้ว", "กำลังดำเนินการ"].includes(order.status)) {
        return sendJson(response, 400, { error: "ยืนยันออเดอร์ก่อนสร้างแผนผ่อนชำระ" });
      }
      const count = Number(body.count);
      const outstanding = Math.max(0, order.total - order.paidAmount);
      if (!Number.isInteger(count) || count < 2 || count > 24 || outstanding <= 0) {
        return sendJson(response, 400, { error: "จำนวนงวดต้องอยู่ระหว่าง 2–24 งวด และต้องมียอดคงเหลือ" });
      }
      if (order.installments.length) return sendJson(response, 409, { error: "ออเดอร์นี้มีแผนผ่อนแล้ว" });
      const firstDue = new Date(body.firstDueDate);
      if (Number.isNaN(firstDue.getTime())) return sendJson(response, 400, { error: "วันที่ครบกำหนดงวดแรกไม่ถูกต้อง" });
      const eachAmount = Math.floor((outstanding / count) * 100) / 100;
      order.installments = Array.from({ length: count }, (_, index) => {
        const dueDate = new Date(firstDue);
        dueDate.setMonth(dueDate.getMonth() + index);
        return {
          id: crypto.randomUUID(),
          number: index + 1,
          amount: index === count - 1 ? Math.round((outstanding - eachAmount * (count - 1)) * 100) / 100 : eachAmount,
          dueDate: dueDate.toISOString().slice(0, 10),
          payments: [],
        };
      });
      addHistory(order.id, `สร้างแผนผ่อน ${count} งวด`, "เจ้าของร้าน");
      await persistStore();
      const notification = await notifyLineOwner(`🪙 สร้างแผนผ่อนออเดอร์ ${order.orderNumber} จำนวน ${count} งวด`);
      return sendJson(response, 201, { order: orderSummary(order), notification });
    }

    return sendJson(response, 400, { error: "คำสั่งออเดอร์ไม่ถูกต้อง" });
  }

  if (method === "GET" && pathname === "/api/admin/report") {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const orders = store.orders.filter((order) => new Date(order.createdAt).getTime() >= cutoff);
    return sendJson(response, 200, {
      days,
      orderCount: orders.length,
      paid: orders.reduce((sum, order) => sum + Number(order.paidAmount || 0), 0),
      profit: orders.filter((order) => order.status === "สำเร็จ")
        .reduce((sum, order) => sum + Number(order.paidAmount || 0) - Number(order.cost || 0), 0),
      outstanding: orders.filter((order) => order.status !== "ยกเลิก")
        .reduce((sum, order) => sum + Math.max(0, Number(order.total) - Number(order.paidAmount || 0)), 0),
      byGame: [...new Set(orders.map((order) => order.gameName))].map((gameName) => ({
        gameName,
        orders: orders.filter((order) => order.gameName === gameName).length,
        paid: orders.filter((order) => order.gameName === gameName).reduce((sum, order) => sum + Number(order.paidAmount || 0), 0),
      })),
    });
  }

  return sendJson(response, 404, { error: "ไม่พบ API ที่เรียกใช้" });
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const uploadedImage = url.pathname.match(/^\/uploads\/([a-f0-9-]+\.(?:png|jpe?g|webp))$/i);
  if (uploadedImage && request.method === "GET") {
    try {
      const imagePath = path.join(UPLOAD_DIR, uploadedImage[1]);
      const image = await fs.readFile(imagePath);
      const imageType = getImageType(image);
      if (!imageType) throw new Error("Stored upload is not a supported image");
      response.writeHead(200, {
        "Content-Type": imageType.mimeType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      });
      return response.end(image);
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Unable to serve uploaded image:", error);
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return response.end("ไม่พบรูปภาพ");
    }
  }
  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(request, response, url);
    } catch (error) {
      console.error("API request failed:", error);
      if (!response.headersSent) {
        sendJson(response, error.status || 500, {
          error: error.status ? error.message : "เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่",
        });
      }
    }
    return;
  }

  const files = {
    "/": "index.html",
    "/index.html": "index.html",
    "/style.css": "style.css",
    "/dashboard.js": path.resolve(ROOT, "..", "dashboard.js"),
  };
  const file = files[url.pathname] && (path.isAbsolute(files[url.pathname])
    ? files[url.pathname]
    : path.join(ROOT, files[url.pathname]));
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return response.end("ไม่พบหน้าที่ต้องการ");
  }
  try {
    const content = await fs.readFile(file);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(file)],
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    });
    response.end(content);
  } catch (error) {
    console.error(`Unable to serve ${file}:`, error);
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("ไม่สามารถเปิดหน้าเว็บได้");
  }
}

async function start() {
  store = await loadStore();
  ownerAuth = await loadOwnerAuth();
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error("Unexpected request failure:", error);
      if (!response.headersSent) sendJson(response, 500, { error: "เกิดข้อผิดพลาดในระบบ" });
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`Meowmi is running at http://localhost:${PORT}`);
    if (!ADMIN_PASSWORD && !ownerAuth) console.log("Set up the owner password from this computer in the admin page.");
  });
}

start().catch((error) => {
  console.error("Unable to start Meowmi:", error);
  process.exitCode = 1;
});
