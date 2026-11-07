(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { games: [], skins: [], settings: {}, adminTab: "catalog", toastTimer: null, ownerSetupRequired: false };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }

  function money(value) {
    return Number(value || 0).toLocaleString("th-TH", { maximumFractionDigits: 2 });
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `เกิดข้อผิดพลาด (${response.status})`);
    return result;
  }

  function notify(message, error = false) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.className = `toast show${error ? " error" : ""}`;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.className = "toast"; }, 4000);
  }

  function switchView(name) {
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
    $$(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === name));
    if (name === "shop") loadCatalog();
    if (name === "admin") checkAdminSession();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function loadCatalog() {
    try {
      const catalog = await api("/api/catalog");
      state.games = catalog.games;
      state.skins = catalog.skins;
      state.settings = catalog.settings || {};
      renderStorefront();
    } catch (error) {
      $("#product-grid").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
      $("#contact-links").innerHTML = '<span class="contact-placeholder">โหลดข้อมูลไม่สำเร็จ</span>';
    }
  }

  function renderStorefront() {
    const filter = $("#game-filter");
    const previousFilter = filter.value;
    filter.innerHTML = '<option value="">ทุกเกม</option>' + state.games.map((game) =>
      `<option value="${escapeHtml(game.id)}">${escapeHtml(game.name)}</option>`
    ).join("");
    if (state.games.some((game) => game.id === previousFilter)) filter.value = previousFilter;
    renderProducts();
    renderContactLinks();
  }

  function renderContactLinks() {
    const links = [];
    if (state.settings.lineUrl) {
      links.push(`<a class="contact-button line-button" href="${escapeHtml(state.settings.lineUrl)}" target="_blank" rel="noopener noreferrer"><span>LINE</span> แอด LINE เพื่อสั่งซื้อ ↗</a>`);
    }
    if (state.settings.otherContactLabel && state.settings.otherContactUrl) {
      links.push(`<a class="contact-button alternate-button" href="${escapeHtml(state.settings.otherContactUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(state.settings.otherContactLabel)} เพื่อสั่งซื้อ ↗</a>`);
    }
    $("#contact-links").innerHTML = links.length
      ? links.join("")
      : '<span class="contact-placeholder">ร้านยังไม่ได้ตั้งค่าช่องทางสั่งซื้อ · ติดต่อเจ้าของร้านเพื่อสอบถาม</span>';
  }

  function normalizeSearch(value) {
    return String(value || "").toLocaleLowerCase("th-TH").replaceAll(",", "").replace(/\s+/g, " ").trim();
  }

  function normalizeUnit(value) {
    const unit = normalizeSearch(value);
    if (/คูปอง|coupon|voucher/.test(unit)) return "coupon";
    if (/\bvp\b|valorant\s*points?/.test(unit)) return "vp";
    if (/robux|โรบัก/.test(unit)) return "robux";
    return unit;
  }

  function parsePackageSearch(query) {
    const normalized = normalizeSearch(query);
    const quantity = Number(normalized.match(/\d+/)?.[0] || 0);
    const game = state.games.find((item) => {
      const name = normalizeSearch(item.name);
      if (/rov|อาร์โอวี/.test(name) && /(?:^|\s)rov(?:\s|$)|อาร์โอวี/.test(normalized)) return true;
      if (/valorant/.test(name) && /valorant|วาโล/.test(normalized)) return true;
      if (/roblox/.test(name) && /roblox|โรบล็อก/.test(normalized)) return true;
      return false;
    });
    const unit = normalizeUnit(normalized);
    const unitLabel = unit === "coupon" ? "คูปอง" : unit === "vp" ? "VP" : unit === "robux" ? "Robux" : "";
    return { quantity, unit, unitLabel, gameId: game?.id || "" };
  }

  function renderProducts() {
    const filter = $("#game-filter").value;
    const category = $("#category-filter").value;
    const query = $("#product-search").value.trim();
    const parsed = parsePackageSearch(query);
    let candidates = state.skins.filter((skin) =>
      (!filter || skin.gameId === filter) &&
      (!category || (skin.type || "package") === category) &&
      (!parsed.gameId || skin.gameId === parsed.gameId)
    );
    let products = candidates;
    let recommendationText = "";
    const exactIds = new Set();
    const recommendedIds = new Set();

    if (parsed.quantity) {
      if (parsed.unit) candidates = candidates.filter((skin) => normalizeUnit(skin.unit) === parsed.unit);
      candidates = candidates.filter((skin) => Number.isFinite(Number(skin.quantity)) && Number(skin.quantity) > 0);
      const exact = candidates.filter((skin) => Number(skin.quantity) === parsed.quantity);
      if (exact.length) {
        products = exact;
        exact.forEach((skin) => exactIds.add(skin.id));
        recommendationText = `พบรายการ ${parsed.quantity.toLocaleString("th-TH")} ${escapeHtml(parsed.unitLabel || "หน่วย")} ที่ตรงกับที่ค้นหา`;
      } else {
        products = [...candidates]
          .sort((left, right) => Math.abs(left.quantity - parsed.quantity) - Math.abs(right.quantity - parsed.quantity) || effectivePrice(left) - effectivePrice(right))
          .slice(0, 3);
        products.forEach((skin) => recommendedIds.add(skin.id));
        recommendationText = products.length
          ? `ยังไม่มีแพ็ก ${parsed.quantity.toLocaleString("th-TH")} ${escapeHtml(parsed.unitLabel || "หน่วย")} ตรงจำนวน — แนะนำแพ็กใกล้เคียง`
          : `ยังไม่พบรายการ${parsed.unitLabel ? `หน่วย ${escapeHtml(parsed.unitLabel)}` : ""} ลองเลือกเกมอื่นหรือสอบถามร้านได้เลย`;
      }
    } else if (query) {
      const words = normalizeSearch(query).split(/\s+/).filter(Boolean);
      products = candidates.filter((skin) => {
        const game = state.games.find((item) => item.id === skin.gameId);
        const searchable = normalizeSearch([
          game?.name, skin.name, skin.description, skin.quantity, skin.unit, skin.promoLabel,
        ].join(" "));
        return words.every((word) => searchable.includes(word));
      });
      recommendationText = products.length
        ? `พบ ${products.length} รายการที่ตรงกับคำค้นหา`
        : "ไม่พบรายการที่ตรงกับคำค้นหา ลองค้นหาด้วยชื่อเกม จำนวน ชื่อแพ็ก หรือ Skin";
    } else {
      recommendationText = "เลือกประเภทแพ็กหรือ Skin หรือค้นหา เช่น “500 คูปอง”, “500 VP” หรือ “การันตีสกิน”";
    }

    $("#product-count").textContent = `${products.length} รายการ`;
    $("#search-recommendation").innerHTML = `<span class="recommendation-sparkle">${parsed.quantity && exactIds.size ? "♡" : parsed.quantity ? "✦" : "⌕"}</span><span>${recommendationText}</span>`;
    if (!products.length) {
      $("#product-grid").innerHTML = '<div class="empty-state">ยังไม่มีรายการที่ตรงกับตัวกรองนี้</div>';
      return;
    }
    $("#product-grid").innerHTML = products.map((skin) => {
      const game = state.games.find((item) => item.id === skin.gameId);
      const isSkin = skin.type === "skin";
      const isOnSale = Number(skin.promoPrice) > 0 && Number(skin.promoPrice) < Number(skin.price);
      const packageTag = exactIds.has(skin.id)
        ? '<span class="match-badge exact-match">ตรงจำนวนที่หา ✓</span>'
        : recommendedIds.has(skin.id)
          ? '<span class="match-badge recommended-match">แพ็กแนะนำ ✦</span>'
          : "";
      return `<article class="product-card">
        <div class="product-info"><small>${escapeHtml(game?.name || "เกม")} · ${isSkin ? "Skin" : "แพ็ก"}</small><h3>${escapeHtml(skin.name)}</h3>${!isSkin && skin.quantity ? `<div class="package-quantity">${Number(skin.quantity).toLocaleString("th-TH")} ${escapeHtml(skin.unit || "")}</div>` : ""}<p>${escapeHtml(skin.description || "")}</p>${isOnSale ? `<div class="sale-price"><strong>฿${money(skin.promoPrice)}</strong><del>฿${money(skin.price)}</del><span>ประหยัด ฿${money(skin.price - skin.promoPrice)}</span></div>${skin.promoLabel ? `<span class="sale-caption">${escapeHtml(skin.promoLabel)}</span>` : ""}` : `<div class="product-price"><strong>฿${money(skin.price)}</strong></div>`}${packageTag}</div>
      </article>`;
    }).join("");
  }

  function effectivePrice(skin) {
    const promo = Number(skin.promoPrice);
    return promo > 0 && promo < Number(skin.price) ? promo : Number(skin.price);
  }

  $("#game-filter").addEventListener("change", renderProducts);
  $("#category-filter").addEventListener("change", renderProducts);
  $("#product-search").addEventListener("input", renderProducts);
  $("#clear-search").addEventListener("click", () => {
    $("#product-search").value = "";
    $("#game-filter").value = "";
    $("#category-filter").value = "";
    renderProducts();
    $("#product-search").focus();
  });

  async function checkAdminSession() {
    $("#admin-login").classList.remove("hidden");
    $("#admin-dashboard").classList.add("hidden");
    $("#login-error").textContent = "";
    try {
      const session = await api("/api/admin/session");
      state.ownerSetupRequired = session.setupRequired;
      $("#confirm-password-label").classList.toggle("hidden", !state.ownerSetupRequired);
      $("#confirm-password").classList.toggle("hidden", !state.ownerSetupRequired);
      $("#confirm-password").required = state.ownerSetupRequired;
      $("#admin-password").autocomplete = state.ownerSetupRequired ? "new-password" : "current-password";
      $("#admin-login-description").textContent = state.ownerSetupRequired
        ? "ตั้งรหัสผ่านเจ้าของร้านครั้งแรก เพื่อเข้าเพิ่มและแก้ไขข้อมูล"
        : "เพิ่มและแก้ไขเกม แพ็ก ราคา โปรโมชัน และรูปภาพ";
      $("#admin-login-action").textContent = state.ownerSetupRequired ? "ตั้งรหัสผ่านและเริ่มจัดการร้าน" : "เข้าสู่ระบบหลังบ้าน";
      $("#admin-login-note").textContent = state.ownerSetupRequired
        ? "ใช้รหัสผ่านอย่างน้อย 12 ตัวอักษร และเก็บไว้สำหรับเข้าสู่ระบบครั้งต่อไป"
        : "ลูกค้าเข้าเว็บดูและค้นหาราคาได้โดยไม่ต้องล็อกอิน";
      if (session.authenticated) showDashboard();
    } catch (error) {
      $("#login-error").textContent = error.message;
    }
  }

  function showDashboard() {
    $("#admin-login").classList.add("hidden");
    $("#admin-dashboard").classList.remove("hidden");
    loadAdminTab(state.adminTab);
  }

  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    $("#login-error").textContent = "";
    try {
      const password = $("#admin-password").value;
      if (state.ownerSetupRequired && password !== $("#confirm-password").value) {
        throw new Error("รหัสผ่านทั้งสองช่องไม่ตรงกัน");
      }
      await api(state.ownerSetupRequired ? "/api/admin/setup" : "/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      $("#admin-password").value = "";
      $("#confirm-password").value = "";
      showDashboard();
    } catch (error) {
      $("#login-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $("#logout-button").addEventListener("click", async () => {
    try {
      await api("/api/admin/logout", { method: "POST" });
      $("#admin-dashboard").classList.add("hidden");
      $("#admin-login").classList.remove("hidden");
      notify("ออกจากระบบแล้ว");
    } catch (error) { notify(error.message, true); }
  });

  $$(".admin-tab").forEach((button) => button.addEventListener("click", () => {
    state.adminTab = button.dataset.tab;
    $$(".admin-tab").forEach((item) => item.classList.toggle("active", item === button));
    loadAdminTab(state.adminTab);
  }));

  async function loadAdminTab(tab) {
    $("#admin-page-title").innerHTML = `${tab === "catalog" ? "เกม แพ็ก และ Skin" : "ช่องทางสั่งซื้อ"} <em>♡</em>`;
    $("#admin-content").innerHTML = '<div class="loading-card">กำลังโหลดข้อมูล…</div>';
    try {
      if (tab === "catalog") await renderCatalog();
      if (tab === "settings") await renderSettings();
    } catch (error) {
      $("#admin-content").innerHTML = `<div class="empty-state error-text">${escapeHtml(error.message)}</div>`;
      if (error.message === "กรุณาเข้าสู่ระบบเจ้าของร้านก่อน") checkAdminSession();
    }
  }

  async function uploadImage(file) {
    if (!file) return "";
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      throw new Error("รองรับรูป PNG, JPG หรือ WebP เท่านั้น");
    }
    if (file.size > 5 * 1024 * 1024) throw new Error("รูปภาพต้องมีขนาดไม่เกิน 5 MB");
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("อ่านไฟล์รูปภาพไม่สำเร็จ"));
      reader.readAsDataURL(file);
    });
    const result = await api("/api/admin/images", { method: "POST", body: JSON.stringify({ dataUrl }) });
    return result.imageUrl;
  }

  function imageFormControls(imageUrl = "") {
    return `<label>รูปภาพแพ็ก (PNG, JPG, WebP · สูงสุด 5 MB)<input type="file" name="imageFile" accept="image/png,image/jpeg,image/webp" data-image-input></label><label>หรือใส่ URL รูป (HTTPS)<input name="imageUrl" value="${escapeHtml(imageUrl)}" maxlength="2048" placeholder="https://..."></label><img class="admin-image-preview ${imageUrl ? "" : "hidden"}" src="${escapeHtml(imageUrl)}" alt="ตัวอย่างรูปภาพ">`;
  }

  function attachImagePreview(form) {
    const fileInput = $('input[name="imageFile"]', form);
    const imageInput = $('input[name="imageUrl"]', form);
    const preview = $(".admin-image-preview", form);
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (file) {
        preview.src = URL.createObjectURL(file);
        preview.classList.remove("hidden");
      }
    });
    imageInput.addEventListener("input", () => {
      const value = imageInput.value.trim();
      if (/^https:\/\/\S+$/i.test(value)) {
        preview.src = value;
        preview.classList.remove("hidden");
      } else if (!fileInput.files.length) {
        preview.removeAttribute("src");
        preview.classList.add("hidden");
      }
    });
  }

  async function getImageUrl(form, currentImageUrl = "") {
    const file = $('input[name="imageFile"]', form).files[0];
    if (file) return uploadImage(file);
    const url = $('input[name="imageUrl"]', form).value.trim();
    return url || currentImageUrl || "";
  }

  function bindForm(form, submit) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = $('button[type="submit"]', form);
      if (button) button.disabled = true;
      try {
        await submit(event);
      } catch (error) {
        notify(error.message, true);
      } finally {
        if (button) button.disabled = false;
      }
    });
  }

  async function renderCatalog() {
    const catalog = await api("/api/admin/catalog");
    state.games = catalog.games;
    state.skins = catalog.skins;
    state.settings = catalog.settings || {};
    $("#admin-content").innerHTML = `
      <div class="catalog-columns">
        <section class="admin-panel"><div class="panel-heading"><div><h2>จัดการเกม</h2><p>เพิ่ม แก้ไข หรือซ่อนเกมจากหน้าค้นหา</p></div></div>
          <form id="add-game-form" class="inline-form"><input name="name" placeholder="ชื่อเกมใหม่" maxlength="80" required><button type="submit" class="small-button approve-button">＋ เพิ่มเกม</button></form>
          <div class="manage-list">${catalog.games.map((game) => `<form class="manage-row game-edit-form" data-id="${escapeHtml(game.id)}"><input name="name" value="${escapeHtml(game.name)}" maxlength="80" required><label class="toggle-label"><input type="checkbox" name="active" ${game.active ? "checked" : ""}> เปิด</label><button type="submit" class="tiny-button">บันทึก</button></form>`).join("") || '<div class="empty-state">ยังไม่มีเกม</div>'}</div>
        </section>
        <section class="admin-panel"><div class="panel-heading"><div><h2>เพิ่มแพ็ก</h2><p>ใส่ข้อมูล ราคา และโปรโมชันได้เอง</p></div></div>
          <form id="add-package-form" class="stack-form"><input type="hidden" name="type" value="package"><label>เกม<select name="gameId" required>${catalog.games.filter((game) => game.active).map((game) => `<option value="${escapeHtml(game.id)}">${escapeHtml(game.name)}</option>`).join("")}</select></label><label>ชื่อแพ็ก<input name="name" maxlength="100" placeholder="เช่น 500 คูปอง" required></label><div class="two-fields"><label>จำนวน<input name="quantity" type="number" min="1" step="1" placeholder="500" required></label><label>หน่วย<input name="unit" maxlength="30" placeholder="คูปอง / VP / Robux" required></label></div><label>รายละเอียด<input name="description" maxlength="250" placeholder="รายละเอียดเพิ่มเติมที่ต้องการให้ลูกค้าเห็น"></label><div class="two-fields"><label>ราคาปกติ (บาท)<input name="price" type="number" min="0.01" step="0.01" required></label><label>ราคาโปรโมชัน (บาท)<input name="promoPrice" type="number" min="0.01" step="0.01" placeholder="เว้นว่างถ้าไม่มี"></label></div><label>ข้อความโปรโมชัน<input name="promoLabel" maxlength="40" placeholder="เช่น ลดพิเศษ / โปรสุดสัปดาห์"></label>${imageFormControls()}<button type="submit" class="button button-primary">เพิ่มแพ็ก <span>＋</span></button></form>
        </section>
        <section class="admin-panel"><div class="panel-heading"><div><h2>เพิ่ม Skin</h2><p>เพิ่มสกินหรือการันตีสกิน พร้อมกำหนดราคาได้เอง</p></div></div>
          <form id="add-skin-form" class="stack-form"><input type="hidden" name="type" value="skin"><label>เกม<select name="gameId" required>${catalog.games.filter((game) => game.active).map((game) => `<option value="${escapeHtml(game.id)}">${escapeHtml(game.name)}</option>`).join("")}</select></label><label>ชื่อ Skin หรือการันตี<input name="name" maxlength="100" placeholder="เช่น การันตีสกิน..." required></label><label>รายละเอียด<input name="description" maxlength="250" placeholder="รายละเอียดเพิ่มเติมที่ต้องการให้ลูกค้าเห็น"></label><div class="two-fields"><label>ราคาปกติ (บาท)<input name="price" type="number" min="0.01" step="0.01" required></label><label>ราคาโปรโมชัน (บาท)<input name="promoPrice" type="number" min="0.01" step="0.01" placeholder="เว้นว่างถ้าไม่มี"></label></div><label>ข้อความโปรโมชัน<input name="promoLabel" maxlength="40" placeholder="เช่น ลดพิเศษ / โปรสุดสัปดาห์"></label>${imageFormControls()}<button type="submit" class="button button-primary">เพิ่ม Skin <span>＋</span></button></form>
        </section>
      </div>
      <section class="admin-panel"><div class="panel-heading"><div><h2>แพ็ก ราคา โปรโมชัน และรูป</h2><p>แก้ไขข้อมูลตามต้องการ · ปิดการแสดงแพ็กได้โดยไม่ลบข้อมูล</p></div></div>
        <div class="manage-list">${catalog.skins.map((skin) => {
          const game = catalog.games.find((item) => item.id === skin.gameId);
          const itemType = skin.type || "package";
          return `<details class="skin-manage"><summary><span>${escapeHtml(game?.name || "เกม")} · <b>${escapeHtml(skin.name)}</b> · ${itemType === "skin" ? "Skin" : `${Number(skin.quantity || 0).toLocaleString("th-TH")} ${escapeHtml(skin.unit || "")}`}</span><span>${Number(skin.promoPrice) > 0 ? `โปร ฿${money(skin.promoPrice)}` : `฿${money(skin.price)}`} ${skin.active ? "⌄" : "· ซ่อนอยู่"}</span></summary>
            <form class="skin-edit-form stack-form" data-id="${escapeHtml(skin.id)}"><label>ประเภท<select name="type"><option value="package" ${itemType === "package" ? "selected" : ""}>แพ็ก</option><option value="skin" ${itemType === "skin" ? "selected" : ""}>Skin / การันตี Skin</option></select></label><label>เกม<select name="gameId">${catalog.games.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === skin.gameId ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></label><label>ชื่อสินค้า<input name="name" value="${escapeHtml(skin.name)}" maxlength="100" required></label><div class="two-fields"><label>จำนวน<input name="quantity" type="number" min="1" step="1" value="${Number(skin.quantity) || ""}"></label><label>หน่วย<input name="unit" value="${escapeHtml(skin.unit || "")}" maxlength="30"></label></div><label>รายละเอียด<input name="description" value="${escapeHtml(skin.description)}" maxlength="250"></label><div class="two-fields"><label>ราคาปกติ<input name="price" type="number" min="0.01" step="0.01" value="${skin.price}" required></label><label>ราคาโปรโมชัน<input name="promoPrice" type="number" min="0.01" step="0.01" value="${skin.promoPrice || ""}" placeholder="เว้นว่างเพื่อลบโปร"></label></div><label>ข้อความโปรโมชัน<input name="promoLabel" value="${escapeHtml(skin.promoLabel || "")}" maxlength="40" placeholder="เช่น ลดพิเศษ"></label>${imageFormControls(skin.imageUrl || "")}<label class="toggle-label"><input type="checkbox" name="active" ${skin.active ? "checked" : ""}> แสดงในหน้าค้นหา</label><button type="submit" class="small-button approve-button">บันทึกการแก้ไข</button></form></details>`;
        }).join("") || '<div class="empty-state">ยังไม่มีแพ็ก</div>'}</div>
      </section>`;

    $$(".skin-edit-form, #add-package-form, #add-skin-form").forEach(attachImagePreview);
    $$(".skin-edit-form").forEach((form) => {
      const type = $('select[name="type"]', form);
      const quantity = $('input[name="quantity"]', form);
      const unit = $('input[name="unit"]', form);
      const updateFields = () => {
        const isPackage = type.value === "package";
        quantity.required = isPackage;
        unit.required = isPackage;
        quantity.closest("label").classList.toggle("hidden", !isPackage);
        unit.closest("label").classList.toggle("hidden", !isPackage);
      };
      type.addEventListener("change", updateFields);
      updateFields();
    });
    bindForm($("#add-game-form"), async (event) => {
      await api("/api/admin/games", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      notify("เพิ่มเกมแล้ว");
      await renderCatalog();
    });
    $$(".game-edit-form").forEach((form) => bindForm(form, async () => {
      const data = Object.fromEntries(new FormData(form));
      data.active = $('input[name="active"]', form).checked;
      await api(`/api/admin/games/${encodeURIComponent(form.dataset.id)}`, { method: "PATCH", body: JSON.stringify(data) });
      notify("บันทึกข้อมูลเกมแล้ว");
      await renderCatalog();
    }));
    const addCatalogItem = async (event) => {
      const form = event.currentTarget;
      const data = Object.fromEntries(new FormData(form));
      data.imageUrl = await getImageUrl(form);
      delete data.imageFile;
      await api("/api/admin/skins", { method: "POST", body: JSON.stringify(data) });
      notify(data.type === "skin" ? "เพิ่ม Skin แล้ว" : "เพิ่มแพ็กแล้ว");
      await renderCatalog();
    };
    bindForm($("#add-package-form"), addCatalogItem);
    bindForm($("#add-skin-form"), addCatalogItem);
    $$(".skin-edit-form").forEach((form) => bindForm(form, async () => {
      const data = Object.fromEntries(new FormData(form));
      data.imageUrl = await getImageUrl(form);
      data.active = $('input[name="active"]', form).checked;
      delete data.imageFile;
      await api(`/api/admin/skins/${encodeURIComponent(form.dataset.id)}`, { method: "PATCH", body: JSON.stringify(data) });
      notify("บันทึกแพ็ก ราคา และโปรโมชันแล้ว");
      await renderCatalog();
    }));
  }

  async function renderSettings() {
    const result = await api("/api/admin/catalog");
    state.settings = result.settings || {};
    $("#admin-content").innerHTML = `<section class="admin-panel settings-panel"><div class="panel-heading"><div><h2>ช่องทางสำหรับสั่งซื้อ</h2><p>แสดงปุ่มให้ลูกค้าทักร้าน หลังค้นหาและดูราคาแล้ว</p></div></div>
      <form id="settings-form" class="stack-form"><label>ลิงก์ LINE OA หรือ LINE สำหรับสั่งซื้อ<input name="lineUrl" type="url" maxlength="2048" value="${escapeHtml(state.settings.lineUrl || "")}" placeholder="https://line.me/R/ti/p/@yourline"></label><div class="settings-preview"><span>LINE</span><small>${state.settings.lineUrl ? "ตั้งค่าลิงก์แล้ว · ปุ่มจะแสดงบนหน้าร้าน" : "ยังไม่ตั้งค่า · ปุ่ม LINE จะยังไม่แสดง"}</small></div><label>ชื่อช่องทางติดต่ออื่น<input name="otherContactLabel" maxlength="40" value="${escapeHtml(state.settings.otherContactLabel || "")}" placeholder="เช่น Facebook, Discord, Instagram"></label><label>ลิงก์ช่องทางอื่น<input name="otherContactUrl" type="url" maxlength="2048" value="${escapeHtml(state.settings.otherContactUrl || "")}" placeholder="https://..."></label><button type="submit" class="button button-primary">บันทึกช่องทางติดต่อ <span>♡</span></button></form>
      <div class="owner-reminder">คำสั่งซื้อและการชำระเงินทำผ่านช่องทางที่ร้านกำหนด · เว็บไซต์นี้มีไว้ค้นหาแพ็กและดูราคาเท่านั้น</div>
    </section>`;
    bindForm($("#settings-form"), async (event) => {
      const result = await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      state.settings = result.settings;
      notify("บันทึกช่องทางสั่งซื้อแล้ว");
      renderContactLinks();
      await renderSettings();
    });
  }

  $$(".nav-link").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$("[data-view='shop']").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    switchView("shop");
  }));
  $$("[data-view='admin']").forEach((button) => button.addEventListener("click", () => switchView("admin")));

  loadCatalog();
})();
