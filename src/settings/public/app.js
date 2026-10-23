const loginPanel = document.getElementById("loginPanel");
const appPanel = document.getElementById("appPanel");
const sessionBar = document.getElementById("sessionBar");
const sessionMeta = document.getElementById("sessionMeta");
const roleBadge = document.getElementById("roleBadge");
const connectorList = document.getElementById("connectorList");
const configEditor = document.getElementById("configEditor");
const editorTitle = document.getElementById("editorTitle");
const saveBtn = document.getElementById("saveBtn");
const reloadBtn = document.getElementById("reloadBtn");
const loginStatus = document.getElementById("loginStatus");
const editorStatus = document.getElementById("editorStatus");
const runPanel = document.getElementById("runPanel");
const runBtn = document.getElementById("runBtn");
const refreshJobBtn = document.getElementById("refreshJobBtn");
const runStatus = document.getElementById("runStatus");
const jobBox = document.getElementById("jobBox");
const auditList = document.getElementById("auditList");

let state = {
  username: null,
  role: null,
  canEdit: false,
  selected: null,
  lastRequestId: null,
  pollTimer: null,
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function setStatus(el, message, kind = "") {
  el.textContent = message || "";
  el.className = `status${kind ? ` ${kind}` : ""}`;
}

function stopPoll() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function showLoggedOut() {
  stopPoll();
  state = {
    username: null,
    role: null,
    canEdit: false,
    selected: null,
    lastRequestId: null,
    pollTimer: null,
  };
  loginPanel.classList.remove("hidden");
  appPanel.classList.add("hidden");
  sessionBar.classList.add("hidden");
  runPanel.classList.add("hidden");
  configEditor.value = "";
  configEditor.disabled = true;
  saveBtn.disabled = true;
  reloadBtn.disabled = true;
  refreshJobBtn.disabled = true;
  jobBox.classList.add("hidden");
}

function showLoggedIn(user) {
  state.username = user.username;
  state.role = user.role;
  state.canEdit = user.role === "admin";
  loginPanel.classList.add("hidden");
  appPanel.classList.remove("hidden");
  sessionBar.classList.remove("hidden");
  sessionMeta.textContent = `Signed in as ${user.username}`;
  roleBadge.textContent = user.role;
  roleBadge.className = `badge ${user.role}`;
  saveBtn.disabled = !state.canEdit || !state.selected;
  configEditor.readOnly = !state.canEdit;
  runPanel.classList.toggle("hidden", !state.canEdit);
}

async function loadConnectors() {
  const data = await api("/api/connectors");
  state.canEdit = Boolean(data.canEdit);
  runPanel.classList.toggle("hidden", !state.canEdit);
  connectorList.innerHTML = "";
  for (const key of data.connectors) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = key;
    button.className = state.selected === key ? "active" : "";
    button.addEventListener("click", () => selectConnector(key));
    connectorList.appendChild(button);
  }
  if (!state.selected && data.connectors.length) {
    await selectConnector(data.connectors[0]);
  }
}

async function selectConnector(key) {
  state.selected = key;
  for (const button of connectorList.querySelectorAll("button")) {
    button.classList.toggle("active", button.textContent === key);
  }
  editorTitle.textContent = key;
  setStatus(editorStatus, "Loading…");
  const data = await api(`/api/connectors/${encodeURIComponent(key)}`);
  configEditor.value = JSON.stringify(data.config, null, 2);
  configEditor.disabled = false;
  configEditor.readOnly = !state.canEdit;
  reloadBtn.disabled = false;
  saveBtn.disabled = !state.canEdit;
  setStatus(
    editorStatus,
    state.canEdit ? "Admin: you can save changes and run extracts." : "Viewer: read only.",
    state.canEdit ? "ok" : ""
  );
  updateTargetHint();
}

