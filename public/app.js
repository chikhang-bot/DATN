const state = {
  user: null,
  dashboard: null,
  selectedDeviceId: localStorage.getItem("smart-cb-device") || null,
  telemetry: [],
  pendingAction: null,
  pollTimer: null,
  telemetryCounter: 0,
  preview: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  bindEvents();
  updateClock();
  setInterval(updateClock, 1000);
  if (location.protocol === "file:" || new URLSearchParams(location.search).has("demo")) {
    enterPreviewMode();
    return;
  }
  try {
    const status = await api("/api/auth/status");
    if (status.user) return enterApp(status.user);
    showAuth(status.initialized ? "login" : "setup");
  } catch (error) {
    showAuth("login");
    setFormError("login-error", friendlyError(error));
  }
}

function enterPreviewMode() {
  state.preview = true;
  document.body.classList.add("preview-mode");
  $("#preview-banner").classList.remove("hidden");
  state.dashboard = previewDashboard();
  state.selectedDeviceId = "esp32-tu-dien-a";
  state.telemetry = previewTelemetry();
  enterApp({ display_name: "Kỹ sư vận hành", role: "ADMIN" }, { preview: true });
}

function bindEvents() {
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitForm(event.currentTarget, "login-error", async (values) => {
      const result = await api("/api/auth/login", { method: "POST", body: values });
      await enterApp(result.user);
    });
  });

  $("#setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitForm(event.currentTarget, "setup-error", async (values) => {
      await api("/api/auth/setup", { method: "POST", body: values });
      toast("Hệ thống đã khởi tạo. Hãy đăng nhập.", "success");
      showAuth("login");
      $("#login-form [name=email]").value = values.email;
    });
  });

  $("#logout-button").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    stopPolling();
    state.user = null;
    $("#app-view").classList.add("hidden");
    showAuth("login");
  });

  $$(".nav-item[data-section]").forEach((button) => button.addEventListener("click", () => showSection(button.dataset.section)));
  $("#menu-button").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
  $("#device-select").addEventListener("change", async (event) => {
    state.selectedDeviceId = event.target.value || null;
    localStorage.setItem("smart-cb-device", state.selectedDeviceId || "");
    state.telemetry = [];
    renderDashboard();
    await loadTelemetry();
  });
  $("#open-button").addEventListener("click", () => openCommandDialog("OPEN"));
  $("#close-button").addEventListener("click", () => openCommandDialog("CLOSE"));
  $("#confirm-dialog").addEventListener("close", async (event) => {
    if (event.target.returnValue === "confirm" && state.pendingAction) await sendCommand(state.pendingAction);
    state.pendingAction = null;
  });
  $("#refresh-history").addEventListener("click", refreshDashboard);

  $("#device-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitForm(event.currentTarget, "device-form-error", async (values) => {
      const result = await api("/api/devices", { method: "POST", body: values });
      event.currentTarget.reset();
      $("#new-device-id").value = result.device.id;
      $("#new-device-key").value = result.apiKey;
      $("#secret-dialog").showModal();
      await refreshDashboard();
    });
  });

  $("#user-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitForm(event.currentTarget, "user-form-error", async (values) => {
      await api("/api/users", { method: "POST", body: values });
      event.currentTarget.reset();
      toast("Đã tạo tài khoản mới.", "success");
    });
  });

  $("#copy-secret").addEventListener("click", async () => {
    const text = `#define SMART_CB_DEVICE_ID "${$("#new-device-id").value}"\n#define SMART_CB_DEVICE_KEY "${$("#new-device-key").value}"`;
    await navigator.clipboard.writeText(text);
    toast("Đã sao chép mã thiết bị và khóa API.", "success");
  });

  window.addEventListener("resize", debounce(drawChart, 100));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling(); else if (state.user) startPolling();
  });
}

