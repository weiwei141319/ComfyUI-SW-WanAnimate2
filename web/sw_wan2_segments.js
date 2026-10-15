/**
 * SW 万相2 · 多段素材输入（SWWanAnimate2Segments）—— 导演台形态的前端面板
 *
 * 形态（对齐 LTX2.5 导演台）：
 *   · 画布上是一个小节点：只显示「N 段 · M 段完整 · 预计总时长」和「打开素材面板」按钮。
 *   · 点开后弹出大面板（<dialog>），所有素材输入都在面板里完成，画布上不再拖一堆
 *     LoadVideo / LoadImage。
 *   · 每段一张卡片：参考视频（决定动作与时长）+ 参考图（决定角色是谁）
 *     + 角色描述 + 动作描述 + 参考时长（秒）。
 *   · 面板顶部 ➕ 新增段位；卡片上 上移 / 下移 / 复制 / 删除。
 *
 * 数据：
 *   · 整份段位数据序列化成 JSON，存在「素材数据」这个隐藏 STRING 控件里。
 *   · 下游节点只看输出的一根 SW_WAN_SEGMENTS 线，自动确定段数。
 *
 * 素材来源：
 *   · 下拉框选 ComfyUI input 目录里已有的文件（走 /sw_wan2/input_files）；
 *   · 或直接上传（走 /upload/image，写到 input/sw_wan2_segments/）。
 *
 * 验证办法（F12 控制台）：
 *   [SW-Wan2Segments] 扩展已加载          ← 页面加载即有
 *   没有这一行 = 浏览器用了缓存旧页面 → Ctrl+F5 硬刷新。
 *
 * ⚠ 本文件必须在 web/ 顶层（不能放 web/js/），否则相对路径 import 会 404 → 扩展静默不加载。
 */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_NAME = "SWWanAnimate2Segments";
const DATA_WIDGET = "素材数据";
const MAX_SLOTS = 12;
const UPLOAD_SUBFOLDER = "sw_wan2_segments";
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB
const STYLE_ID = "sw-wan2-segments-style";
const PANEL_WIDGET = "sw_wan2_segments_panel";

// 全局只允许一个打开的面板。切换工作流/重载后旧实例的面板会被自动关闭，
// 防止"幽灵面板"拦截点击导致删除/修改看似无效。
const ACTIVE_DIALOG = { ui: null };

const LOG = (...args) => console.log("[SW-Wan2Segments]", ...args);

LOG("扩展已加载");

/* ------------------------------ 小工具 ------------------------------ */

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function viewURL(relative) {
  const parts = String(relative).replace(/\\/g, "/").split("/");
  const filename = parts.pop() ?? "";
  const params = new URLSearchParams({ filename, type: "input" });
  if (parts.length) params.set("subfolder", parts.join("/"));
  return api.apiURL(`/view?${params.toString()}`);
}

function normaliseState(raw) {
  const segments = Array.isArray(raw?.segments) ? raw.segments : [];
  return {
    version: 2,
    external: !!raw?.external,
    segments: segments.slice(0, MAX_SLOTS).map((segment) => ({
      id: String(segment?.id || uid()),
      video: String(segment?.video || ""),
      videoName: String(segment?.videoName || segment?.video || ""),
      image: String(segment?.image || ""),
      imageName: String(segment?.imageName || segment?.image || ""),
      char_prompt: String(segment?.char_prompt || ""),
      motion_prompt: String(segment?.motion_prompt || ""),
      seconds: Number(segment?.seconds || 0),
      duration: Number(segment?.duration || 0),
      fps: Number(segment?.fps || 0),
    })),
  };
}

function newSegment(patch = {}) {
  return {
    id: uid(),
    video: "",
    videoName: "",
    image: "",
    imageName: "",
    char_prompt: "",
    motion_prompt: "",
    seconds: 0,
    duration: 0,
    fps: 0,
    ...patch,
  };
}

function fmtSeconds(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return `${n.toFixed(2)}s`;
}

function chooseFiles(accept, multiple = false) {
  return new Promise((resolve) => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = accept;
    picker.multiple = multiple;
    picker.hidden = true;
    picker.onchange = () => resolve([...(picker.files || [])]);
    picker.oncancel = () => resolve([]);
    document.body.appendChild(picker);
    picker.click();
    setTimeout(() => picker.remove(), 120000);
  });
}

