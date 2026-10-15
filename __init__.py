# -*- coding: utf-8 -*-
"""ComfyUI-SW-WanAnimate2 —— 万相2 (Wan-Animate-2) 角色动画节点包。

节点：
    SWWanAnimate2Segments  SW万相2·多段素材输入     导演台形态的小节点，点「打开素材面板」在大面板里
                                                    ➕/➖ 增减段位，逐段选参考视频 + 参考图并填写
                                                    角色描述 / 动作描述 / 参考时长（秒）
    SWWanAnimate2MultiSeg  SW万相2角色动画·多段合成  接整份段位数据，逐段生成后拼成一条视频（音频同步拼接）
    SWWanAnimate2OneStop   SW万相2角色动画·单段一体  从同一份段位数据里只生成指定的一段（单段试跑）

WEB_DIRECTORY 里的 sw_wan2_segments.js 负责面板 UI（DOM widget + <dialog> 大面板 + 素材上传/选择）。
api_routes.py 提供 /sw_wan2/input_files 与 /sw_wan2/probe_video 两个面板专用接口。
"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .api_routes import register_routes

WEB_DIRECTORY = "./web"

register_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
