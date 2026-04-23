const API = "https://script.google.com/macros/s/AKfycbyRIsCr-6vHgoJEf0m2ikHfcxjHz0LfkQ91Q8qtEoOj6owdi-44HVxVaF6AD6HIM_aA/exec";
const MOVE_CACHE_KEY = "warehouse_moves_cache_v1";
const PENDING_CACHE_KEY = "warehouse_pending_moves_v1";

let state = { items: [], moves: [], pendingMoves: [] };
let scanner = null;
let availableCameras = [];

function normalizeMove(raw) {
  return {
    timestamp: raw.timestamp || raw.Thời_gian || raw.time || "Vừa xong",
    user: raw.user || raw.Người_nhập || raw.by || "---",
    sku: raw.sku || raw.SKU || "N/A",
    qty: String(raw.qty || raw.SL || 0),
    type: raw.type === "IN" || raw.type === "OUT"
      ? raw.type
      : ((raw.Loại || "").toUpperCase().includes("NHẬP") ? "IN" : "OUT"),
    location: raw.location || raw.Vị_trí || raw.loc || "Kho"
  };
}

function getMoveKey(m) {
  return [m.timestamp, m.user, m.sku, m.qty, m.type, m.location].join("|");
}

function getMoveCoreKey(m) {
  return [m.user, m.sku, m.qty, m.type, m.location].join("|");
}

function hasStableTimestamp(ts) {
  const v = String(ts || "").trim();
  return v !== "" && v !== "Vừa xong" && v !== "Đang đợi xử lý...";
}

function saveMovesCache() {
  try {
    localStorage.setItem(MOVE_CACHE_KEY, JSON.stringify(state.moves.slice(-500)));
  } catch (e) {
    console.warn("Không thể lưu cache lịch sử:", e);
  }
}

function savePendingCache() {
  try {
    localStorage.setItem(PENDING_CACHE_KEY, JSON.stringify(state.pendingMoves.slice(-100)));
  } catch (e) {
    console.warn("Không thể lưu cache pending:", e);
  }
}

function loadMovesCache() {
  try {
    const raw = localStorage.getItem(MOVE_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeMove);
  } catch (e) {
    console.warn("Không thể đọc cache lịch sử:", e);
    return [];
  }
}

function loadPendingCache() {
  try {
    const raw = localStorage.getItem(PENDING_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeMove);
  } catch (e) {
    console.warn("Không thể đọc cache pending:", e);
    return [];
  }
}

function mergeMoves(currentMoves, incomingMoves) {
  const merged = [...currentMoves];
  const seen = new Set(
    currentMoves
      .filter(m => hasStableTimestamp(m.timestamp))
      .map(getMoveKey)
  );

  incomingMoves.forEach((m) => {
    // Chỉ chống trùng khi bản ghi có timestamp ổn định.
    // Nếu timestamp rỗng/placeholder thì vẫn giữ để tránh "mất" lịch sử.
    if (!hasStableTimestamp(m.timestamp)) {
      merged.push(m);
      return;
    }
    const key = getMoveKey(m);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(m);
    }
  });

  return merged.slice(-500);
}

function reconcilePending(serverMoves) {
  const serverCoreKeys = new Set(serverMoves.map(getMoveCoreKey));
  state.pendingMoves = state.pendingMoves.filter(p => !serverCoreKeys.has(getMoveCoreKey(p)));
  savePendingCache();
}

async function loadData() {
  try {
    const res = await fetch(API);
    const data = await res.json();

    // Xử lý Items - Linh hoạt với tên thuộc tính từ Google Sheet
    const rawItems = data.items || (Array.isArray(data) ? data : []);
    state.items = rawItems
      .filter(it => {
        const s = it.sku || it.SKU || "";
        return s.toString().trim() !== "";
      })
      .map(it => ({
        sku: it.sku || it.SKU || "N/A",
        name: it.name || it.ten || it.product || it.Sản_phẩm || "Chưa đặt tên",
        location: it.location || it.loc || it.vitri || it.Vị_trí || "-",
        stock: Number(it.toncuoi || it.stock || it.Tồn || 0)
      }));

    // Xử lý Moves (Nhật ký): luôn merge để không bị mất khi API trả rỗng/tạm thời thiếu dữ liệu
    const rawMoves = data.moves || data.logs || data.history || [];
    const normalizedIncoming = Array.isArray(rawMoves) ? rawMoves.map(normalizeMove) : [];
    state.moves = mergeMoves(state.moves, normalizedIncoming);
    reconcilePending(normalizedIncoming);
    saveMovesCache();

    render();
    renderMoves();
    document.getElementById("lastUpdate").textContent = new Date().toLocaleTimeString("vi-VN");
  } catch (e) {
    console.error("Lỗi kết nối:", e);
    document.getElementById("lastUpdate").textContent = "Lỗi kết nối!";
  }
}