async function enterApp(user, options = {}) {
  state.user = user;
  $("#auth-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#user-name").textContent = user.display_name;
  $("#user-initial").textContent = user.display_name.slice(0, 1).toUpperCase();
  $("#user-role").textContent = roleLabel(user.role);
  $$(".admin-only").forEach((element) => element.classList.toggle("hidden", user.role !== "ADMIN"));
  const canControl = user.role === "ADMIN" || user.role === "OPERATOR";
  $("#open-button").dataset.allowed = String(canControl);
  $("#close-button").dataset.allowed = String(canControl);
  if (options.preview) {
    renderDeviceOptions(state.dashboard.devices);
    renderDashboard();
    renderHistory();
    requestAnimationFrame(drawChart);
    return;
  }
  await refreshDashboard();
  startPolling();
}

function previewDashboard() {
  const now = Date.now();
  return {
    serverTime: now,
    devices: [{
      id: "esp32-tu-dien-a", name: "Tủ điện xưởng A", location: "Khu sản xuất · Tầng 1",
      online: true, breaker_state: "CLOSED", remote_control_enabled: 1,
      mts5_connected: 1, pm3_connected: 1, mts5_status_raw: 3,
      firmware_version: "1.0.0", last_seen_at: now - 900,
      voltage: 228.7, current: 12.46, active_power: 7640, energy_kwh: 1284.72,
      frequency: 49.98, power_factor: .973, temperature: 37.4,
      voltage_a: 229.1, voltage_b: 228.3, voltage_c: 228.7,
      voltage_ab: 396.4, voltage_bc: 395.6, voltage_ca: 397.1,
      current_a: 12.18, current_b: 12.67, current_c: 12.53,
      active_power_a: 2510, active_power_b: 2600, active_power_c: 2530,
      reactive_power_a: 540, reactive_power_b: 510, reactive_power_c: 520, reactive_power: 1570,
      apparent_power_a: 2570, apparent_power_b: 2650, apparent_power_c: 2580, apparent_power: 7800,
      power_factor_a: .976, power_factor_b: .971, power_factor_c: .974,
      phase_sequence: 0,
    }],
    activeCommands: [],
    recentCommands: [
      { requested_at: now - 3600000, device_name: "Tủ điện xưởng A", action: "CLOSE", status: "SUCCEEDED", requested_by_name: "Kỹ sư vận hành", result_message: "CB đã đóng an toàn" },
      { requested_at: now - 86400000, device_name: "Tủ điện xưởng A", action: "OPEN", status: "SUCCEEDED", requested_by_name: "Quản trị viên", result_message: "CB đã ngắt" },
    ],
  };
}

function previewTelemetry() {
  const now = Date.now();
  return Array.from({ length: 36 }, (_, index) => ({
    sampled_at: now - (35 - index) * 5000,
    voltage: 228.5 + Math.sin(index / 3.2) * 1.7 + Math.sin(index / 1.3) * .35,
    current: 11.8 + Math.sin(index / 4.1) * 1.25 + (index > 22 ? .8 : 0),
  }));
}

function showAuth(mode) {
  $("#auth-view").classList.remove("hidden");
  $("#login-form").classList.toggle("hidden", mode !== "login");
  $("#setup-form").classList.toggle("hidden", mode !== "setup");
}

function showSection(name) {
  $$(".page-section").forEach((section) => section.classList.add("hidden"));
  $(`#${name}-section`).classList.remove("hidden");
  $$(".nav-item[data-section]").forEach((button) => button.classList.toggle("active", button.dataset.section === name));
  const titles = { overview: ["TỔNG QUAN", "Trung tâm điều khiển"], history: ["LỊCH SỬ", "Nhật ký vận hành"], settings: ["THIẾT LẬP", "Quản trị hệ thống"] };
  $("#page-breadcrumb").textContent = titles[name][0];
  $("#page-title").textContent = titles[name][1];
  $(".sidebar").classList.remove("open");
}

