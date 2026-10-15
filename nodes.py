# -*- coding: utf-8 -*-
"""
SW 万相2 角色动画节点包（ComfyUI-SW-WanAnimate2）

三个节点：

  SWWanAnimate2Segments  SW万相2·多段素材输入
        交互式段位编辑器：每段 = 参考视频 + 参考图 + 角色描述 + 动作描述 + 参考时长。
        节点上有「➕ 增加段位 / ➖ 减少段位」按钮，段位可 1 ~ 12 任意增减；
        输出一个整体（SW_WAN_SEGMENTS）喂给下面两个节点，
        下面两个节点会根据这里连了几段自动确定输入。

  SWWanAnimate2MultiSeg  SW万相2角色动画·多段合成
        接「段位数据」+ 模型四件套 + 分辨率 -> 逐段生成（段内自动 81 帧分段循环 + 续帧衔接）
        -> 全部按顺序拼成一条视频（音频同步拼接）。

  SWWanAnimate2OneStop   SW万相2角色动画·单段一体
        接同一份「段位数据」，只生成指定的那一段（快速试跑单段效果）。

融合内容包括：CLIPTextEncode x3 / CLIPVisionEncode x2 / WanAnimate2Cache /
ModelSamplingSD3 / BasicScheduler / KSamplerSelect / SamplerCustom /
WanAnimate2ToVideo（分段循环）/ TrimVideoLatent / VAEDecode / CreateVideo。
分段循环数学与官方模板一致：首段 81 帧，续段 offset 回退 1 帧、解码后丢 1 帧去重叠，
段数 = floor((F-2)/(b-1))+1，最后按目标帧数精确裁尾。
"""

import json
import os

import numpy as np
import torch
from PIL import Image, ImageOps

import comfy.utils
import comfy.samplers
import folder_paths
from comfy_api.input_impl.video_types import VideoFromFile

from comfy_extras.nodes_wan import WanAnimate2ToVideo, WanAnimate2Cache
from comfy_extras.nodes_custom_sampler import SamplerCustom, BasicScheduler, KSamplerSelect
from comfy_extras.nodes_model_advanced import ModelSamplingSD3
from comfy_extras.nodes_context_windows import ContextWindowsManualNode
from comfy_extras.nodes_video import CreateVideo
from nodes import CLIPTextEncode, CLIPVisionEncode, VAEDecode

NEGATIVE_DEFAULT = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，"
    "JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，"
    "手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)

MAX_SEED = 0xFFFFFFFFFFFFFFFF

SEG_SLOTS = 12          # 段位上限（与前端 sw_wan2_segments.js 的 MAX_SLOTS 保持一致）
SEGMENTS_TYPE = "SW_WAN_SEGMENTS"

SEG_DATA_VERSION = 2
DEFAULT_SEG_DATA = json.dumps({"version": SEG_DATA_VERSION, "external": False, "segments": []},
                              ensure_ascii=False)

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".wmv", ".gif", ".ts"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}


# ---------------------------------------------------------------- 基础工具