function render() {
  const q = document.getElementById("q").value.toLowerCase();
  const rows = document.getElementById("rows");

  const filtered = state.items.filter(i =>
    i.sku.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)
  );

  if (filtered.length === 0) {
    rows.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 20px;">Không tìm thấy dữ liệu</td></tr>`;
  } else {
    rows.innerHTML = filtered.map(i => `
      <tr>
        <td><b style="color:var(--accent)">${i.sku}</b></td>
        <td>${i.name}</td>
        <td><code style="background:#eee; padding:2px 4px;">${i.location}</code></td>
        <td style="font-size: 15px;"><b>${i.stock}</b></td>
        <td>
          <span class="pill ${i.stock <= 0 ? "hot" : (i.stock < 5 ? "hot" : "ok")}">
            ${i.stock <= 0 ? "HẾT HÀNG" : (i.stock < 5 ? "SẮP HẾT" : "SẴN SÀNG")}
          </span>
        </td>
      </tr>
    `).join("");
  }

  // Cập nhật KPI
  document.getElementById("kpi-sku").textContent = state.items.length;
  document.getElementById("kpi-stock").textContent = state.items.reduce((a, b) => a + b.stock, 0);
  document.getElementById("kpi-low").textContent = state.items.filter(i => i.stock > 0 && i.stock < 5).length;
  document.getElementById("kpi-out").textContent = state.items.filter(i => i.stock <= 0).length;
}

function renderMoves() {
  const moveList = document.getElementById("moveList");
  const mergedForDisplay = mergeMoves(state.moves, state.pendingMoves);
  if (!mergedForDisplay || mergedForDisplay.length === 0) {
    moveList.innerHTML = `<div style="padding:40px; text-align:center; color:var(--muted);">Chưa có lịch sử hoạt động</div>`;
    return;
  }

  const displayMoves = [...mergedForDisplay].reverse().slice(0, 30);

  moveList.innerHTML = displayMoves.map(m => {
    const isIn = m.type === "IN";
    const typeLabel = isIn ? "NHẬP" : "XUẤT";
    const typeClass = isIn ? "type-IN" : "type-OUT";
    const symbol = isIn ? "+" : "-";

    return `
      <div class="move-item">
        <div class="move-meta">
          <span>${m.timestamp || m.Thời_gian || "Vừa xong"}</span>
          <span>By: ${m.user || m.Người_nhập || "---"}</span>
        </div>
        <div class="move-body">
          <span class="type-tag ${typeClass}">${typeLabel}</span>
          <b>${m.sku || m.SKU}</b>
          <span style="margin: 0 8px; opacity: 0.5;">→</span>
          <b style="font-size:1.1em">${symbol}${m.qty || m.SL}</b>
          <small style="color:var(--muted); margin-left:8px;">@ ${m.location || m.Vị_trí || "Kho"}</small>
        </div>
      </div>
    `;
  }).join("");
}

async function handleTransaction() {
  const sku = document.getElementById("act-sku").value.trim().toUpperCase();
  const qty = document.getElementById("act-qty").value;
  const type = document.getElementById("act-type").value;
  const loc = document.getElementById("act-loc").value.trim();
  const user = document.getElementById("act-user").value.trim();

  if (!sku || !qty || qty <= 0) {
    alert("Vui lòng nhập đúng mã SKU và số lượng dương!");
    return;
  }

  const btn = document.getElementById("btnSubmit");
  btn.textContent = "ĐANG LƯU...";
  btn.disabled = true;

  try {
    // 1. Gửi dữ liệu
    await fetch(API, {
      method: "POST",
      mode: "no-cors",
      cache: "no-cache",
      body: JSON.stringify({ sku, qty, type, location: loc, user: user })
    });

    // 2. Cập nhật giao diện tạm thời (Optimistic UI) để người dùng thấy ngay
    const tempMove = {
      sku: sku,
      qty: String(qty),
      type: type,
      location: loc || "---",
      user: user || "Tôi",
      timestamp: "Đang đợi xử lý..."
    };
    state.pendingMoves.push(normalizeMove(tempMove));
    savePendingCache();
    renderMoves();

    // 3. Thông báo và Reset form
    alert(`Thành công: ${type === "IN" ? "Nhập" : "Xuất"} ${qty} cho mã ${sku}`);
    document.getElementById("act-sku").value = "";
    document.getElementById("act-qty").value = "";

    // 4. Reload dữ liệu thật sau 2 giây
    setTimeout(loadData, 2000);
  } catch (e) {
    alert("Lỗi: Không thể gửi dữ liệu. Vui lòng kiểm tra kết nối.");
  } finally {
    btn.textContent = "XÁC NHẬN";
    btn.disabled = false;
  }
}

