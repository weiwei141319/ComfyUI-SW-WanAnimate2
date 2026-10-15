# -*- coding: utf-8 -*-
"""给「多段素材输入」面板用的两个小接口。

  GET /sw_wan2/input_files      列出 input 目录下的视频 / 图片（递归一层子目录也列出来）
  POST /sw_wan2/probe_video     返回某个视频的时长与帧率，方便面板显示「xx 秒 / xx 帧」

这两个接口只在前端面板里用，不影响节点执行。
"""

import os

from aiohttp import web

import folder_paths

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".wmv", ".gif", ".ts"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
MAX_WALK_FILES = 4000


def _relative_to_input(abs_path):
    root = os.path.abspath(folder_paths.get_input_directory())
    rel = os.path.relpath(os.path.abspath(abs_path), root)
    return rel.replace("\\", "/")


def _walk_input():
    root = os.path.abspath(folder_paths.get_input_directory())
    if not os.path.isdir(root):
        return []
    found = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.startswith("."):
                continue
            found.append(os.path.join(dirpath, name))
            if len(found) >= MAX_WALK_FILES:
                return found
    return found


def register_routes():
    """由 __init__.py 调用；重复调用也不会重复注册。"""
    try:
        from server import PromptServer
    except ImportError:
        return False

    routes = PromptServer.instance.routes

    @routes.get("/sw_wan2/input_files")
    async def list_input_files(request):
        videos, images = [], []
        for path in _walk_input():
            ext = os.path.splitext(path)[1].lower()
            try:
                size = os.path.getsize(path)
            except OSError:
                size = 0
            rel = _relative_to_input(path)
            if ext in VIDEO_EXTENSIONS:
                videos.append({"name": os.path.basename(path), "path": rel, "size": size})
            elif ext in IMAGE_EXTENSIONS:
                images.append({"name": os.path.basename(path), "path": rel, "size": size})

        def _sort_key(item):
            return item["name"].lower()

        videos.sort(key=_sort_key)
        images.sort(key=_sort_key)
        return web.json_response({"videos": videos, "images": images})

    @routes.post("/sw_wan2/probe_video")
    async def probe_video(request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        rel = str(payload.get("path") or "").strip()
        if not rel:
            return web.json_response({"error": "缺少 path"}, status=400)

        root = os.path.abspath(folder_paths.get_input_directory())
        candidate = os.path.abspath(os.path.join(root, rel.replace("\\", "/").lstrip("/")))
        if os.path.commonpath([root, candidate]) != root or not os.path.isfile(candidate):
            return web.json_response({"error": "找不到文件"}, status=404)

        duration, fps, width, height = 0.0, 0.0, 0, 0
        try:
            import av
            with av.open(candidate) as container:
                if container.duration is not None:
                    duration = float(container.duration / av.time_base)
                for stream in container.streams:
                    if stream.type == "video":
                        width = int(stream.width or 0)
                        height = int(stream.height or 0)
                        fps = float(stream.average_rate) if stream.average_rate else 0.0
                        if not duration and stream.frames and fps:
                            duration = float(stream.frames) / fps
                        break
        except Exception as exc:  # 探测失败不影响使用
            return web.json_response({"error": "无法读取视频信息：%s" % exc}, status=200)

        return web.json_response({
            "duration": duration,
            "fps": fps,
            "width": width,
            "height": height,
            "frames": int(round(duration * fps)) if duration and fps else 0,
        })