async function uploadFile(file) {
  if (!file || file.size <= 0) throw new Error("文件为空");
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("单个文件超过 1 GiB");
  const safeName = file.name.replace(/[^\w.()\-\u4e00-\u9fff]+/gu, "_");
  const serverName = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${safeName}`;
  const data = new FormData();
  data.append("image", file, serverName);
  data.append("type", "input");
  data.append("subfolder", UPLOAD_SUBFOLDER);
  data.append("overwrite", "true");
  const response = await api.fetchApi("/upload/image", { method: "POST", body: data });
  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    /* 忽略非 JSON 响应 */
  }
  if (!response.ok) throw new Error(payload?.error || `上传失败：HTTP ${response.status}`);
  return [payload?.subfolder, payload?.name].filter(Boolean).join("/");
}

async function probeVideo(relative) {
  if (!relative) return null;
  try {
    const response = await api.fetchApi("/sw_wan2/probe_video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: relative }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || data.error) return null;
    return data;
  } catch (error) {
    LOG("probe 失败:", error);
    return null;
  }
}

async function listInputFiles() {
  try {
    const response = await api.fetchApi("/sw_wan2/input_files");
    if (!response.ok) return { videos: [], images: [] };
    const data = await response.json();
    return { videos: data?.videos || [], images: data?.images || [] };
  } catch (error) {
    LOG("列目录失败:", error);
    return { videos: [], images: [] };
  }
}

function optionsHTML(items, selected) {
  const current = String(selected || "");
  const seen = new Set();
  let html = `<option value="">— 未选择 —</option>`;
  for (const item of items) {
    const value = String(item?.path || "");
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const label = String(item?.name || value);
    const extra = item?.path && item.path !== label ? `  (${item.path})` : "";
    html += `<option value="${escapeHTML(value)}"${value === current ? " selected" : ""}>${escapeHTML(label + extra)}</option>`;
  }
  // 值不在列表里（比如 input 目录被清理过）也保留，避免静默丢失
  if (current && !seen.has(current)) {
    html += `<option value="${escapeHTML(current)}" selected>${escapeHTML(current)}（缺失）</option>`;
  }
  return html;
}

/* ------------------------------ 面板 ------------------------------ */

class SWWan2DirectorUI {
  constructor(node, widget, root) {
    this.node = node;
    this.widget = widget;
    this.root = root;
    this.state = normaliseState(this.read());
    this.dialog = null;
    this.status = "就绪";
    this.busy = false;
    this.files = { videos: [], images: [] };
    this.renderNode();
  }

  read() {
    try {
      return JSON.parse(this.widget?.value || "{}");
    } catch (_) {
      return { version: 2, external: false, segments: [] };
    }
  }

  sync() {
    this.widget.value = JSON.stringify(this.state);
    this.widget.callback?.(this.widget.value);
    this.node.graph?.setDirtyCanvas?.(true, true);
    this.renderNode();
  }

  setStatus(text) {
    this.status = text;
    if (this.dialog?.open) {
      const target = this.dialog.querySelector(".sww2-status");
      if (target) target.textContent = text;
    }
    this.renderNode();
  }

  totals() {
    const segments = this.state.segments;
    const complete = segments.filter((s) => s.video && s.image).length;
    const seconds = segments.reduce((sum, s) => {
      const own = Number(s.seconds || 0);
      return sum + (own > 0 ? own : Number(s.duration || 0));
    }, 0);
    return { count: segments.length, complete, seconds };
  }

  /* ---------------------- 画布上的小节点 ---------------------- */

  renderNode() {
    const { count, complete, seconds } = this.totals();
    this.root.innerHTML = `
      <div class="sww2-node">
        <div class="sww2-node-title">SW 万相2 · 多段素材输入</div>
        <div class="sww2-node-summary">${count} 段 · ${complete} 段完整 · 预计总时长 ${seconds.toFixed(1)}s</div>
        <button class="sww2-button primary" data-action="open">打开素材面板</button>
        <div class="sww2-node-hint">${escapeHTML(this.status)}</div>
      </div>`;
    this.root.querySelector('[data-action="open"]')?.addEventListener("click", () => this.open());
  }

  /* ---------------------- 大面板 ---------------------- */

  async open() {
    if (ACTIVE_DIALOG.ui && ACTIVE_DIALOG.ui !== this) ACTIVE_DIALOG.ui.closeDialog();
    if (!this.dialog) {
      this.dialog = document.createElement("dialog");
      this.dialog.className = "sww2-modal";
      document.body.appendChild(this.dialog);
      this.dialog.addEventListener("close", () => {
        // 注意：节点被移除时 destroy() 会先把 this.dialog 置空，close 事件是异步派发的，
        // 所以这里不能直接用 this.dialog，否则会 TypeError。
        const dialog = this.dialog;
        if (dialog) dialog.removeAttribute("open");
        if (ACTIVE_DIALOG.ui === this) ACTIVE_DIALOG.ui = null;
      });
      // 事件委托：面板重渲染后无需重新绑定，避免删除/移动偶发失效
      this.dialog.addEventListener("click", (event) => this.onClick(event));
      this.dialog.addEventListener("input", (event) => this.onInput(event));
      this.dialog.addEventListener("change", (event) => this.onChange(event));
    }
    this.renderDialog();
    ACTIVE_DIALOG.ui = this;
    if (!this.dialog.open) this.dialog.showModal();

    this.setStatus("正在读取 input 目录…");
    this.files = await listInputFiles();
    this.setStatus(`input 目录：${this.files.videos.length} 个视频 / ${this.files.images.length} 张图片`);
    this.renderDialog();
    await this.probeMissing();
  }

  /** 打开面板时把还没读过时长的段补上（刚载入工作流时 duration 是 0）。 */
  async probeMissing() {
    const pending = this.state.segments.filter((s) => s.video && !(Number(s.duration) > 0));
    if (!pending.length) return;
    for (let i = 0; i < pending.length; i++) {
      const segment = pending[i];
      if (!this.dialog?.open) return;
      this.setStatus(`正在读取视频信息 ${i + 1}/${pending.length}：${segment.videoName}`);
      const info = await probeVideo(segment.video);
      if (info) {
        segment.duration = Number(info.duration || 0);
        segment.fps = Number(info.fps || 0);
      }
    }
    this.sync();
    this.renderDialog();
    this.setStatus(`已读取 ${pending.length} 段视频时长`);
  }

  closeDialog() {
    if (this.dialog?.open) this.dialog.close();
    if (ACTIVE_DIALOG.ui === this) ACTIVE_DIALOG.ui = null;
  }

  findSegment(target) {
    const card = target.closest?.("[data-segment-id]");
    if (!card) return null;
    const index = this.state.segments.findIndex((item) => item.id === card.dataset.segmentId);
    if (index < 0) return null;
    return { index, segment: this.state.segments[index] };
  }

  onClick(event) {
    const actionEl = event.target.closest?.("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === "close") return this.dialog.close();
    if (action === "add-segment") return this.addSegment();
    if (action === "batch-videos") return this.batchVideos();
    if (action === "batch-images") return this.batchImages();
    if (action === "clear-all") return this.clearAll();

    const found = this.findSegment(actionEl);
    if (!found) return;
    const { index, segment } = found;
    switch (action) {
      case "video": this.pickVideo(segment); break;
      case "image": this.pickImage(segment); break;
      case "clear-video":
        segment.video = ""; segment.videoName = ""; segment.duration = 0; segment.fps = 0;
        this.sync(); this.renderDialog();
        break;
      case "clear-image":
        segment.image = ""; segment.imageName = "";
        this.sync(); this.renderDialog();
        break;
      case "use-detected":
        if (segment.duration > 0) segment.seconds = Number(segment.duration.toFixed(2));
        this.sync(); this.renderDialog();
        break;
      case "up": this.move(index, -1); break;
      case "down": this.move(index, 1); break;
      case "duplicate":
        this.state.segments.splice(index + 1, 0, { ...segment, id: uid() });
        this.sync(); this.renderDialog();
        break;
      case "delete":
        this.state.segments.splice(index, 1);
        this.sync(); this.renderDialog();
        break;
      default: break;
    }
  }

  onInput(event) {
    const target = event.target;
    if (!target.matches?.("textarea")) return;
    const found = this.findSegment(target);
    if (!found) return;
    const role = target.dataset.role;
    if (role === "char") found.segment.char_prompt = target.value;
    else if (role === "motion") found.segment.motion_prompt = target.value;
    this.sync();
  }

  async onChange(event) {
    const target = event.target;
    if (!target.matches?.("[data-role]")) return;

    // 顶部：外部连线接口开关
    if (target.dataset.role === "external") {
      this.state.external = !!target.checked;
      this.sync();
      this.renderDialog();
      this.applyExternalSockets();
      return;
    }

    const found = this.findSegment(target);
    if (!found) return;
    const { segment } = found;

    if (target.dataset.role === "video-select") {
      const value = String(target.value || "");
      segment.video = value;
      segment.videoName = value ? value.split("/").pop() : "";
      segment.duration = 0;
      segment.fps = 0;
      this.sync();
      this.renderDialog();
      if (!value) {
        this.setStatus("已清除参考视频");
        return;
      }
      this.setStatus(`正在探测视频：${segment.videoName}`);
      const info = await probeVideo(value);
      if (info) {
        segment.duration = Number(info.duration || 0);
        segment.fps = Number(info.fps || 0);
        if (!(Number(segment.seconds) > 0)) segment.seconds = Number((info.duration || 0).toFixed(2));
        this.setStatus(`${segment.videoName}：${fmtSeconds(segment.duration)} · ${segment.fps.toFixed(2)} fps`);
      } else {
        this.setStatus(`${segment.videoName} 已选择（无法读取时长）`);
      }
      this.sync();
      this.renderDialog();
      return;
    }

    if (target.dataset.role === "image-select") {
      const value = String(target.value || "");
      segment.image = value;
      segment.imageName = value ? value.split("/").pop() : "";
      this.sync();
      this.renderDialog();
      return;
    }

    if (target.dataset.role === "seconds") {
      segment.seconds = Math.max(0, Number(target.value || 0));
      this.sync();
    }
  }

  /* ---------------------- 段位增删移 ---------------------- */

  addSegment() {
    if (this.state.segments.length >= MAX_SLOTS) {
      this.setStatus(`最多 ${MAX_SLOTS} 段`);
      return;
    }
    this.state.segments.push(newSegment());
    this.sync();
    this.renderDialog();
    this.applyExternalSockets();
  }

  move(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= this.state.segments.length) return;
    const [item] = this.state.segments.splice(index, 1);
    this.state.segments.splice(target, 0, item);
    this.sync();
    this.renderDialog();
  }

  clearAll() {
    this.state.segments = [];
    this.sync();
    this.renderDialog();
    this.applyExternalSockets();
    this.setStatus("已清空所有段位");
  }

  /* ---------------------- 素材选择 / 上传 ---------------------- */

  async pickVideo(segment) {
    const files = await chooseFiles("video/*,.mp4,.mov,.mkv,.webm,.avi,.m4v,.flv,.wmv,.gif");
    if (!files.length) return;
    const file = files[0];
    try {
      this.setStatus(`正在上传视频：${file.name}`);
      const stored = await uploadFile(file);
      segment.video = stored;
      segment.videoName = file.name;
      segment.duration = 0;
      segment.fps = 0;
      this.sync();
      this.renderDialog();
      const info = await probeVideo(stored);
      if (info) {
        segment.duration = Number(info.duration || 0);
        segment.fps = Number(info.fps || 0);
        if (!(Number(segment.seconds) > 0)) segment.seconds = Number((info.duration || 0).toFixed(2));
        this.setStatus(`${file.name}：${fmtSeconds(segment.duration)} · ${segment.fps.toFixed(2)} fps`);
      } else {
        this.setStatus(`${file.name} 已上传`);
      }
      this.sync();
      this.renderDialog();
    } catch (error) {
      LOG(error);
      this.setStatus(`失败：${error.message}`);
    }
  }

  async pickImage(segment) {
    const files = await chooseFiles("image/*");
    if (!files.length) return;
    const file = files[0];
    try {
      this.setStatus(`正在上传图片：${file.name}`);
      segment.image = await uploadFile(file);
      segment.imageName = file.name;
      this.sync();
      this.renderDialog();
      this.setStatus("参考图已更新");
    } catch (error) {
      LOG(error);
      this.setStatus(`失败：${error.message}`);
    }
  }

  async batchVideos() {
    if (this.busy) return;
    const files = await chooseFiles("video/*,.mp4,.mov,.mkv,.webm,.avi,.m4v,.flv,.wmv,.gif", true);
    if (!files.length) return;
    this.busy = true;
    try {
      let done = 0;
      for (const file of files) {
        if (this.state.segments.length >= MAX_SLOTS) {
          this.setStatus(`已达 ${MAX_SLOTS} 段上限，剩余文件未导入`);
          break;
        }
        this.setStatus(`正在上传视频 ${done + 1}/${files.length}：${file.name}`);
        const stored = await uploadFile(file);
        const info = await probeVideo(stored);
        const duration = Number(info?.duration || 0);
        this.state.segments.push(newSegment({
          video: stored,
          videoName: file.name,
          duration,
          fps: Number(info?.fps || 0),
          seconds: Number(duration.toFixed(2)),
        }));
        done += 1;
        this.sync();
        this.renderDialog();
      }
      this.setStatus(`已导入 ${done} 段视频`);
    } catch (error) {
      LOG(error);
      this.setStatus(`失败：${error.message}`);
    } finally {
      this.busy = false;
      this.applyExternalSockets();
    }
  }

  async batchImages() {
    if (this.busy) return;
    const files = await chooseFiles("image/*", true);
    if (!files.length) return;
    this.busy = true;
    try {
      // 依次填进还没有参考图的段；不够就新建段
      for (const file of files) {
        let target = this.state.segments.find((s) => !s.image);
        if (!target) {
          if (this.state.segments.length >= MAX_SLOTS) {
            this.setStatus(`已达 ${MAX_SLOTS} 段上限，剩余文件未导入`);
            break;
          }
          target = newSegment();
          this.state.segments.push(target);
        }
        this.setStatus(`正在上传图片：${file.name}`);
        target.image = await uploadFile(file);
        target.imageName = file.name;
        this.sync();
        this.renderDialog();
      }
      this.setStatus("图片导入完成");
    } catch (error) {
      LOG(error);
      this.setStatus(`失败：${error.message}`);
    } finally {
      this.busy = false;
    }
  }

  /* ---------------------- 外部连线接口（可选） ---------------------- */

  applyExternalSockets() {
    const node = this.node;
    if (!node?.inputs) return;
    const want = this.state.external ? segSlots(Math.max(1, this.state.segments.length)) : [];

    for (let idx = node.inputs.length - 1; idx >= 0; idx--) {
      const input = node.inputs[idx];
      if (!input || !SEG_INPUT_RE.test(input.name ?? "")) continue;
      if (want.includes(input.name)) continue;
      if (isSlotLinked(node, idx)) continue; // 已连线的保留，别把用户的线弄断
      try {
        node.removeInput(idx);
      } catch (error) {
        LOG("removeInput 失败:", input.name, error);
      }
    }

    if (this.state.external) {
      for (const name of want) {
        if (node.inputs.some((x) => x.name === name)) continue;
        try {
          node.addInput(name, slotType(name));
        } catch (error) {
          LOG("addInput 失败:", name, error);
        }
      }
    }

    reindexInputLinks(node);
    try {
      node.arrange?.();
    } catch (_) { /* 老版本无 arrange */ }
    node.setDirtyCanvas?.(true, true);
    app.canvas?.setDirtyCanvas?.(true, true);
  }

  /* ---------------------- 渲染 ---------------------- */

  renderDialog() {
    const cards = this.state.segments.map((segment, index) => this.cardHTML(segment, index)).join("");
    this.dialog.innerHTML = `
      <div class="sww2-head">
        <div class="sww2-brand">SW 万相2 · 多段素材输入</div>
        <button class="sww2-button primary" data-action="add-segment">➕ 新增段位</button>
        <button class="sww2-button" data-action="batch-videos">批量上传视频</button>
        <button class="sww2-button" data-action="batch-images">批量上传图片</button>
        <button class="sww2-button danger" data-action="clear-all">清空</button>
        <div class="sww2-spacer"></div>
        <div class="sww2-status">${escapeHTML(this.status)}</div>
        <button class="sww2-button" data-action="close">完成</button>
      </div>
      <div class="sww2-content">
        ${cards
          ? `<div class="sww2-list">${cards}</div>`
          : `<div class="sww2-empty"><div><b>还没有段位</b><br>点「➕ 新增段位」或「批量上传视频」，然后在每段卡片里选好<b>参考视频</b>和<b>参考图</b>，再填角色描述 / 动作描述 / 参考时长。</div></div>`}
      </div>`;
  }

  cardHTML(segment, index) {
    const missing = [];
    if (!segment.video) missing.push("参考视频");
    if (!segment.image) missing.push("参考图");
    if (!String(segment.char_prompt || "").trim()) missing.push("角色描述");
    if (!String(segment.motion_prompt || "").trim()) missing.push("动作描述");
    const stateText = missing.length ? `缺：${missing.join(" / ")}` : "已就绪";
    const stateClass = missing.length ? "warn" : "ok";

    const videoPreview = segment.video
      ? `<video src="${escapeHTML(viewURL(segment.video))}" muted preload="metadata" playsinline></video>`
      : `<div class="sww2-blank">未选择视频</div>`;

    const imagePreview = segment.image
      ? `<img src="${escapeHTML(viewURL(segment.image))}" alt="参考图">`
      : `<div class="sww2-blank">未选择图片</div>`;

    return `
      <section class="sww2-card" data-segment-id="${escapeHTML(segment.id)}">
        <div class="sww2-card-head">
          <span class="sww2-card-title">第 ${index + 1} 段</span>
          <span class="sww2-badge ${stateClass}">${escapeHTML(stateText)}</span>
          <div class="sww2-spacer"></div>
          <button class="sww2-button" data-action="up" ${index === 0 ? "disabled" : ""}>上移</button>
          <button class="sww2-button" data-action="down" ${index === this.state.segments.length - 1 ? "disabled" : ""}>下移</button>
          <button class="sww2-button" data-action="duplicate">复制</button>
          <button class="sww2-button danger" data-action="delete">删除</button>
        </div>

        <div class="sww2-col-media">
          <label>参考视频（决定动作 + 时长）</label>
          <div class="sww2-preview">${videoPreview}</div>
          <div class="sww2-filename" title="${escapeHTML(segment.videoName)}">${escapeHTML(segment.videoName || "未选择")}</div>
          <select data-role="video-select">${optionsHTML(this.files.videos, segment.video)}</select>
          <div class="sww2-row">
            <button class="sww2-button" data-action="video">上传新视频</button>
            <button class="sww2-button" data-action="clear-video" ${segment.video ? "" : "disabled"}>清除</button>
          </div>
          <div class="sww2-hint">
            检测到 ${fmtSeconds(segment.duration)}${segment.fps ? ` · ${segment.fps.toFixed(2)} fps` : ""}
            ${segment.duration > 0 ? `<button class="sww2-link" data-action="use-detected">用这个时长</button>` : ""}
          </div>
        </div>

        <div class="sww2-col-media">
          <label>参考图（决定角色是谁）</label>
          <div class="sww2-preview">${imagePreview}</div>
          <div class="sww2-filename" title="${escapeHTML(segment.imageName)}">${escapeHTML(segment.imageName || "未选择")}</div>
          <select data-role="image-select">${optionsHTML(this.files.images, segment.image)}</select>
          <div class="sww2-row">
            <button class="sww2-button" data-action="image">上传新图片</button>
            <button class="sww2-button" data-action="clear-image" ${segment.image ? "" : "disabled"}>清除</button>
          </div>
        </div>

        <div class="sww2-col-text">
          <label>角色描述（长什么样 + 在哪，不写动作）</label>
          <textarea data-role="char" placeholder="例：一个穿白色连衣裙的年轻女孩，长发及腰，站在阳光洒落的公园草地上">${escapeHTML(segment.char_prompt)}</textarea>
          <label>动作描述（驱动视频里的运动）</label>
          <textarea data-role="motion" placeholder="例：女孩随着音乐轻轻起舞，手臂自然摆动，身体随之旋转">${escapeHTML(segment.motion_prompt)}</textarea>
          <div class="sww2-seconds-row">
            <span>参考时长</span>
            <input class="sww2-seconds" data-role="seconds" type="number" min="0" max="1000" step="0.1" value="${Number(segment.seconds || 0)}">
            <span>秒（填 0 = 用该段参考视频全长）</span>
          </div>
        </div>
      </section>`;
  }

  reload() {
    this.state = normaliseState(this.read());
    this.renderNode();
    if (this.dialog?.open) this.renderDialog();
  }

  destroy() {
    this.closeDialog();
    if (this.dialog) {
      this.dialog.remove();
      this.dialog = null;
    }
  }
}

/* ------------------------------ 端口工具（外部连线用） ------------------------------ */

const SEG_INPUT_RE = /^(参考视频|参考图)(\d+)$/;

function segSlots(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(`参考视频${i}`, `参考图${i}`);
  return out;
}

function slotType(name) {
  return name.startsWith("参考视频") ? "VIDEO" : "IMAGE";
}

function isSlotLinked(node, slot) {
  try {
    if (typeof node.getInputLink === "function") return !!node.getInputLink(slot);
  } catch (_) { /* 走下面的兜底 */ }
  const input = node.inputs?.[slot];
  if (!input || input.link == null) return false;
  const links = node.graph?.links || app.graph?.links;
  return !!links?.[input.link];
}

function reindexInputLinks(node) {
  const links = node.graph?.links || app.graph?.links;
  if (!links || !Array.isArray(node.inputs)) return;
  node.inputs.forEach((input, slot) => {
    const id = input?.link;
    if (id == null) return;
    const link = links[id];
    if (link) link.target_slot = slot;
  });
}

/* ------------------------------ 样式 ------------------------------ */

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .sww2-node { box-sizing:border-box; width:100%; padding:9px; color:#172033; background:#f7f9fc;
      border:1px solid #cbd5e1; border-radius:8px; font:12px/1.45 "Segoe UI",Arial,sans-serif; }
    .sww2-node *,.sww2-modal * { box-sizing:border-box; }
    .sww2-node-title { font-weight:700; color:#12233f; margin-bottom:4px; }
    .sww2-node-summary { color:#526176; min-height:18px; margin-bottom:7px; }
    .sww2-node-hint { margin-top:6px; color:#7b8798; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .sww2-button { min-height:30px; padding:5px 10px; border:1px solid #b8c4d5; border-radius:6px;
      color:#20304a; background:#fff; cursor:pointer; font:12px "Segoe UI",Arial,sans-serif; }
    .sww2-button:hover { border-color:#3975d5; background:#f2f7ff; }
    .sww2-button:disabled { opacity:.45; cursor:not-allowed; }
    .sww2-button.primary { color:#fff; border-color:#275fb5; background:#2f6fcc; }
    .sww2-button.danger { color:#a72535; }
    .sww2-link { margin-left:6px; padding:0; border:0; background:none; color:#2f6fcc;
      cursor:pointer; text-decoration:underline; font:12px "Segoe UI",Arial,sans-serif; }
    .sww2-modal { width:min(1220px,96vw); height:min(880px,94vh); padding:0; border:1px solid #aebbd0;
      border-radius:12px; color:#172033; background:#f4f7fb; box-shadow:0 24px 90px #17203355;
      font:13px/1.45 "Segoe UI",Arial,sans-serif; }
    .sww2-modal::backdrop { background:#17203366; backdrop-filter:blur(2px); }
    .sww2-head { position:sticky; top:0; z-index:4; display:flex; align-items:center; gap:8px; padding:12px 14px;
      border-bottom:1px solid #cbd5e1; background:#fff; }
    .sww2-brand { font-size:17px; font-weight:750; color:#15345e; }
    .sww2-spacer { flex:1; }
    .sww2-status { color:#5c6a80; max-width:340px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .sww2-content { height:calc(100% - 58px); overflow:auto; padding:14px; }
    .sww2-empty { display:grid; place-items:center; min-height:320px; border:2px dashed #c5cfdd; border-radius:10px;
      color:#64748b; background:#fff; text-align:center; }
    .sww2-list { display:grid; gap:12px; }
    .sww2-card { display:grid; grid-template-columns:210px 210px minmax(320px,1fr); gap:12px; padding:12px;
      border:1px solid #cbd5e1; border-radius:10px; background:#fff; box-shadow:0 2px 10px #1720330d; }
    .sww2-card-head { grid-column:1/-1; display:flex; align-items:center; gap:8px; padding-bottom:8px; border-bottom:1px solid #e2e8f0; }
    .sww2-card-title { font-weight:700; color:#16355e; }
    .sww2-badge { padding:2px 8px; border-radius:10px; font-size:12px; font-weight:650; }
    .sww2-badge.ok { color:#12633f; background:#dcfce7; }
    .sww2-badge.warn { color:#8a4b0c; background:#fef3c7; }
    .sww2-col-media { display:flex; flex-direction:column; gap:6px; }
    .sww2-col-text { display:flex; flex-direction:column; gap:6px; }
    .sww2-col-media label,.sww2-col-text label { display:block; color:#4b5c73; font-weight:650; }
    .sww2-preview video,.sww2-preview img { width:100%; height:132px; object-fit:cover;
      border:1px solid #cad3e0; border-radius:7px; background:#0d1420; }
    .sww2-blank { display:grid; place-items:center; width:100%; height:132px; color:#94a3b8;
      border:1px dashed #cbd5e1; border-radius:7px; background:#f8fafc; font-size:12px; }
    .sww2-filename { color:#64748b; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .sww2-col-media select { width:100%; padding:6px; border:1px solid #b9c6d8; border-radius:6px; background:#fff; }
    .sww2-row { display:flex; gap:6px; }
    .sww2-hint { color:#708198; font-size:12px; }
    .sww2-col-text textarea { width:100%; min-height:74px; resize:vertical; padding:8px;
      border:1px solid #b9c6d8; border-radius:7px; outline:none; font:13px/1.5 "Segoe UI",Arial,sans-serif; }
    .sww2-col-text textarea:focus,.sww2-seconds:focus { border-color:#3975d5; box-shadow:0 0 0 2px #3975d522; }
    .sww2-seconds-row { display:flex; align-items:center; gap:7px; color:#5c6a80; }
    .sww2-seconds { width:84px; padding:6px; border:1px solid #b9c6d8; border-radius:6px; }
    @media (max-width:900px) { .sww2-card { grid-template-columns:1fr; } .sww2-card-head { grid-column:1; } }
  `;
  document.head.appendChild(style);
}