async function refreshDashboard() {
  try {
    state.dashboard = await api("/api/dashboard");
    const devices = state.dashboard.devices;
    if (!devices.some((device) => device.id === state.selectedDeviceId)) state.selectedDeviceId = devices[0]?.id ?? null;
    renderDeviceOptions(devices);
    renderDashboard();
    renderHistory();
    state.telemetryCounter += 1;
    if (state.telemetryCounter === 1 || state.telemetryCounter % 3 === 0) await loadTelemetry();
  } catch (error) {
    if (error.status === 401) return forceLogout();
    $("#fleet-status").textContent = "Mất kết nối API";
    $("#fleet-dot").className = "status-dot offline";
  }
}

function renderDeviceOptions(devices) {
  const select = $("#device-select");
  const previous = select.value;
  select.replaceChildren();
  if (!devices.length) {
    select.append(new Option("Chưa có thiết bị", ""));
    return;
  }
  devices.forEach((device) => select.append(new Option(device.name, device.id)));
  select.value = state.selectedDeviceId || previous || devices[0].id;
}

function renderDashboard() {
  const data = state.dashboard;
  if (!data) return;
  const devices = data.devices;
  const device = devices.find((item) => item.id === state.selectedDeviceId) || null;
  const onlineCount = devices.filter((item) => item.online).length;
  $("#device-count").textContent = String(devices.length);
  $("#last-sync").textContent = formatRelative(data.serverTime);
  $("#fleet-status").textContent = devices.length ? `${onlineCount}/${devices.length} thiết bị online` : "Chưa có thiết bị";
  $("#fleet-dot").className = `status-dot ${devices.length && onlineCount === devices.length ? "online" : "offline"}`;

  const fields = {
    "#selected-device-name": device?.name ?? "Chưa có thiết bị",
    "#device-location": device?.location || "Chưa khai báo vị trí",
    "#breaker-state": breakerLabel(device?.breaker_state),
    "#metric-voltage": metric(device?.voltage, 1),
    "#metric-current": metric(device?.current, 2),
    "#metric-power": metric(device?.active_power == null ? null : device.active_power / 1000, 2),
    "#metric-energy": metric(device?.energy_kwh, 2),
    "#detail-id": device?.id ?? "—",
    "#detail-firmware": device?.firmware_version ?? "—",
    "#detail-frequency": device?.frequency == null ? "—" : `${metric(device.frequency, 2)} Hz`,
    "#detail-pf": metric(device?.power_factor, 3),
    "#detail-temp": device?.temperature == null ? "—" : `${metric(device.temperature, 1)} °C`,
    "#detail-pm3": connectionLabel(device?.pm3_connected),
    "#detail-mts5": connectionLabel(device?.mts5_connected),
    "#detail-status-raw": rawStatus(device?.mts5_status_raw),
    "#detail-remote-control": device?.remote_control_enabled === 1 ? "ĐÃ MỞ KHÓA" : "ĐANG KHÓA",
    "#detail-last-seen": device?.last_seen_at ? formatDateTime(device.last_seen_at) : "Chưa kết nối",
    "#phase-va": withUnit(device?.voltage_a, 1, "V"),
    "#phase-vb": withUnit(device?.voltage_b, 1, "V"),
    "#phase-vc": withUnit(device?.voltage_c, 1, "V"),
    "#phase-vavg": withUnit(device?.voltage, 1, "V"),
    "#phase-ia": withUnit(device?.current_a, 3, "A"),
    "#phase-ib": withUnit(device?.current_b, 3, "A"),
    "#phase-ic": withUnit(device?.current_c, 3, "A"),
    "#phase-iavg": withUnit(device?.current, 3, "A"),
    "#phase-pa": withUnit(wattsToKw(device?.active_power_a), 3, "kW"),
    "#phase-pb": withUnit(wattsToKw(device?.active_power_b), 3, "kW"),
    "#phase-pc": withUnit(wattsToKw(device?.active_power_c), 3, "kW"),
    "#phase-ptotal": withUnit(wattsToKw(device?.active_power), 3, "kW"),
    "#phase-qa": withUnit(wattsToKw(device?.reactive_power_a), 3, "kvar"),
    "#phase-qb": withUnit(wattsToKw(device?.reactive_power_b), 3, "kvar"),
    "#phase-qc": withUnit(wattsToKw(device?.reactive_power_c), 3, "kvar"),
    "#phase-qtotal": withUnit(wattsToKw(device?.reactive_power), 3, "kvar"),
    "#phase-sa": withUnit(wattsToKw(device?.apparent_power_a), 3, "kVA"),
    "#phase-sb": withUnit(wattsToKw(device?.apparent_power_b), 3, "kVA"),
    "#phase-sc": withUnit(wattsToKw(device?.apparent_power_c), 3, "kVA"),
    "#phase-stotal": withUnit(wattsToKw(device?.apparent_power), 3, "kVA"),
    "#phase-pfa": metric(device?.power_factor_a, 3),
    "#phase-pfb": metric(device?.power_factor_b, 3),
    "#phase-pfc": metric(device?.power_factor_c, 3),
    "#phase-pfavg": metric(device?.power_factor, 3),
    "#line-vab": withUnit(device?.voltage_ab, 1, "V"),
    "#line-vbc": withUnit(device?.voltage_bc, 1, "V"),
    "#line-vca": withUnit(device?.voltage_ca, 1, "V"),
    "#phase-sequence": phaseSequenceLabel(device?.phase_sequence),
  };
  Object.entries(fields).forEach(([selector, value]) => $(selector).textContent = value);
  $("#voltage-note").textContent = voltageAssessment(device?.voltage);
  $("#online-badge").textContent = device?.online ? "ONLINE" : "OFFLINE";
  $("#online-badge").className = `badge ${device?.online ? "online" : "offline"}`;
  $("#breaker-switch").className = `breaker-switch ${breakerClass(device?.breaker_state)}`;

  const active = data.activeCommands.find((command) => command.device_id === device?.id);
  $("#command-state").textContent = active
    ? `${active.status === "PENDING" ? "Đang chờ thiết bị nhận" : "Thiết bị đang xử lý"}: ${active.action}`
    : device && device.remote_control_enabled !== 1
      ? "Điều khiển đang khóa tại ESP32"
      : "Không có lệnh đang chờ";
  const allowed = $("#open-button").dataset.allowed === "true";
  const hardwareReady = device?.remote_control_enabled === 1 && device?.mts5_connected === 1;
  $("#open-button").disabled = !allowed || !device?.online || !hardwareReady || Boolean(active) || device?.breaker_state === "OPEN";
  $("#close-button").disabled = !allowed || !device?.online || !hardwareReady || Boolean(active) || device?.breaker_state === "CLOSED" || device?.breaker_state === "TRIPPED";
}