def _plan_segments(target_frames, fragment_length):
    """把目标帧数拆成若干段（每段 4n+1 帧；续段重叠 1 帧，净增 length-1 帧）。

    与官方模板 StartLoop 的数学一致：首段取 min(b, F) 向上取整到 4n+1，
    之后每段 min(b, 剩余+1) 再向上取整到 4n+1，直到覆盖目标帧数。
    """
    segs = []
    remaining = target_frames
    first = True
    while remaining > 0:
        if first:
            seg_len = min(fragment_length, target_frames)
            first = False
        else:
            seg_len = min(fragment_length, remaining + 1)
        seg_len = ((seg_len - 1 + 3) // 4) * 4 + 1
        segs.append(seg_len)
        remaining -= seg_len if len(segs) == 1 else (seg_len - 1)
    return segs


def _downscale_if_bigger(image, width, height):
    """仅当原图大于目标分辨率时，按 area/center 缩放（与 WanAnimate2ToVideo 内部一致）。"""
    h, w = image.shape[1], image.shape[2]
    if w >= width and h >= height:
        image = comfy.utils.common_upscale(image.movedim(-1, 1), width, height, "area", "center").movedim(1, -1)
    return image


def _seconds_to_frames(seconds, fps):
    """面板里填的是秒；0 = 用参考视频全长。"""
    seconds = float(seconds or 0.0)
    if seconds <= 0:
        return 0
    try:
        rate = float(fps)
    except (TypeError, ValueError):
        rate = 0.0
    if rate <= 0:
        rate = 16.0
    return max(1, int(round(seconds * rate)))


def _load_pose_frames(pose_video, width, height):
    """VIDEO -> (缩放后的帧张量, fps, audio)。分块缩放，尽快释放原始大张量。"""
    comps = pose_video.get_components()
    src = comps.images
    fps = comps.frame_rate
    audio = comps.audio
    total = int(src.shape[0])
    if total < 1:
        raise ValueError("驱动视频里没有帧，无法生成。")
    chunks = []
    step = 81
    for i in range(0, total, step):
        chunks.append(_downscale_if_bigger(src[i:i + step], width, height))
    frames = torch.cat(chunks, dim=0)
    del chunks, src, comps
    return frames, fps, audio


def _build_model_stack(model, shift, scheduler, steps, sampler_name,
                       cache_device, cache_dtype, use_context_windows):
    """模型栈，接线顺序与官方模板完全一致。"""
    m = model
    if use_context_windows:
        m = ContextWindowsManualNode.execute(
            model=m,
            context_length=21, context_overlap=8, context_schedule="standard_static",
            context_stride=1, closed_loop=False, fuse_method="pyramid", dim=2, freenoise=True,
            cond_retain_index_list=[0], split_conds_to_windows=False,
            latent_retain_index_list=[], causal_window_fix=True,
        )[0]
    m = WanAnimate2Cache.execute(m, cache_device, cache_dtype)[0]
    sigmas = BasicScheduler.execute(m, scheduler, steps, 1.0)[0]
    m = ModelSamplingSD3().patch(m, shift)[0]
    sampler = KSamplerSelect.execute(sampler_name)[0]
    return m, sigmas, sampler


def _generate_frames(clip, vae, clip_vision, stack, ref_image, pose_frames,
                     char_prompt, motion_prompt, negative_prompt,
                     width, height, max_frames, fragment_length, cfg, seed,
                     pose_strength, reference_image_strength,
                     pose_start_percent=0.0, pose_end_percent=1.0):
    """单段（可含内部分段循环）生成，返回裁齐后的 IMAGE 帧张量。"""
    m, sigmas, sampler = stack

    positive = CLIPTextEncode().encode(clip, char_prompt)[0]
    negative = CLIPTextEncode().encode(clip, negative_prompt)[0]
    pose_cond = CLIPTextEncode().encode(clip, motion_prompt)[0]

    ref_prepped = _downscale_if_bigger(ref_image[:1], width, height)
    cv_ref = CLIPVisionEncode().encode(clip_vision, ref_prepped, "none")[0]
    cv_pose = CLIPVisionEncode().encode(clip_vision, _downscale_if_bigger(pose_frames[:1], width, height), "none")[0]

    total = int(pose_frames.shape[0])
    target = total if max_frames <= 0 else int(max_frames)
    seg_lengths = _plan_segments(target, fragment_length)

    out_images = []
    offset = 0
    prev_images = None
    for k, seg_len in enumerate(seg_lengths):
        res = WanAnimate2ToVideo.execute(
            positive=positive, negative=negative, vae=vae,
            width=width, height=height, length=seg_len, batch_size=1,
            video_frame_offset=offset,
            reference_image=ref_prepped, pose_video=pose_frames,
            clip_vision_output=cv_ref, positive_pose=pose_cond,
            clip_vision_output_pose=cv_pose,
            continue_motion=prev_images,
            pose_strength=pose_strength,
            pose_start_percent=pose_start_percent, pose_end_percent=pose_end_percent,
            reference_image_strength=reference_image_strength,
        )
        pos_k, neg_k = res[0], res[1]
        latent_k = res[2]
        trim_latent, trim_image = int(res[3]), int(res[4])
        offset = int(res[5])

        sampled = SamplerCustom.execute(
            model=m, add_noise=True, noise_seed=(seed + k) & MAX_SEED,
            cfg=cfg, positive=pos_k, negative=neg_k,
            sampler=sampler, sigmas=sigmas, latent_image=latent_k,
        )[0]

        trimmed = sampled.copy()
        trimmed["samples"] = sampled["samples"][:, :, trim_latent:]
        del sampled, latent_k, res

        decoded = VAEDecode().decode(vae, trimmed)[0]
        del trimmed
        if k > 0 and trim_image > 0:
            decoded = decoded[trim_image:]
        out_images.append(decoded)
        prev_images = decoded

    frames = torch.cat(out_images, dim=0)
    del out_images
    if frames.shape[0] > target:
        frames = frames[:target]
    return frames


def _merge_audio(audios):
    """拼接多段音频；采样率/声道不一致时退化为保留第一段。"""
    audios = [a for a in audios if a is not None]
    if not audios:
        return None
    if len(audios) == 1:
        return audios[0]

    def _rate(a):
        return a.get("sample_rate", a.get("sampler_rate"))

    rate = _rate(audios[0])
    wf0 = audios[0]["waveform"]
    ok = all(_rate(a) == rate for a in audios)
    if ok and wf0.dim() >= 2:
        ok = all(a["waveform"].dim() >= 2 and a["waveform"].shape[1] == wf0.shape[1] for a in audios)
    if not ok:
        return audios[0]
    return {"waveform": torch.cat([a["waveform"] for a in audios], dim=-1), "sample_rate": int(rate)}


def _build_video(frames, fps, audio):
    return CreateVideo.execute(images=frames, fps=float(fps), audio=audio)[0]


def _extract_items(segments):
    """从「多段素材输入」的输出里取出段位列表（兼容裸列表写法）。"""
    if segments is None:
        raise ValueError("没有收到「段位数据」：请把「SW万相2·多段素材输入」节点的 segments 接到这里。")
    if isinstance(segments, dict):
        items = segments.get("items")
    elif isinstance(segments, (list, tuple)):
        items = list(segments)
    else:
        items = None
    if not items:
        raise ValueError("「段位数据」里没有任何段位：请在前面的「多段素材输入」节点上至少接一组「参考视频 + 参考图」。")
    return list(items)


# ---------------------------------------------------------------- 素材加载（面板用）

def _safe_input_path(relative_name, extensions):
    """把面板里存的相对路径解析成 input 目录下的真实文件（防目录穿越）。"""
    root = os.path.abspath(folder_paths.get_input_directory())
    normalized = str(relative_name or "").replace("\\", "/").lstrip("/")
    candidate = os.path.abspath(os.path.join(root, normalized))
    if os.path.commonpath([root, candidate]) != root:
        raise ValueError("素材路径必须位于 ComfyUI input 目录内：%s" % relative_name)
    if not os.path.isfile(candidate):
        raise FileNotFoundError("找不到素材文件：%s（请在 input 目录下存放素材，或重新上传）" % relative_name)
    ext = os.path.splitext(candidate)[1].lower()
    if extensions and ext not in extensions:
        raise ValueError("不支持的素材格式 %s：%s" % (ext, relative_name))
    return candidate


def _load_image_file(path):
    """PIL -> IMAGE 张量 (1,H,W,3)，自动处理 EXIF 旋转。"""
    with Image.open(path) as img:
        img.seek(0)
        image = ImageOps.exif_transpose(img).convert("RGB")
        array = np.asarray(image, dtype=np.float32) / 255.0
    return torch.from_numpy(np.ascontiguousarray(array)).unsqueeze(0)


def _load_video_file(path):
    """视频路径 -> VIDEO 对象（与官方 LoadVideo 一致）。"""
    return VideoFromFile(path)


def _parse_seg_data(value):
    """解析面板写回的 JSON 数据。"""
    if isinstance(value, (dict, list)):
        data = value
    else:
        try:
            data = json.loads(value or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError("素材数据不是有效 JSON：%s" % exc)
    if isinstance(data, list):          # 兼容直接给段位数组的写法
        data = {"version": SEG_DATA_VERSION, "external": False, "segments": data}
    if not isinstance(data, dict):
        raise ValueError("素材数据必须是 JSON 对象")
    segments = data.get("segments")
    if segments is None:
        segments = []
    if not isinstance(segments, list):
        raise ValueError("素材数据缺少 segments 数组")
    if len(segments) > SEG_SLOTS:
        raise ValueError("单次最多 %d 段，当前有 %d 段。" % (SEG_SLOTS, len(segments)))
    data["segments"] = segments
    return data


def _shared_kwargs(kwargs):
    return dict(
        model=kwargs["model"], clip=kwargs["clip"], vae=kwargs["vae"],
        clip_vision=kwargs["clip_vision"],
        negative_prompt=kwargs.get("negative_prompt", NEGATIVE_DEFAULT) or NEGATIVE_DEFAULT,
        width=int(kwargs.get("width", 482)), height=int(kwargs.get("height", 854)),
        fragment_length=int(kwargs.get("fragment_length", 81)),
        steps=int(kwargs.get("steps", 6)), cfg=float(kwargs.get("cfg", 1.0)),
        shift=float(kwargs.get("shift", 5.0)), seed=int(kwargs.get("seed", 0)),
        sampler_name=kwargs.get("sampler_name", "lcm"),
        scheduler=kwargs.get("scheduler", "simple"),
        pose_strength=float(kwargs.get("pose_strength", 1.0)),
        reference_image_strength=float(kwargs.get("reference_image_strength", 1.0)),
        cache_device=kwargs.get("cache_device", "cpu"),
        cache_dtype=kwargs.get("cache_dtype", "int8"),
        use_context_windows=bool(kwargs.get("use_context_windows", False)),
    )


# ---------------------------------------------------------------- 节点 1：多段素材输入

class SWWanAnimate2Segments:
    """段位编辑器（导演台形态）：节点上只有一个小面板，点「打开素材面板」在大面板里管理所有段位。

    每段 = 参考视频（决定动作与时长）+ 参考图（决定角色是谁）+ 角色描述 + 动作描述 + 参考时长（秒）。
    面板数据整体存在「素材数据」这个隐藏 JSON 控件里，下游节点只看输出的一根 segments 线。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "素材数据": ("STRING", {
                    "multiline": True, "default": DEFAULT_SEG_DATA, "dynamicPrompts": False,
                    "tooltip": "由节点上的「打开素材面板」自动维护，不建议手工编辑",
                }),
            },
        }

    RETURN_TYPES = (SEGMENTS_TYPE,)
    RETURN_NAMES = ("segments",)
    FUNCTION = "build"
    CATEGORY = "SW_万相2动画"
    DESCRIPTION = ("段位编辑器（导演台）：点节点上的「打开素材面板」，"
                   "在大面板里 ➕/➖ 增减段位，逐段选参考视频 + 参考图并填写角色描述 / 动作描述 / 参考时长；"
                   "输出整体段位数据给「多段合成」或「单段一体」节点。")

    def build(self, **kwargs):
        data = _parse_seg_data(kwargs.get("素材数据"))
        items = []
        for i, raw in enumerate(data["segments"], 1):
            raw = raw if isinstance(raw, dict) else {}
            video = kwargs.get("参考视频%d" % i)
            image = kwargs.get("参考图%d" % i)

            video_rel = str(raw.get("video") or "").strip()
            image_rel = str(raw.get("image") or "").strip()
            if video is None and video_rel:
                video = _load_video_file(_safe_input_path(video_rel, VIDEO_EXTENSIONS))
            if image is None and image_rel:
                image = _load_image_file(_safe_input_path(image_rel, IMAGE_EXTENSIONS))

            if video is None and image is None:
                raise ValueError("第 %d 段还没选素材：请点「打开素材面板」补上参考视频和参考图。" % i)
            if video is None:
                raise ValueError("第 %d 段缺参考视频：参考视频和参考图必须成对。" % i)
            if image is None:
                raise ValueError("第 %d 段缺参考图：参考视频和参考图必须成对。" % i)

            items.append({
                "index": i,
                "video": video,
                "image": image,
                "char_prompt": str(raw.get("char_prompt") or ""),
                "motion_prompt": str(raw.get("motion_prompt") or ""),
                "seconds": float(raw.get("seconds") or 0.0),
            })
        if not items:
            raise ValueError("还没有任何段位：请点「打开素材面板」新增一段并选好参考视频 + 参考图。")
        return ({"type": SEGMENTS_TYPE, "count": len(items), "items": items},)


# ---------------------------------------------------------------- 节点 2：多段合成

class SWWanAnimate2MultiSeg:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "clip_vision": ("CLIP_VISION",),
                "segments": (SEGMENTS_TYPE, {"tooltip": "接「SW万相2·多段素材输入」的输出；连了几段就生成几段"}),
                "negative_prompt": ("STRING", {"multiline": True, "default": NEGATIVE_DEFAULT,
                                               "tooltip": "负向词表，所有段共用"}),
                "width": ("INT", {"default": 482, "min": 16, "max": 8192, "step": 8}),
                "height": ("INT", {"default": 854, "min": 16, "max": 8192, "step": 8}),
                "fragment_length": ("INT", {"default": 81, "min": 17, "max": 81, "step": 4,
                                            "tooltip": "单段帧数，81 为模型上限；长视频自动分段循环"}),
                "steps": ("INT", {"default": 6, "min": 1, "max": 1000}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1}),
                "shift": ("FLOAT", {"default": 5.0, "min": 0.0, "max": 100.0, "step": 0.01}),
                "seed": ("INT", {"default": 0, "min": 0, "max": MAX_SEED, "control_after_generate": True,
                                 "tooltip": "第 k 段实际使用 seed+k"}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "lcm"}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "simple"}),
                "pose_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01}),
                "reference_image_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01}),
                "cache_device": (["gpu", "cpu"], {"default": "cpu", "tooltip": "姿态缓存位置，多段各占一个缓存槽，显存吃紧选 cpu"}),
                "cache_dtype": (["default", "int8", "int4"], {"default": "int8"}),
                "use_context_windows": ("BOOLEAN", {"default": False, "tooltip": "段内滑窗，默认关（同官方模板）"}),
            },
        }

    RETURN_TYPES = ("VIDEO", "INT")
    RETURN_NAMES = ("video", "frames")
    FUNCTION = "generate"
    CATEGORY = "SW_万相2动画"
    DESCRIPTION = ("多段合成：接「多段素材输入」的整份段位数据，逐段生成（段内自动 81 帧分段循环 + 续帧衔接），"
                   "再按顺序拼成一条视频，音频同步拼接。")

    def generate(self, **kwargs):
        items = _extract_items(kwargs.get("segments"))
        k = _shared_kwargs(kwargs)
        stack = _build_model_stack(k["model"], k["shift"], k["scheduler"], k["steps"],
                                   k["sampler_name"], k["cache_device"], k["cache_dtype"],
                                   k["use_context_windows"])

        seg_frames, seg_fps, seg_audio = [], [], []
        for idx, item in enumerate(items, start=1):
            pose_frames, fps, audio = _load_pose_frames(item["video"], k["width"], k["height"])
            frames = _generate_frames(k["clip"], k["vae"], k["clip_vision"], stack,
                                      item["image"], pose_frames,
                                      item["char_prompt"], item["motion_prompt"], k["negative_prompt"],
                                      k["width"], k["height"],
                                      _seconds_to_frames(float(item.get("seconds", 0.0) or 0.0), fps),
                                      k["fragment_length"],
                                      k["cfg"], (k["seed"] + idx) & MAX_SEED,
                                      k["pose_strength"], k["reference_image_strength"])
            del pose_frames
            seg_frames.append(frames)
            seg_fps.append(fps)
            seg_audio.append(audio)

        all_frames = torch.cat(seg_frames, dim=0)
        del seg_frames
        video = _build_video(all_frames, seg_fps[0], _merge_audio(seg_audio))
        return (video, int(all_frames.shape[0]))


# ---------------------------------------------------------------- 节点 3：单段一体（试跑指定段）

class SWWanAnimate2OneStop:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "clip_vision": ("CLIP_VISION",),
                "segments": (SEGMENTS_TYPE, {"tooltip": "接「SW万相2·多段素材输入」的输出，只生成下面指定的那一段"}),
                "段索引": ("INT", {"default": 1, "min": 1, "max": SEG_SLOTS, "step": 1,
                                   "tooltip": "要生成第几段（对应「多段素材输入」里的第 N 段）"}),
                "negative_prompt": ("STRING", {"multiline": True, "default": NEGATIVE_DEFAULT}),
                "width": ("INT", {"default": 482, "min": 16, "max": 8192, "step": 8}),
                "height": ("INT", {"default": 854, "min": 16, "max": 8192, "step": 8}),
                "fragment_length": ("INT", {"default": 81, "min": 17, "max": 81, "step": 4}),
                "steps": ("INT", {"default": 6, "min": 1, "max": 1000}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1}),
                "shift": ("FLOAT", {"default": 5.0, "min": 0.0, "max": 100.0, "step": 0.01}),
                "seed": ("INT", {"default": 0, "min": 0, "max": MAX_SEED, "control_after_generate": True}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "lcm"}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "simple"}),
                "pose_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01}),
                "reference_image_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01}),
                "cache_device": (["gpu", "cpu"], {"default": "gpu"}),
                "cache_dtype": (["default", "int8", "int4"], {"default": "int8"}),
                "use_context_windows": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "pose_start_percent": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "pose_end_percent": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
        }

    RETURN_TYPES = ("VIDEO", "INT")
    RETURN_NAMES = ("video", "frames")
    FUNCTION = "generate"
    CATEGORY = "SW_万相2动画"
    DESCRIPTION = ("单段一体：从「多段素材输入」的段位数据里挑一段生成（用于单段快速试跑），"
                   "内置 81 帧分段循环，输出时长 = 该段参考视频时长（或参考时长指定帧数）。")

    def generate(self, **kwargs):
        items = _extract_items(kwargs.get("segments"))
        want = int(kwargs.get("段索引", 1) or 1)
        if want < 1 or want > len(items):
            raise ValueError("段索引 = %d 越界：当前「多段素材输入」里只有 %d 段。" % (want, len(items)))
        item = items[want - 1]
        k = _shared_kwargs(kwargs)

        pose_frames, fps, audio = _load_pose_frames(item["video"], k["width"], k["height"])
        stack = _build_model_stack(k["model"], k["shift"], k["scheduler"], k["steps"],
                                   k["sampler_name"], k["cache_device"], k["cache_dtype"],
                                   k["use_context_windows"])
        frames = _generate_frames(k["clip"], k["vae"], k["clip_vision"], stack,
                                  item["image"], pose_frames,
                                  item["char_prompt"], item["motion_prompt"], k["negative_prompt"],
                                  k["width"], k["height"],
                                  _seconds_to_frames(float(item.get("seconds", 0.0) or 0.0), fps),
                                  k["fragment_length"],
                                  k["cfg"], k["seed"],
                                  k["pose_strength"], k["reference_image_strength"],
                                  float(kwargs.get("pose_start_percent", 0.0)),
                                  float(kwargs.get("pose_end_percent", 1.0)))
        video = _build_video(frames, fps, audio)
        return (video, int(frames.shape[0]))


NODE_CLASS_MAPPINGS = {
    "SWWanAnimate2Segments": SWWanAnimate2Segments,
    "SWWanAnimate2MultiSeg": SWWanAnimate2MultiSeg,
    "SWWanAnimate2OneStop": SWWanAnimate2OneStop,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SWWanAnimate2Segments": "SW万相2·多段素材输入",
    "SWWanAnimate2MultiSeg": "SW万相2角色动画·多段合成",
    "SWWanAnimate2OneStop": "SW万相2角色动画·单段一体",
}