/* ------------------------------ 注册 ------------------------------ */

app.registerExtension({
  name: "SW.Wan2.SegmentDirector",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;
    installStyles();
    LOG("注册节点钩子:", NODE_NAME);

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = originalCreated?.apply(this, arguments);
      const node = this;
      const dataWidget = node.widgets?.find((widget) => widget.name === DATA_WIDGET);
      if (!dataWidget) return result;

      // 1) 隐藏承载 JSON 的原生文本框
      dataWidget.type = "hidden";
      dataWidget.computeSize = () => [0, -4];
      const hideNativeWidget = () => {
        const element = dataWidget.element || dataWidget.inputEl;
        if (!element) return;
        element.style.setProperty("display", "none", "important");
        element.style.setProperty("pointer-events", "none", "important");
        const host = element.closest?.(".dom-widget") || element.parentElement;
        if (host) {
          host.style.setProperty("display", "none", "important");
          host.style.setProperty("height", "0px", "important");
          host.style.setProperty("min-height", "0px", "important");
        }
      };
      hideNativeWidget();
      requestAnimationFrame(hideNativeWidget);

      // 2) 挂上 DOM 面板（小节点摘要 + 打开按钮）
      const root = document.createElement("div");
      const panel = node.addDOMWidget(PANEL_WIDGET, "div", root, {
        serialize: false,
        hideOnZoom: false,
      });
      // ⚠ 关键（前端源码 serialiseWidgetValues 确认）：
      //   · widget.serialize === false      -> 不写进 workflw JSON 的 widgets_values
      //   · widget.options.serialize = false -> 不进 API prompt
      // addDOMWidget 的第 4 个参数只写进 options，所以必须再显式设一次 widget.serialize。
      panel.serialize = false;
      if (!panel.options) panel.options = {};
      panel.options.serialize = false;
      panel.computeSize = (width) => [
        Math.max(260, (node.size?.[0] || width || 380) - 18),
        132,
      ];
      node.size = [
        Math.max(node.size?.[0] || 0, 380),
        Math.max(node.size?.[1] || 0, 236),
      ];

      node.__swWan2UI?.destroy?.();
      node.__swWan2UI = new SWWan2DirectorUI(node, dataWidget, root);

      // 3) 可选外部连线接口：默认隐藏未连线的口，保持节点小巧
      requestAnimationFrame(() => node.__swWan2UI?.applyExternalSockets());
      return result;
    };

    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = originalConfigure?.apply(this, arguments);
      const node = this;
      // configure 阶段连线还没恢复，放到下一帧再刷新
      requestAnimationFrame(() => {
        node.__swWan2UI?.reload();
        node.__swWan2UI?.applyExternalSockets();
      });
      return result;
    };

    const originalRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this.__swWan2UI?.destroy();
      this.__swWan2UI = null;
      return originalRemoved?.apply(this, arguments);
    };
  },
});