async function loadTelemetry() {
  if (!state.selectedDeviceId) {
    state.telemetry = [];
    return drawChart();
  }
  try {
    const result = await api(`/api/devices/${encodeURIComponent(state.selectedDeviceId)}/telemetry?limit=60`);
    state.telemetry = result.telemetry.reverse();
    drawChart();
  } catch (error) {
    console.warn("Không tải được telemetry", error);
  }
}

function drawChart() {
  const canvas = $("#telemetry-chart");
  const values = state.telemetry.filter((point) => Number.isFinite(point.voltage) || Number.isFinite(point.current));
  $("#chart-empty").classList.toggle("hidden", values.length > 1);
  const box = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(box.width * scale));
  canvas.height = Math.max(1, Math.floor(box.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  const width = box.width, height = box.height;
  ctx.clearRect(0, 0, width, height);
  const pad = { left: 42, right: 36, top: 15, bottom: 28 };
  ctx.strokeStyle = "rgba(132,174,219,.12)";
  ctx.lineWidth = 1;
  ctx.font = "9px DM Mono";
  ctx.fillStyle = "#8193a8";
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + ((height - pad.top - pad.bottom) * i / 4);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
  }
  if (values.length < 2) return;
  drawSeries(ctx, values, "voltage", "#31d7ff", pad, width, height);
  drawSeries(ctx, values, "current", "#638cff", pad, width, height);
  const labelIndexes = [0, Math.floor((values.length - 1) / 2), values.length - 1];
  labelIndexes.forEach((index) => {
    const x = pad.left + (width - pad.left - pad.right) * index / (values.length - 1);
    ctx.textAlign = index === 0 ? "left" : index === values.length - 1 ? "right" : "center";
    ctx.fillText(new Date(values[index].sampled_at).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }), x, height - 7);
  });
}

