# ComfyUI-SW-WanAnimate2 — SW 万相2 角色动画节点包

基于 ComfyUI 官方 **Wan-Animate-2** 模板（参考图定角色 + 驱动视频定动作），
把中间所有节点融合起来，并把「每段素材 + 提示词」做成 **LTX2.5 导演台那种「小节点 + 点开大面板」**
的素材输入节点 —— 画布上不再需要拖一堆 LoadVideo / LoadImage。

长视频自动分段循环，**输出时长 = 各段参考视频时长之和，15 秒以上无压力**。

## 三个节点

| 节点 | 类型名 | 用途 |
|---|---|---|
| **SW万相2·多段素材输入** | `SWWanAnimate2Segments` | 导演台面板：点「打开素材面板」在大面板里 ➕新增/上移/下移/复制/删除段位，逐段选 **参考视频 + 参考图** 并填 **角色描述 / 动作描述 / 参考时长**，可 1~12 段 |
| **SW万相2角色动画·多段合成** | `SWWanAnimate2MultiSeg` | 接整份「段位数据」，逐段生成后按顺序拼成一条视频（音频同步拼接） |
| **SW万相2角色动画·单段一体** | `SWWanAnimate2OneStop` | 同一份段位数据里只生成指定的第 N 段（单段快速试跑） |

## 接线方式

```
UNETLoader → LoraLoaderModelOnly ┐
CLIPLoader ──────────────────────┤
CLIPVisionLoader ────────────────┼──► 多段合成 ──► SaveVideo
VAELoader ───────────────────────┘        ▲
                                          │ segments（一根线）
                   多段素材输入（小节点）──┘
                   点「打开素材面板」→ 大面板里逐段选素材 + 填提示词
```

要点：

1. **素材和提示词全在面板里**，画布上的节点只有「N 段 · M 段完整 · 预计总时长」+ 一个按钮；
2. 面板里几段，后面「多段合成」就自动生成几段 —— 后面节点不用改任何参数；
3. **参考时长填 0 = 用该段参考视频全长**（默认，通常不用管；想截取就填秒数，卡片上可点「用这个时长」自动填）；
4. 每段的参考视频与参考图必须成对，缺一个会明确报错（"第 N 段缺参考视频/参考图"）。

## 面板怎么用

| 操作 | 位置 |
|---|---|
| 新增一段 | 面板顶部 **➕ 新增段位** |
| 调整顺序 / 复制 / 删除 | 每张卡片右上角 **上移 / 下移 / 复制 / 删除** |
| 选素材 | 卡片里 **参考视频** / **参考图** 的下拉框（列出 ComfyUI `input/` 目录下所有视频与图片） |
| 上传新素材 | 卡片里 **上传新视频 / 上传新图片**（写到 `input/sw_wan2_segments/`），或顶部 **批量上传视频 / 批量上传图片** |
| 清空全部 | 面板顶部 **清空** |

面板打开时会自动读取每段视频的**时长 / 帧率**并显示；预览图（视频首帧、参考图）直接内嵌显示。

可选：面板里的 **外部连线接口** 打开后，节点上会出现 `参考视频N / 参考图N` 接口，
可以从别的节点直接接线（适合驱动视频是上游节点算出来的场景）。

本机模型文件对应（秋叶整合包实测在盘）：

- diffusion_models: `wan_animate_2_distill_int8_convrot.safetensors`
- loras: `Wan21_I2V_14B_lightx2v_cfg_step_distill_lora_rank64.safetensors`
- text_encoders: `umt5_xxl_fp8_e4m3fn_scaled.safetensors`
- clip_vision: `clip_vision_h.safetensors`
- vae: `wan_2.1_vae.safetensors`

## 融合了哪些节点

CLIPTextEncode ×3 / CLIPVisionEncode ×2 / WanAnimate2Cache / ModelSamplingSD3(shift) /
BasicScheduler / KSamplerSelect / SamplerCustom / **WanAnimate2ToVideo（分段循环）** /
TrimVideoLatent / VAEDecode / CreateVideo，全部收进节点内部。