async function loadAudit() {
  try {
    const data = await api("/api/audit?limit=40");
    if (!data.items.length) {
      auditList.textContent = "No audit events yet.";
      return;
    }
    auditList.innerHTML = "";
    for (const item of data.items) {
      const row = document.createElement("div");
      row.className = "audit-row";
      const detail = [
        item.connector ? `connector=${item.connector}` : "",
        item.target ? `target=${item.target}` : "",
        item.requestId ? `job=${item.requestId}` : "",
        item.mode ? `mode=${item.mode}` : "",
        item.error ? `error=${item.error}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      row.innerHTML = `<span>${item.at || ""}</span><span>${item.action || ""}</span><span>${item.username || ""} ${detail}</span>`;
      auditList.appendChild(row);
    }
  } catch (error) {
    auditList.textContent = error.message;
  }
}

async function refreshJob() {
  if (!state.lastRequestId) return;
  try {
    const job = await api(`/api/extractions/${encodeURIComponent(state.lastRequestId)}`);
    jobBox.textContent = JSON.stringify(job, null, 2);
    jobBox.classList.remove("hidden");
    const kind = job.status === "failed" ? "error" : job.status === "succeeded" ? "ok" : "";
    setStatus(runStatus, `Job status: ${job.status}${job.error ? ` — ${job.error}` : ""}`, kind);
    if (job.status === "succeeded" || job.status === "failed") {
      stopPoll();
      await loadAudit();
    }
  } catch (error) {
    stopPoll();
    setStatus(runStatus, error.message, "error");
  }
}

function startPoll() {
  stopPoll();
  state.pollTimer = setInterval(() => {
    refreshJob().catch(() => {});
  }, 2000);
}

document.getElementById("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus(loginStatus, "Signing in…");
  try {
    const user = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.getElementById("username").value,
        password: document.getElementById("password").value,
      }),
    });
    showLoggedIn(user);
    setStatus(loginStatus, "");
    await loadConnectors();
    await loadAudit();
  } catch (error) {
    setStatus(loginStatus, error.message, "error");
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
  showLoggedOut();
  setStatus(loginStatus, "Logged out.");
});

saveBtn.addEventListener("click", async () => {
  if (!state.selected || !state.canEdit) return;
  setStatus(editorStatus, "Saving…");
  try {
    const config = JSON.parse(configEditor.value);
    await api(`/api/connectors/${encodeURIComponent(state.selected)}`, {
      method: "PUT",
      body: JSON.stringify({ config }),
    });
    setStatus(editorStatus, "Saved.", "ok");
    await loadAudit();
  } catch (error) {
    setStatus(editorStatus, error.message, "error");
  }
});

reloadBtn.addEventListener("click", async () => {
  if (!state.selected) return;
  try {
    await selectConnector(state.selected);
  } catch (error) {
    setStatus(editorStatus, error.message, "error");
  }
});

function updateTargetHint() {
  const hint = document.getElementById("targetHint");
  if (!hint) return;
  const target = document.getElementById("extractTarget")?.value || "mongo";
  const key = state.selected || "<connector>";
  hint.textContent =
    target === "jsonl"
      ? `Local JSONL → data/output/${key}/ (same as npm run extract:${key})`
      : `MongoDB → database from MONGO_URL, collection "${key}" (same as npm run extract:${key}:mongo)`;
}

document.getElementById("extractTarget")?.addEventListener("change", updateTargetHint);

runBtn.addEventListener("click", async () => {
  if (!state.selected || !state.canEdit) return;
  setStatus(runStatus, "Starting extract…");
  try {
    const objects = document.getElementById("extractObjects").value;
    const mode = document.getElementById("extractMode").value;
    const target = document.getElementById("extractTarget").value;
    const created = await api(`/api/connectors/${encodeURIComponent(state.selected)}/extract`, {
      method: "POST",
      body: JSON.stringify({ objects, mode, target }),
    });
    state.lastRequestId = created.request_id;
    refreshJobBtn.disabled = false;
    jobBox.textContent = JSON.stringify(created, null, 2);
    jobBox.classList.remove("hidden");
    setStatus(
      runStatus,
      `Queued ${created.request_id} (${created.target || target}, ${mode})`,
      "ok"
    );
    await loadAudit();
    startPoll();
    await refreshJob();
  } catch (error) {
    setStatus(runStatus, error.message, "error");
  }
});

refreshJobBtn.addEventListener("click", () => {
  refreshJob().catch(() => {});
});

document.getElementById("refreshAuditBtn").addEventListener("click", () => {
  loadAudit().catch(() => {});
});

async function boot() {
  try {
    const me = await api("/api/me");
    showLoggedIn(me);
    await loadConnectors();
    await loadAudit();
  } catch {
    showLoggedOut();
  }
}

boot();