function drawSeries(ctx, values, key, color, pad, width, height) {
  const numeric = values.map((item) => item[key]).filter(Number.isFinite);
  if (numeric.length < 2) return;
  let min = Math.min(...numeric), max = Math.max(...numeric);
  const delta = Math.max(max - min, Math.abs(max) * .06, 1);
  min -= delta * .2; max += delta * .2;
  ctx.beginPath();
  let started = false;
  values.forEach((item, index) => {
    if (!Number.isFinite(item[key])) return;
    const x = pad.left + (width - pad.left - pad.right) * index / (values.length - 1);
    const y = pad.top + (height - pad.top - pad.bottom) * (1 - (item[key] - min) / (max - min));
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
}

function renderHistory() {
  const body = $("#history-body");
  body.replaceChildren();
  const commands = state.dashboard?.recentCommands ?? [];
  if (!commands.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6; cell.textContent = "Chưa có lệnh điều khiển"; cell.className = "muted";
    row.append(cell); body.append(row); return;
  }
  commands.forEach((command) => {
    const row = document.createElement("tr");
    [formatDateTime(command.requested_at), command.device_name, command.action].forEach((value) => row.append(textCell(value)));
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `status-label ${command.status}`; badge.textContent = statusLabel(command.status);
    statusCell.append(badge); row.append(statusCell);
    row.append(textCell(command.requested_by_name), textCell(command.result_message || "—"));
    body.append(row);
  });
}

function openCommandDialog(action) {
  const device = state.dashboard?.devices.find((item) => item.id === state.selectedDeviceId);
  if (!device) return;
  state.pendingAction = action;
  const isOpen = action === "OPEN";
  $("#confirm-title").textContent = isOpen ? "Ngắt circuit breaker?" : "Đóng circuit breaker?";
  $("#confirm-copy").textContent = `${isOpen ? "Ngắt" : "Đóng"} “${device.name}”. Lệnh hết hạn sau 30 giây nếu thiết bị không nhận.`;
  $("#confirm-submit").textContent = isOpen ? "Ngắt CB" : "Đóng CB";
  $("#confirm-submit").className = `button ${isOpen ? "danger" : "success"}`;
  $("#confirm-dialog").showModal();
}

async function sendCommand(action) {
  if (state.preview) {
    const device = state.dashboard.devices.find((item) => item.id === state.selectedDeviceId);
    device.breaker_state = action === "OPEN" ? "OPEN" : "CLOSED";
    state.dashboard.recentCommands.unshift({
      requested_at: Date.now(), device_name: device.name, action, status: "SUCCEEDED",
      requested_by_name: state.user.display_name, result_message: "Mô phỏng thành công",
    });
    renderDashboard();
    renderHistory();
    toast(`Đã mô phỏng lệnh ${action}.`, "success");
    return;
  }
  try {
    const result = await api("/api/commands", { method: "POST", body: { deviceId: state.selectedDeviceId, action, expiresInSeconds: 30 } });
    toast(`Đã tạo lệnh ${result.command.action}.`, "success");
    await refreshDashboard();
  } catch (error) { toast(friendlyError(error), "error"); }
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(refreshDashboard, 2000);
}
function stopPolling() { if (state.pollTimer) clearInterval(state.pollTimer); state.pollTimer = null; }
function forceLogout() { stopPolling(); state.user = null; $("#app-view").classList.add("hidden"); showAuth("login"); toast("Phiên đăng nhập đã hết hạn.", "error"); }

async function api(path, options = {}) {
  const init = { method: options.method || "GET", credentials: "same-origin", headers: { Accept: "application/json" } };
  if (options.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(options.body); }
  const response = await fetch(path, init);
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data?.error?.message || `HTTP ${response.status}`); error.status = response.status; error.code = data?.error?.code; error.details = data?.error?.details; throw error; }
  return data;
}

