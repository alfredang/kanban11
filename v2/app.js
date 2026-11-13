"use strict";

(() => {

/* ==================================================================
   0. HARDENING GUARDS
   - Frame-busting (GitHub Pages cannot send frame-ancestors headers)
   - No HTML-string injection anywhere: the DOM is built with createElement/textContent,
     so user strings are never parsed as HTML (stronger than escaping).
   ================================================================== */
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  try { window.top.location = window.self.location.href; } catch (e) { /* cross-origin: stay hidden */ }
  return;
}

/* ==================================================================
   1. CONFIG — the ONLY place the notification address appears
   ================================================================== */
const FORMSUBMIT_ENDPOINT = "https://formsubmit.co/ajax/YOUR_EMAIL@example.com";
const REQUEST_TIMEOUT_MS = 15000;

const STATUSES   = Object.freeze(["Backlog", "In Progress", "Blocked", "Done"]);
const PROJECTS   = Object.freeze(["Core Banking Upgrade", "Digital Channels", "Cybersecurity Uplift", "Data & Analytics", "Infrastructure & Cloud", "Vendor Management"]);
const CATEGORIES = Object.freeze(["Application Development", "Infrastructure", "Cybersecurity", "Data", "Compliance", "Vendor"]);
const PRIORITIES = Object.freeze(["Critical", "High", "Medium", "Low"]);
const TABS       = Object.freeze(["board", "visual", "timeline"]);

const STATUS_META = Object.freeze({
  "Backlog":     { icon: "✎", hint: "Logged, not yet scheduled" },
  "In Progress": { icon: "⚡", hint: "Actively being worked" },
  "Blocked":     { icon: "⛔", hint: "Waiting on a dependency, vendor or approval" },
  "Done":        { icon: "★", hint: "Completed / closed" }
});

const LIMITS = Object.freeze({
  title: 80, description: 500, assignee: 50, filter: 50,
  maxTasks: 60,            // caps memory/DOM growth
  submitCooldownMs: 3000,  // throttles repeated submits (and FormSubmit calls)
  maxDueYears: 5
});

const ID_RE = /^UOB-ITPM-\d{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ==================================================================
   2. STATE — single source of truth (memory only, no storage APIs)
   ================================================================== */
const state = {
  tasks: [],
  filters: { project: "", assignee: "", priority: "" },
  nextId: 1,
  pendingDelete: null,
  tab: "board",
  justChanged: null,   // id of the card that should play its "pop" animation
  intro: true,         // first render plays the staggered intro
  lastSubmitAt: 0
};

/* ==================================================================
   3. UTILITIES
   ================================================================== */
const $ = id => document.getElementById(id);

/** Strip control + bidi-override characters, collapse whitespace, trim, cap length. */
function clean(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Tiny safe element builder. Strings become text nodes, never HTML. */
function build(ns, tag, props, kids) {
  const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "text") el.textContent = v;
    else if (k === "data") { for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv; }
    else if (/^on/i.test(k) || k === "style" || k === "srcdoc") continue;   // never set handlers/inline style via attrs
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}
const h  = (tag, props, ...kids) => build(null, tag, props, kids);
const sv = (tag, props, ...kids) => build(SVG_NS, tag, props, kids);

const toISODate = d => {
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
};
const todayISO = () => toISODate(new Date());
function daysFromToday(n) { const d = new Date(); d.setDate(d.getDate() + n); return toISODate(d); }

/** Whole-day number (UTC) for an ISO date, used for timeline maths. */
function dayNum(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return d + " " + MONTHS[m - 1] + " " + y;
}
function shortDay(num) {
  const d = new Date(num * 86400000);
  return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()];
}
function isValidISO(iso) {
  if (!DATE_RE.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const isOverdue = t => t.status !== "Done" && t.dueDate < todayISO();
const daysLate = t => dayNum(todayISO()) - dayNum(t.dueDate);
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const formatTaskId = n => "UOB-ITPM-" + String(n).padStart(4, "0");
const createTaskId = () => formatTaskId(state.nextId++);
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ==================================================================
   4. SEED DATA — consumes IDs 0001–0008 (new tasks start at 0009)
   ================================================================== */
function seedTasks() {
  // title, description, project, category, assignee, priority, due(+days), status, duration(days)
  const seeds = [
    ["Migrate FX pricing service to AWS", "Lift-and-shift the FX pricing microservice to the new landing zone with blue/green cutover.", "Infrastructure & Cloud", "Infrastructure", "Priya Nair", "High", 21, "In Progress", 35],
    ["Patch CVE-2025-XXXX on branch teller VDI", "Roll out emergency vendor patch to all branch teller virtual desktop images.", "Cybersecurity Uplift", "Cybersecurity", "Daniel Tan", "Critical", -2, "In Progress", 12],
    ["UAT sign-off for mobile onboarding release 4.2", "Business sign-off pending on accessibility defects raised in UAT cycle 2.", "Digital Channels", "Application Development", "Aisha Rahman", "High", 3, "Blocked", 18],
    ["Core banking v12 SIT environment refresh", "Waiting on vendor to issue refreshed licence keys before environment rebuild.", "Core Banking Upgrade", "Infrastructure", "Marcus Lim", "Critical", -5, "Blocked", 25],
    ["Renegotiate core hosting SLA with vendor", "Prepare benchmarking pack and draft revised SLA credits for renewal.", "Vendor Management", "Vendor", "Wei Ling Chua", "Medium", 30, "Backlog", 20],
    ["Build regulatory returns data mart", "Design conformed dimensions and lineage for quarterly regulatory returns.", "Data & Analytics", "Compliance", "Rohan Mehta", "High", 45, "Backlog", 30],
    ["Decommission legacy SFTP gateway", "All partners migrated; remove firewall rules and archive configs.", "Infrastructure & Cloud", "Infrastructure", "Sarah Ong", "Low", -10, "Done", 28],
    ["Remediate internet banking pen-test findings", "All high and medium findings closed and re-tested by the security team.", "Cybersecurity Uplift", "Cybersecurity", "Kevin Lau", "Medium", -4, "Done", 20]
  ];
  return seeds.map(s => ({
    id: createTaskId(),
    title: s[0], description: s[1], project: s[2], category: s[3],
    assignee: s[4], priority: s[5], dueDate: daysFromToday(s[6]), status: s[7],
    startDate: daysFromToday(s[6] - s[8])
  }));
}

/* ==================================================================
   5. FILTERING
   ================================================================== */
function applyFilters(tasks) {
  const f = state.filters;
  const needle = f.assignee.trim().toLowerCase();
  return tasks.filter(t =>
    (!f.project  || t.project === f.project) &&
    (!f.priority || t.priority === f.priority) &&
    (!needle     || t.assignee.toLowerCase().includes(needle))
  );
}

/* ==================================================================
   6. RENDERING — DOM built only here, never via HTML strings
   ================================================================== */
function renderSummary() {
  const items = [["Total", state.tasks.length, ""]];
  STATUSES.forEach(s => items.push([s, state.tasks.filter(t => t.status === s).length, "s-" + slug(s)]));
  items.push(["Overdue", state.tasks.filter(isOverdue).length, "overdue-stat"]);
  $("summary").replaceChildren(...items.map(([label, n, cls]) =>
    h("li", { class: cls }, h("span", { class: "num", text: n }), h("span", { class: "lbl", text: label }))
  ));
}

function renderCard(task, index) {
  const id = task.id;
  const confirming = state.pendingDelete === id;
  const prio = slug(task.priority);

  const moveSelect = h("select", {
      class: "move-select", "aria-label": "Move " + id + " to another column",
      data: { action: "move", id, focus: "move-" + id }
    },
    h("option", { value: "", selected: true, disabled: true, text: "Move ▸" }),
    STATUSES.filter(s => s !== task.status).map(s => h("option", { value: s, text: s }))
  );

  const deleteControl = confirming
    ? h("span", { class: "confirm-delete", role: "group", "aria-label": "Confirm delete" },
        "Delete? ",
        h("button", { type: "button", class: "mini-btn danger", text: "Yes", data: { action: "delete-yes", id, focus: "yes-" + id } }),
        h("button", { type: "button", class: "mini-btn", text: "No", data: { action: "delete-no", id } }))
    : h("button", { type: "button", class: "icon-btn", text: "×", "aria-label": "Delete task " + id, data: { action: "delete", id, focus: "del-" + id } });

  const card = h("article", {
      class: "card prio-" + prio + (state.intro ? " intro" : "") + (state.justChanged === id ? " pop" : ""),
      draggable: "true", "aria-label": id + ": " + task.title, data: { id }
    },
    h("div", { class: "card-top" },
      h("span", { class: "card-id", text: id }),
      isOverdue(task) ? h("span", { class: "badge-overdue", text: "Overdue" }) : null),
    h("h3", { class: "card-title", text: task.title }),
    h("div", { class: "tags" },
      h("span", { class: "pill pill-" + prio, text: task.priority }),
      h("span", { class: "tag", text: task.category })),
    h("p", { class: "card-meta" },
      h("span", {}, h("strong", { text: "Project: " }), task.project),
      h("span", {}, h("strong", { text: "Assignee: " }), task.assignee),
      h("span", {}, h("strong", { text: "Due: " }), formatDate(task.dueDate))),
    h("div", { class: "card-actions" }, moveSelect, deleteControl)
  );
  card.style.setProperty("--i", String(index));
  return card;
}

function renderBoard() {
  const active = document.activeElement;
  const focusKey = active && active.dataset ? active.dataset.focus : null;
  const visible = applyFilters(state.tasks);

  let n = 0;
  $("board").replaceChildren(...STATUSES.map(status => {
    const inCol = visible.filter(t => t.status === status);
    const sid = slug(status);
    return h("section", { class: "column col-" + sid, "aria-labelledby": "h-" + sid, data: { status } },
      h("div", { class: "column-header" },
        h("h2", { id: "h-" + sid }, h("span", { class: "col-icon", "aria-hidden": "true", text: STATUS_META[status].icon }), status),
        h("span", { class: "count-badge", "aria-label": inCol.length + " tasks", text: inCol.length })),
      h("p", { class: "column-hint", text: STATUS_META[status].hint }),
      h("div", { class: "card-list" }, inCol.length ? inCol.map(t => renderCard(t, n++)) : h("p", { class: "empty", text: "No tasks" })));
  }));

  if (focusKey) {
    const el = [...$("board").querySelectorAll("[data-focus]")].find(e => e.dataset.focus === focusKey);
    if (el) el.focus();
  }
}

/* ---------- Visual tab ---------- */
function renderVisual() {
  const tasks = applyFilters(state.tasks);
  const total = tasks.length;
  const count = s => tasks.filter(t => t.status === s).length;
  const done = count("Done");
  const overdue = tasks.filter(isOverdue);
  const pct = total ? Math.round(done / total * 100) : 0;

  const kpi = (cls, big, small) => h("div", { class: "kpi " + cls }, h("span", { class: "big", text: big }), h("span", { class: "small", text: small }));
  const kpis = h("div", { class: "v-kpis" },
    kpi("k-total", total, "Tasks in view"),
    kpi("k-done", pct + "%", "Completed (" + done + " of " + total + ")"),
    kpi("k-blocked", count("Blocked"), "Blocked — need help"),
    kpi("k-overdue", overdue.length, "Overdue"));

  // Donut: status share. Circumference of r=15.9155 is 100, so dash lengths are percentages.
  let cum = 0;
  const segs = total ? STATUSES.filter(s => count(s) > 0).map(s => {
    const p = count(s) / total * 100;
    const circle = sv("circle", {
      class: "seg seg-" + slug(s), cx: 21, cy: 21, r: 15.9155,
      "stroke-dasharray": Math.max(p - (STATUSES.filter(x => count(x) > 0).length > 1 ? 1 : 0), 0.1).toFixed(2) + " " + (100 - p + 1).toFixed(2),
      "stroke-dashoffset": (25 - cum).toFixed(2)
    });
    cum += p;
    return circle;
  }) : [];
  const donut = sv("svg", { class: "donut", viewBox: "0 0 42 42", role: "img",
      "aria-label": "Tasks by status: " + STATUSES.map(s => s + " " + count(s)).join(", ") },
    sv("circle", { class: "donut-ring", cx: 21, cy: 21, r: 15.9155 }), segs,
    sv("text", { class: "donut-num", x: 21, y: 22.5, text: total }),
    sv("text", { class: "donut-lbl", x: 21, y: 27, text: "tasks" }));
  const legend = h("ul", { class: "legend" }, STATUSES.map(s =>
    h("li", {}, h("span", { class: "swatch seg-" + slug(s) }), s + ": " + count(s))));

  // Priority bars
  const maxP = Math.max(1, ...PRIORITIES.map(p => tasks.filter(t => t.priority === p).length));
  const priorityRows = PRIORITIES.map(p => {
    const n = tasks.filter(t => t.priority === p).length;
    const fill = h("div", { class: "bar-fill p-" + slug(p) });
    fill.style.width = (n / maxP * 100) + "%";
    return h("div", { class: "bar-row" }, h("span", { class: "bar-label", text: p }), h("div", { class: "bar-track" }, fill), h("span", { class: "bar-val", text: n }));
  });

  // Stacked bars: status mix per project
  const projectRows = PROJECTS.map(pr => {
    const inP = tasks.filter(t => t.project === pr);
    const parts = STATUSES.filter(s => inP.some(t => t.status === s)).map(s => {
      const n = inP.filter(t => t.status === s).length;
      const part = h("span", { class: "seg-part seg-" + slug(s), title: s + ": " + n, text: n });
      part.style.flexGrow = String(n);
      return part;
    });
    return h("div", { class: "bar-row" }, h("span", { class: "bar-label", text: pr }), h("div", { class: "bar-track" }, parts), h("span", { class: "bar-val", text: inP.length }));
  });

  const rescue = overdue.sort((a, b) => b.dueDate < a.dueDate ? 1 : -1);

  const grid = [
    kpis,
    h("section", { class: "v-card v-donut", "aria-labelledby": "vh-status" },
      h("h2", { id: "vh-status", text: "Status mix" }), h("div", { class: "donut-wrap" }, donut, legend)),
    h("section", { class: "v-card v-priority", "aria-labelledby": "vh-prio" },
      h("h2", { id: "vh-prio", text: "Tasks by priority" }), priorityRows),
    h("section", { class: "v-card v-projects", "aria-labelledby": "vh-proj" },
      h("h2", { id: "vh-proj", text: "Project progress (numbers = tasks per status)" }), projectRows,
      h("ul", { class: "legend" }, h("li", {}, "Colours: ", ...STATUSES.map(s => h("span", { class: "swatch seg-" + slug(s), title: s }))))),
    h("section", { class: "v-card v-rescue", "aria-labelledby": "vh-late" },
      h("h2", { id: "vh-late", text: "Rescue list: overdue tasks" }),
      rescue.length
        ? h("ul", { class: "rescue" }, rescue.map(t => h("li", {},
            h("div", { class: "r-id", text: t.id }), h("div", { text: t.title }),
            h("div", { class: "r-late", text: daysLate(t) + (daysLate(t) === 1 ? " day" : " days") + " late · " + t.assignee }))))
        : h("p", { class: "empty", text: "Nothing overdue. High five!" }))
  ];
  $("visual").replaceChildren(...grid);
}

/* ---------- Timeline tab ---------- */
function renderTimeline() {
  const root = $("timeline");
  const tasks = applyFilters(state.tasks).slice()
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
  if (!tasks.length) {
    root.replaceChildren(h("p", { class: "empty big", text: "No tasks match the filters, so there is nothing to plot." }));
    return;
  }

  const today = dayNum(todayISO());
  let min = today, max = today;
  tasks.forEach(t => { min = Math.min(min, dayNum(t.startDate)); max = Math.max(max, dayNum(t.dueDate)); });
  min -= 2; max += 4;
  const days = max - min + 1;
  const pos = d => ((d - min) / days * 100);

  const ticks = h("div", { class: "tl-ticks" });
  for (let d = min; d <= max; d++) {
    if (new Date(d * 86400000).getUTCDay() !== 1) continue;      // a tick on every Monday
    const tick = h("span", { class: "tl-tick", text: shortDay(d) });
    tick.style.left = pos(d) + "%";
    ticks.append(tick);
  }
  const todayTag = h("span", { class: "tl-today-tag", text: "Today" });
  todayTag.style.left = pos(today + 0.5) + "%";
  ticks.append(todayTag);

  const rows = tasks.map((t, i) => {
    const s = dayNum(t.startDate), e = dayNum(t.dueDate);
    const late = isOverdue(t);
    const bar = h("span", { class: "tl-bar b-" + slug(t.status) + (late ? " is-overdue" : "") });
    bar.style.left = pos(s) + "%";
    bar.style.width = ((e - s + 1) / days * 100) + "%";
    bar.style.setProperty("--i", String(i));
    const due = h("span", { class: "tl-due" + (late ? " late" : ""), text: (late ? "Overdue · " : "") + shortDay(e) });
    due.style.left = pos(e + 1) + "%";
    const marker = h("span", { class: "tl-today" });
    marker.style.left = pos(today + 0.5) + "%";
    return h("li", { class: "tl-row", "aria-label": t.id + ", " + t.title + ", " + t.status + ", " + formatDate(t.startDate) + " to " + formatDate(t.dueDate) + (late ? ", overdue" : "") },
      h("div", { class: "tl-label" },
        h("span", { class: "t-id", text: t.id }), h("span", { class: "t-title", text: t.title }),
        h("span", { class: "t-who", text: t.assignee + " · " + t.status })),
      h("div", { class: "tl-track" }, marker, bar, due));
  });

  const legend = h("ul", { class: "tl-legend" },
    STATUSES.map(s => h("li", {}, h("span", { class: "tl-swatch b-" + slug(s) }), s)),
    h("li", {}, h("span", { class: "tl-swatch is-overdue" }), "Overdue (striped)"),
    h("li", {}, h("span", { "aria-hidden": "true", text: "◆" }), "Due date"));

  const tl = h("div", { class: "tl" },
    h("div", { class: "tl-head", "aria-hidden": "true" }, h("div", { class: "tl-spacer" }), ticks),
    h("ol", { class: "tl-list" }, rows));
  tl.style.setProperty("--days", String(days));

  root.replaceChildren(h("div", { class: "tl-card" },
    h("p", { class: "v-note", text: "Each bar runs from a task's start to its due date, sorted by due date. The dashed red line is today." }),
    legend, h("div", { class: "tl-scroll", tabindex: "0", role: "region", "aria-label": "Timeline, scrollable" }, tl)));
}

function renderAll() {
  renderSummary();
  renderBoard();
  renderVisual();
  renderTimeline();
  state.intro = false;
  state.justChanged = null;
}

/* ---------- Tabs ---------- */
function selectTab(name, focus) {
  if (!TABS.includes(name)) name = "board";
  state.tab = name;
  TABS.forEach(t => {
    const btn = $("tab-" + t), on = t === name;
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
    $("panel-" + t).hidden = !on;
  });
  if (focus) $("tab-" + name).focus();
  try { history.replaceState(null, "", "#" + name); } catch (e) { /* ignore */ }
}

/* ==================================================================
   7. ACTIONS
   ================================================================== */
function confetti() {
  if (reducedMotion()) return;
  const layer = $("confetti");
  const colors = ["#ff7eb6", "#ffd23f", "#7cc8ff", "#8ee3a9", "#c4b5fd", "#ff9a8b"];
  for (let i = 0; i < 28; i++) {
    const c = h("span", { class: "confetto" });
    c.style.left = Math.random() * 100 + "%";
    c.style.setProperty("--c", colors[i % colors.length]);
    c.style.setProperty("--dx", (Math.random() * 160 - 80) + "px");
    c.style.setProperty("--rot", (360 + Math.random() * 540) + "deg");
    c.style.setProperty("--dur", (1.1 + Math.random() * 0.9) + "s");
    c.style.setProperty("--delay", (Math.random() * 0.3) + "s");
    layer.append(c);
    setTimeout(() => c.remove(), 2600);
  }
}

function addTask(fields) {
  const task = Object.assign({ id: createTaskId(), startDate: todayISO() }, fields);
  state.tasks.push(task);
  state.justChanged = task.id;
  renderAll();
  return task;
}

function moveTask(id, newStatus) {
  if (!ID_RE.test(id) || !STATUSES.includes(newStatus)) return;     // whitelist both inputs
  const task = state.tasks.find(t => t.id === id);
  if (!task || task.status === newStatus) return;
  task.status = newStatus;
  state.pendingDelete = null;
  state.justChanged = id;
  renderAll();
  showToast(id + " moved to " + newStatus, "info");
  if (newStatus === "Done") confetti();
}

function deleteTask(id) {
  if (!ID_RE.test(id)) return;
  state.tasks = state.tasks.filter(t => t.id !== id);
  state.pendingDelete = null;
  renderAll();
  showToast(id + " deleted", "info");
}

function showToast(message, type) {
  const region = $("toast-region");
  const el = h("div", { class: "toast " + (type === "success" || type === "warning" ? type : "info"), text: message });
  region.append(el);
  while (region.children.length > 4) region.firstElementChild.remove();
  setTimeout(() => el.remove(), 4500);
}

/* ==================================================================
   8. FORM VALIDATION + FORMSUBMIT NOTIFICATION
   ================================================================== */
function readForm() {
  const f = $("task-form");
  return {
    title: clean(f.title.value, LIMITS.title),
    description: clean(f.description.value, LIMITS.description),
    project: f.project.value,
    category: f.category.value,
    assignee: clean(f.assignee.value, LIMITS.assignee),
    priority: f.priority.value,
    dueDate: f.dueDate.value,
    status: f.status.value
  };
}

/** Whitelist/length/date validation. Runs on cleaned values, so tampered <select> values fail here. */
function validateTask(v) {
  const errors = {};
  if (!v.title) errors.title = "Task title is required.";
  if (!v.assignee) errors.assignee = "Assignee is required.";
  if (!v.dueDate) errors.dueDate = "Due date is required.";
  else if (!isValidISO(v.dueDate)) errors.dueDate = "Enter a valid date.";
  else if (v.dueDate < todayISO()) errors.dueDate = "Due date must not be in the past.";
  else if (dayNum(v.dueDate) - dayNum(todayISO()) > LIMITS.maxDueYears * 366) errors.dueDate = "Due date is too far in the future.";
  if (!PROJECTS.includes(v.project) || !CATEGORIES.includes(v.category) ||
      !PRIORITIES.includes(v.priority) || !STATUSES.includes(v.status)) errors.form = "Invalid selection.";
  return errors;
}

const FIELDS = ["title", "description", "assignee", "dueDate"];
function showFormErrors(errors) {
  FIELDS.forEach(name => {
    const msg = errors[name] || "";
    const wrap = document.querySelector('[data-field="' + name + '"]');
    const input = wrap.querySelector("input, textarea");
    $("err-" + name).textContent = msg;
    wrap.classList.toggle("has-error", Boolean(msg));
    if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
  });
  const first = FIELDS.find(n => errors[n]);
  if (first) document.querySelector('[data-field="' + first + '"]').querySelector("input, textarea").focus();
}

/** Neutralise spreadsheet-formula injection in the notification email's table cells. */
const safeCell = s => (/^[=+\-@\t\r]/.test(s) ? "'" + s : s);

async function notifyNewTask(task) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(FORMSUBMIT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      body: JSON.stringify({
        _subject: "[UOB IT PMO] New task " + task.id,
        _template: "table",
        _captcha: "false",
        "Task ID": task.id,
        Title: safeCell(task.title),
        Description: safeCell(task.description),
        Project: task.project,
        Category: task.category,
        Assignee: safeCell(task.assignee),
        Priority: task.priority,
        "Due Date": task.dueDate,
        Status: task.status,
        "Submitted At": new Date().toISOString()
      })
    });
    if (!res.ok) throw new Error("FormSubmit failed: " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  const btn = $("submit-btn");
  if (btn.disabled) return;

  const now = Date.now();
  if (now - state.lastSubmitAt < LIMITS.submitCooldownMs) { showToast("Easy there! Wait a moment before adding another task.", "warning"); return; }
  if (state.tasks.length >= LIMITS.maxTasks) { showToast("Demo limit reached (" + LIMITS.maxTasks + " tasks). Delete one first.", "warning"); return; }

  const values = readForm();
  const errors = validateTask(values);
  showFormErrors(errors);
  if (errors.form) showToast(errors.form, "warning");
  if (Object.keys(errors).length) return;

  state.lastSubmitAt = now;
  btn.disabled = true;
  btn.textContent = "Sending…";

  const task = addTask(values);                  // optimistic: card shows immediately
  showToast("Task " + task.id + " added", "success");
  try {
    await notifyNewTask(task);
    showToast("Email notification sent", "success");
  } catch (err) {
    showToast("Card added locally — email notification failed", "warning");   // never affects the board
  } finally {
    btn.disabled = false;
    btn.textContent = "Add Task";
    closeModal();
  }
}

/* ==================================================================
   9. MODAL + FORM HELPERS
   ================================================================== */
function fillSelect(select, options, firstLabel) {
  const opts = options.map(o => h("option", { value: o, text: o }));
  if (firstLabel) opts.unshift(h("option", { value: "", text: firstLabel }));
  select.replaceChildren(...opts);
}

function resetForm() {
  const f = $("task-form");
  f.reset();
  f.priority.value = "Medium";
  f.status.value = "Backlog";
  f.dueDate.min = todayISO();
  $("count-description").textContent = "0 / " + LIMITS.description;
  showFormErrors({});
}

let lastFocused = null;
function openModal() {
  lastFocused = document.activeElement;
  resetForm();
  $("app").inert = true;               // background cannot be tabbed to or clicked
  $("modal").hidden = false;
  $("t-title").focus();
}
function closeModal() {
  $("modal").hidden = true;
  $("app").inert = false;
  if (lastFocused && lastFocused.focus) lastFocused.focus();
}

function trapFocus(e) {
  const modal = $("modal");
  if (modal.hidden) return;
  if (e.key === "Escape") { closeModal(); return; }
  if (e.key !== "Tab") return;
  const focusable = modal.querySelectorAll("button:not([disabled]), input, select, textarea");
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* ==================================================================
   10. EVENT WIRING (delegated on #board; board is rebuilt often)
   ================================================================== */
function initEvents() {
  const board = $("board");

  board.addEventListener("click", e => {
    const btn = e.target.closest("[data-action]");
    if (!btn || btn.tagName === "SELECT") return;
    const id = btn.dataset.id;
    if (btn.dataset.action === "delete") { state.pendingDelete = id; renderBoard(); }
    else if (btn.dataset.action === "delete-no") { state.pendingDelete = null; renderBoard(); }
    else if (btn.dataset.action === "delete-yes") deleteTask(id);
  });
  board.addEventListener("change", e => {
    if (e.target.dataset.action === "move") moveTask(e.target.dataset.id, e.target.value);
  });

  let dragId = null;
  board.addEventListener("dragstart", e => {
    const card = e.target.closest(".card");
    if (!card || !ID_RE.test(card.dataset.id)) return;
    dragId = card.dataset.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragId);
    card.classList.add("dragging");
  });
  board.addEventListener("dragend", () => {
    dragId = null;
    board.querySelectorAll(".dragging, .drop-target").forEach(el => el.classList.remove("dragging", "drop-target"));
  });
  board.addEventListener("dragover", e => {
    const col = e.target.closest(".column");
    if (!col || !dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    board.querySelectorAll(".drop-target").forEach(el => { if (el !== col) el.classList.remove("drop-target"); });
    col.classList.add("drop-target");
  });
  board.addEventListener("dragleave", e => {
    const col = e.target.closest(".column");
    if (col && !col.contains(e.relatedTarget)) col.classList.remove("drop-target");
  });
  board.addEventListener("drop", e => {
    const col = e.target.closest(".column");
    if (!col || !dragId) return;           // ignore drops that did not start from one of our cards
    e.preventDefault();
    const id = dragId;                     // never trust dataTransfer text from outside
    dragId = null;
    moveTask(id, col.dataset.status);
  });

  // Tabs (click + arrow-key roving focus)
  document.querySelector(".tabs").addEventListener("click", e => {
    const btn = e.target.closest("[data-tab]");
    if (btn) selectTab(btn.dataset.tab, false);
  });
  document.querySelector(".tabs").addEventListener("keydown", e => {
    const i = TABS.indexOf(state.tab);
    let n = null;
    if (e.key === "ArrowRight") n = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") n = (i + TABS.length - 1) % TABS.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = TABS.length - 1;
    if (n === null) return;
    e.preventDefault();
    selectTab(TABS[n], true);
  });
  window.addEventListener("hashchange", () => selectTab(location.hash.slice(1), false));

  // Filters (apply to all three views)
  const fProject = $("f-project"), fAssignee = $("f-assignee"), fPriority = $("f-priority");
  const onFilter = () => {
    state.filters = {
      project: PROJECTS.includes(fProject.value) ? fProject.value : "",
      assignee: clean(fAssignee.value, LIMITS.filter),
      priority: PRIORITIES.includes(fPriority.value) ? fPriority.value : ""
    };
    renderAll();
  };
  fProject.addEventListener("change", onFilter);
  fPriority.addEventListener("change", onFilter);
  fAssignee.addEventListener("input", onFilter);
  $("f-clear").addEventListener("click", () => {
    fProject.value = ""; fAssignee.value = ""; fPriority.value = "";
    onFilter();
  });

  // Modal + form
  $("open-add").addEventListener("click", openModal);
  $("close-add").addEventListener("click", closeModal);
  $("cancel-add").addEventListener("click", closeModal);
  $("modal").addEventListener("mousedown", e => { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", trapFocus);
  $("task-form").addEventListener("submit", handleSubmit);
  $("t-description").addEventListener("input", e => {
    $("count-description").textContent = e.target.value.length + " / " + LIMITS.description;
  });
}

/* ==================================================================
   11. INIT
   ================================================================== */
function init() {
  fillSelect($("f-project"), PROJECTS, "All projects");
  fillSelect($("f-priority"), PRIORITIES, "All priorities");
  fillSelect($("t-project"), PROJECTS);
  fillSelect($("t-category"), CATEGORIES);
  fillSelect($("t-priority"), PRIORITIES);
  fillSelect($("t-status"), STATUSES);
  state.tasks = seedTasks();
  initEvents();
  resetForm();
  renderAll();
  selectTab(location.hash.slice(1), false);
}
init();

})();