分段循环数学与官方模板一致：首段 81 帧，续段 `continue_motion` 回退 1 帧、
解码后丢 1 帧去重叠，段数 = `floor((F-2)/(b-1))+1`，最后按目标帧数精确裁尾。

## 数据是怎么存的

面板把整份段位数据序列化成 JSON，存进节点上一个**隐藏的** `素材数据` STRING 控件：

```json
{"version":2,"external":false,"segments":[
  {"id":"…","video":"dance.mp4","image":"ref.png",
   "char_prompt":"…","motion_prompt":"…","seconds":0,"duration":15.2,"fps":30}
]}
```

- 后端 `build()` 解析这份 JSON，用 `_safe_input_path()`（防目录穿越）在 `input/` 下找到文件，
  视频走 `VideoFromFile`、图片走 PIL，然后打包成 `SW_WAN_SEGMENTS` 输出；
- 所以工作流 JSON 里只需要存路径，**不依赖 LoadVideo / LoadImage 节点**。

## 文件结构

```
ComfyUI-SW-WanAnimate2/
├── __init__.py        注册节点 + WEB_DIRECTORY + 调用 register_routes()
├── nodes.py           三个节点的后端实现
├── api_routes.py      GET /sw_wan2/input_files（列 input 目录） + POST /sw_wan2/probe_video（读时长/帧率）
├── web/
│   └── sw_wan2_segments.js   小节点摘要 + <dialog> 大面板 + 事件委托 + 上传/探测
└── README.md
```

## 已验证

| 层 | 结果 |
|---|---|
| 面板 JSON → 段位打包 单测 | ✅ 真实 input 文件加载、秒→帧换算、成对校验、空段/缺文件报错（20/20） |
| 官方 `validate_prompt` | ✅ 通过 |
| 官方执行器 CPU 端到端真跑（重节点打桩） | ✅ 分段序列 `[(81,0,无续帧),(5,81,有续帧)]×3`、帧边界精确、成片 255 帧、音频按段顺序拼接 |
| 单段一体直调 | ✅ 只生成第 2 段 85 帧、音频取第 2 段、段索引越界报错 |
| **真实前端（Chromium 加载本机 ComfyUI）** | ✅ 小节点无端口、点按钮弹出大面板、下拉框列出 input 目录全部视频/图片、预览与提示词回填、➕/上移/删除生效、上传走真实文件选择 |
| 保存 → 重载持久化 | ✅ 面板改动序列化后重新加载完全保留，7 条连线完好，`widgets_values` 只有 1 个值 |

## 踩坑记录（改这个插件前必看）

1. **前端 `inputs` 数组顺序** = 「非控件端口在前（按声明顺序），控件输入在后（按 widget 顺序）」，
   手写工作流 JSON 时 `links[].target_slot` 必须按端口下标 0..N−1 排，否则线会接到控件上
   （离线校验器按名字映射，**不会报错**，只有真前端加载才暴露）。
2. **控件是否写进工作流 JSON 与是否进 API prompt 是两个开关**（前端源码 `serialiseWidgetValues` 确认）：
   - `widget.serialize === false` → 不写进 `widgets_values`
   - `widget.options.serialize === false` → 不进 API prompt

   `addDOMWidget(name, "div", root, { serialize: false })` 的第 4 个参数**只写进 options**，
   所以必须再显式补一句 `panel.serialize = false`，否则 `widgets_values` 里会多一个 `null`。
3. `<dialog>` 的 `close` 事件是**异步派发**的；节点被移除时 `destroy()` 会先把 `this.dialog` 置空，
   回调里再用 `this.dialog.removeAttribute(...)` 会 `TypeError`。要在回调里先取局部变量。
4. **本文件必须在 `web/` 顶层**（不能放 `web/js/`），否则相对路径 `import` 会 404 → 扩展静默不加载。
5. **看不到面板按钮**：`Ctrl+F5` 硬刷新浏览器（前端扩展被缓存了）；改了 `nodes.py` 需要**重启 ComfyUI**。