async function submitForm(form, errorId, callback) {
  const button = form.querySelector("button[type=submit]");
  const original = button.textContent;
  setFormError(errorId, ""); button.disabled = true; button.textContent = "Đang xử lý…";
  try { await callback(Object.fromEntries(new FormData(form))); }
  catch (error) { setFormError(errorId, friendlyError(error)); }
  finally { button.disabled = false; button.textContent = original; }
}

function setFormError(id, message) { $(`#${id}`).textContent = message; }
function friendlyError(error) { return error?.message || "Không thể kết nối đến máy chủ"; }
function toast(message, kind = "info") { const element = document.createElement("div"); element.className = `toast ${kind}`; element.textContent = message; $("#toast-region").append(element); setTimeout(() => element.remove(), 4200); }
function textCell(value) { const cell = document.createElement("td"); cell.textContent = value ?? "—"; return cell; }
function metric(value, digits) { return Number.isFinite(value) ? Number(value).toFixed(digits) : "—"; }
function withUnit(value, digits, unit) { return Number.isFinite(value) ? `${Number(value).toFixed(digits)} ${unit}` : "—"; }
function wattsToKw(value) { return Number.isFinite(value) ? value / 1000 : null; }
function connectionLabel(value) { return value === 1 ? "KẾT NỐI" : value === 0 ? "MẤT KẾT NỐI" : "—"; }
function rawStatus(value) { return Number.isInteger(value) ? `${value} · 0x${value.toString(16).toUpperCase().padStart(4, "0")}` : "—"; }
function phaseSequenceLabel(value) { return value === 0 ? "THUẬN" : value === 1 ? "NGƯỢC" : Number.isInteger(value) ? `RAW ${value}` : "—"; }
function breakerLabel(value) { return ({ OPEN: "ĐANG NGẮT", CLOSED: "ĐANG ĐÓNG", TRIPPED: "ĐÃ TRIP", UNKNOWN: "KHÔNG XÁC ĐỊNH" })[value] || "KHÔNG XÁC ĐỊNH"; }
function breakerClass(value) { return ({ OPEN: "open", CLOSED: "closed", TRIPPED: "open" })[value] || "unknown"; }
function roleLabel(role) { return ({ ADMIN: "Quản trị viên", OPERATOR: "Vận hành", VIEWER: "Chỉ xem" })[role] || role; }
function statusLabel(status) { return ({ PENDING: "ĐANG CHỜ", CLAIMED: "ĐANG XỬ LÝ", SUCCEEDED: "THÀNH CÔNG", FAILED: "THẤT BẠI", EXPIRED: "HẾT HẠN", CANCELLED: "ĐÃ HỦY" })[status] || status; }
function voltageAssessment(value) { if (!Number.isFinite(value)) return "Chờ dữ liệu"; if (value < 198 || value > 242) return "Ngoài ngưỡng ±10%"; return "Trong ngưỡng ổn định"; }
function formatDateTime(value) { return new Date(value).toLocaleString("vi-VN", { hour12: false }); }
function formatRelative(value) { const seconds = Math.max(0, Math.round((Date.now() - value) / 1000)); return seconds < 2 ? "Vừa xong" : `${seconds} giây trước`; }
function updateClock() { const now = new Date(); $("#current-date").textContent = now.toLocaleDateString("vi-VN", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }); $("#current-time").textContent = now.toLocaleTimeString("vi-VN", { hour12: false }); }
function debounce(fn, wait) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); }; }