function openScan() {
  const backdrop = document.getElementById("scanBackdrop");
  backdrop.style.display = "flex";
  loadCameraOptions();
}

function loadCameraOptions() {
  const select = document.getElementById("cameraSelect");
  select.innerHTML = `<option value="">Đang tải danh sách camera...</option>`;

  Html5Qrcode.getCameras().then((devices) => {
    if (!devices || devices.length === 0) throw new Error("No camera");
    availableCameras = devices;
    select.innerHTML = devices.map((d, idx) => {
      const label = (d.label && d.label.trim()) ? d.label.trim() : `Camera ${idx + 1}`;
      return `<option value="${d.id}">${label}</option>`;
    }).join("");

    const rearCam = devices.find((d) => /back|rear|environment|sau/i.test(d.label || ""));
    select.value = rearCam ? rearCam.id : devices[0].id;
  }).catch((e) => {
    console.error("Không lấy được danh sách camera:", e);
    availableCameras = [];
    select.innerHTML = `<option value="">Không lấy được camera</option>`;
  });
}

function startScanFromSelectedCamera() {
  const select = document.getElementById("cameraSelect");
  const cameraId = select.value;
  if (!cameraId) {
    alert("Không có camera khả dụng để quét.");
    return;
  }

  const targetId = "barcode-reader";
  const config = {
    fps: 12,
    qrbox: { width: 300, height: 160 },
    rememberLastUsedCamera: false,
    supportedScanTypes: [Html5QrcodeScanType.SCAN_TYPE_CAMERA]
  };

  if (!scanner) scanner = new Html5Qrcode(targetId, false);

  const onScanSuccess = (decodedText) => {
    const skuInput = document.getElementById("act-sku");
    skuInput.value = String(decodedText || "").trim().toUpperCase();
    skuInput.dispatchEvent(new Event("input", { bubbles: true }));
    closeScan();
  };

  const onScanError = (e) => {
    console.error("Không thể mở camera:", e);
    alert("Không thể mở camera để scan. Vui lòng kiểm tra quyền camera/trình duyệt.");
    closeScan();
  };

  const startSelected = () => scanner.start(
    cameraId,
    config,
    onScanSuccess
  ).catch(onScanError);

  if (scanner.isScanning) {
    scanner.stop().then(startSelected).catch(onScanError);
  } else {
    startSelected();
  }
}

document.getElementById("cameraSelect").addEventListener("change", () => {
  const backdrop = document.getElementById("scanBackdrop");
  if (backdrop.style.display !== "flex") return;
  if (scanner && scanner.isScanning) {
    startScanFromSelectedCamera();
  }
});

document.getElementById("scanBackdrop").addEventListener("click", (e) => {
  if (e.target.id === "scanBackdrop") {
    closeScan();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const backdrop = document.getElementById("scanBackdrop");
    if (backdrop.style.display === "flex") closeScan();
  }
});

// Bật quét nhanh bằng Enter khi đang ở modal scan.
document.getElementById("cameraSelect").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    startScanFromSelectedCamera();
  }
});

function closeScan() {
  const backdrop = document.getElementById("scanBackdrop");
  backdrop.style.display = "none";
  if (scanner && scanner.isScanning) {
    scanner.stop().catch(() => {}).finally(() => {
      try { scanner.clear(); } catch (_) {}
    });
  } else {
    try { if (scanner) scanner.clear(); } catch (_) {}
  }
}

// Tự động điền vị trí khi nhập SKU
document.getElementById("act-sku").addEventListener("input", (e) => {
  const val = e.target.value.trim().toUpperCase();
  const item = state.items.find(i => i.sku.toUpperCase() === val);
  if (item) document.getElementById("act-loc").value = item.location;
});

// Tìm kiếm nhanh
document.getElementById("q").addEventListener("input", render);

// Khởi chạy
state.moves = loadMovesCache();
state.pendingMoves = loadPendingCache();
loadData();
setInterval(loadData, 60000); // Tự động làm mới mỗi phút
