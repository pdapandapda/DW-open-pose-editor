import os.path
import folder_paths
from nodes import LoadImage, interrupt_processing
import json
import time
import numpy as np
import torch
import cv2
import math
import random
from PIL import Image
from server import PromptServer
from aiohttp import web

# ====================================================================================================
# API 路由处理：暂停与恢复
# ====================================================================================================
PAUSED_NODES = {}

routes = PromptServer.instance.routes

class AnyType(str):
    """A special type that always compares equal to any value."""

    def __ne__(self, __value: object) -> bool:
        return False

any_type = AnyType("*")

@routes.post('/openpose/update_pose')
async def openpose_update_pose(request):
    try:
        json_data = await request.json()
        node_id = str(json_data.get('node_id')) # 强制转字符串
        pose_data = json_data.get('pose_data')

        if node_id in PAUSED_NODES:
            PAUSED_NODES[node_id] = {
                'status': 'resume',
                'data': pose_data
            }
            return web.json_response({"status": "success", "message": "Resuming execution"})
        else:
             return web.json_response({"status": "error", "message": "Node not paused"}, status=400)
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)

@routes.post('/openpose/cancel')
async def openpose_cancel(request):
    try:
        json_data = await request.json()
        node_id = str(json_data.get('node_id')) # 强制转字符串

        if node_id in PAUSED_NODES:
            PAUSED_NODES[node_id] = {
                'status': 'cancel'
            }
            return web.json_response({"status": "success", "message": "Cancelling execution"})
        else:
             return web.json_response({"status": "error", "message": "Node not paused"}, status=400)
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)

# ====================================================================================================
# 常量定义
# ====================================================================================================
# 扩展为支持 BODY_25 格式，增加双脚 6 条连线
LIMB_SEQ = [[2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [2, 9], [9, 10], [10, 11], [2, 12], [12, 13], [13, 14], [2, 1], [1, 15], [15, 17], [1, 16], [16, 18], [11, 25], [11, 23], [23, 24], [14, 22], [14, 20], [20, 21]]

# 扩展颜色数组至 25 个，为脚部节点分配对应的颜色
COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85], [0, 255, 255], [0, 255, 255], [0, 255, 255], [0, 0, 255], [0, 0, 255], [0, 0, 255], [255, 255, 255]]


# 【最终整合版】OpenPose Editor 节点
# ====================================================================================================
class OpenPoseEditor:
    _last_fingerprints = {}

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("STRING", { "default": "" }),
            },
            "optional": {
                "pose_image": ("IMAGE",),
                "pose_point": ("POSE_KEYPOINT",),
                "prev_image": ("IMAGE",),
                "bridge_anything": (any_type,),  # 改为IMAGE类型
                "output_width_for_dwpose": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 64}),
                "output_height_for_dwpose": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 64}),
                "scale_for_xinsr_for_dwpose": ("BOOLEAN", {"default": True}),
                "stop_for_edit": ("BOOLEAN", {"default": False, "label_on": "Pause for Edit", "label_off": "No Pause"}),
            },
            "hidden": {
                "backgroundImage": ("STRING", {"multiline": False}),
                "poses_datas": ("STRING", {"multiline": True, "rows": 10, "placeholder": "Pose JSON data will be stored here..."}),
                "unique_id": "UNIQUE_ID",
            }
        }

    # 【终极修复】IS_CHANGED：完全兼容所有参数，包含IMAGE类型的bridge_anything
    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        """
        兼容任意参数传入：
        - *args 接收位置参数
        - **kwargs 接收所有关键字参数
        彻底避免 "unexpected keyword argument" 警告
        """
        # 1. 提取核心参数（兼容任意传入方式）
        image = kwargs.get("image", args[0] if args else "")
        output_width_for_dwpose = kwargs.get("output_width_for_dwpose", 512)
        output_height_for_dwpose = kwargs.get("output_height_for_dwpose", 512)
        scale_for_xinsr_for_dwpose = kwargs.get("scale_for_xinsr_for_dwpose", True)
        stop_for_edit = kwargs.get("stop_for_edit", False)

        backgroundImage = kwargs.get("backgroundImage", "")
        poses_datas = kwargs.get("poses_datas", "")

        # 处理IMAGE类型参数的哈希（用内存地址+形状）
        def get_image_hash(img_tensor):
            if img_tensor is None:
                return 0
            try:
                # 组合内存地址+张量形状，确保唯一性
                return hash(f"{id(img_tensor)}_{str(img_tensor.shape)}")
            except:
                return hash(id(img_tensor))

        bridge_anything_hash = get_image_hash(kwargs.get("bridge_anything"))
        prev_image_hash = get_image_hash(kwargs.get("prev_image"))
        pose_image_hash = get_image_hash(kwargs.get("pose_image"))
        pose_hash = hash(str(kwargs.get("pose_point"))) if kwargs.get("pose_point") else 0

        # 2. 生成唯一指纹（强制节点每次执行，包含所有参数）
        timestamp = str(time.time() * 1000)
        random_str = str(random.randint(0, 999999))

        fingerprint = (
            f"{image}-{pose_hash}-{pose_image_hash}-{prev_image_hash}-{bridge_anything_hash}-"
            f"{output_width_for_dwpose}-{output_height_for_dwpose}-{scale_for_xinsr_for_dwpose}-{stop_for_edit}-"
            f"{timestamp}-{random_str}"
        )

        cls._last_fingerprints[fingerprint] = True
        return fingerprint

    # 输出定义
    RETURN_TYPES = ("IMAGE", "IMAGE","INT","INT",)
    RETURN_NAMES = ("dw_pose_image", "dw_comb_image","dw_pose_image_width","dw_pose_image_height")
    FUNCTION = "get_images"
    CATEGORY = "image"

    # POSE_KEYPOINT转JSON
    def pose_point_to_json(self, pose_point, image_tensor):
        import json
        if not pose_point or not isinstance(pose_point, (list, dict)):
            return ""

        # 获取当前图片在 ComfyUI 中的物理尺寸
        image_height = image_tensor.shape[1]
        image_width = image_tensor.shape[2]
        processed_people = []

        # 兼容性处理：DWPose 传过来的可能是列表，也可能是直接包含 people 的字典
        if isinstance(pose_point, dict):
            raw_blocks = [pose_point]
        else:
            raw_blocks = pose_point

        for result_dict in raw_blocks:
            # 兼容 DWPose 源码中的 people 字段
            people_in_dict = result_dict.get("people", [])
            for person in people_in_dict:
                new_person = {}

                # 字段映射表：{后端标准Key: [DWPose可能出现的各种Key]}
                mapping = {
                    "pose_keypoints_2d": ["pose_keypoints_2d", "body"],
                    "hand_left_keypoints_2d": ["hand_left_keypoints_2d", "hand_left", "left_hand"],
                    "hand_right_keypoints_2d": ["hand_right_keypoints_2d", "hand_right", "right_hand"],
                    "face_keypoints_2d": ["face_keypoints_2d", "face"]
                }

                for target_key, possible_keys in mapping.items():
                    raw_data = None
                    for k in possible_keys:
                        if k in person and person[k]:
                            raw_data = person[k]
                            break

                    if raw_data:
                        # 核心修复：智能判定是否需要缩放
                        # 如果第一个坐标点就大于 1，说明已经是像素坐标，不再乘 image_width
                        needs_scaling = False
                        if len(raw_data) >= 2:
                            if raw_data[0] > 0 and raw_data[0] <= 1.0 and raw_data[1] <= 1.0:
                                needs_scaling = True

                        clean_kps = []
                        for i in range(0, len(raw_data), 3):
                            x = raw_data[i]
                            y = raw_data[i+1]
                            conf = raw_data[i+2]

                            if needs_scaling:
                                x *= image_width
                                y *= image_height

                            clean_kps.extend([float(x), float(y), float(conf)])

                        new_person[target_key] = clean_kps

                if new_person:
                    processed_people.append(new_person)

        # 按照 DWPose 源码标准构造输出，包含 canvas_xxx 确保 JS 识别
        data_to_save = {
            "width": int(image_width),
            "height": int(image_height),
            "canvas_width": int(image_width),
            "canvas_height": int(image_height),
            "people": processed_people
        }
        return json.dumps(data_to_save, indent=4)

    # 渲染DWPose
    def render_dw_pose(self, pose_json, width, height, scale_for_xinsr):
        if not pose_json or not pose_json.strip():
            return np.zeros((height, width, 3), dtype=np.uint8)
        try:
            data = json.loads(pose_json)
        except Exception:
            return np.zeros((height, width, 3), dtype=np.uint8)

        target_w, target_h = width, height
        original_w, original_h = data.get('width', target_w), data.get('height', target_h)
        scale_x, scale_y = target_w / original_w, target_h / original_h

        canvas = np.zeros((target_h, target_w, 3), dtype=np.uint8)
        people = data.get('people', [])
        if not people:
            return canvas

        # 计算尺寸
        target_max_side = max(target_w, target_h)
        scale_factor = target_max_side / 512.0
        scaled_joint_radius = int(max(1, 2.0 * scale_factor))
        scaled_stickwidth = scaled_joint_radius

        if scale_for_xinsr:
            xinsr_stick_scale = 1 if target_max_side < 500 else min(2 + (target_max_side // 1000), 7)
            scaled_stickwidth *= xinsr_stick_scale

        for person in people:
# --- 1. 身体渲染 (Body) ---
            # 兼容：优先找 'body', 找不到找 'pose_keypoints_2d'
            body_flat = person.get('body', person.get('pose_keypoints_2d', []))
            if body_flat:
                # 🌟 深度修复 1：把第三个数字(body_flat[i+2])也存进 kps 里！
                kps = [ (int(body_flat[i] * scale_x), int(body_flat[i+1] * scale_y), body_flat[i+2]) if body_flat[i+2] > 0 else None for i in range(0, len(body_flat), 3) ]

                # 🌟 深度修复 2：创建排序列表
                lines_to_draw = []
                for limb_indices, color in zip(LIMB_SEQ, COLORS):
                    idx1, idx2 = limb_indices[0] - 1, limb_indices[1] - 1
                    if idx1 < len(kps) and idx2 < len(kps):
                        p1_full, p2_full = kps[idx1], kps[idx2]
                        if p1_full and p2_full:
                            # 提取 X, Y 和 深度 Z
                            p1, p2 = (p1_full[0], p1_full[1]), (p2_full[0], p2_full[1])
                            z1, z2 = p1_full[2], p2_full[2]
                            line_depth = (z1 + z2) / 2.0  # 计算这条线的平均层级

                            lines_to_draw.append({
                                'p1': p1, 'p2': p2,
                                'color': color,
                                'depth': line_depth
                            })

                # 🌟 深度修复 3：按深度排序，后画的覆盖前面的
                lines_to_draw.sort(key=lambda x: x['depth'])

                # 🌟 深度修复 4：保留原汁原味的高级纺锤形画法
                for line in lines_to_draw:
                    p1, p2, color = line['p1'], line['p2'], line['color']
                    Y, X = np.array([p1[0], p2[0]]), np.array([p1[1], p2[1]])
                    mX, mY = np.mean(X), np.mean(Y)
                    length = np.sqrt((X[0] - X[1])**2 + (Y[0] - Y[1])**2)
                    angle = math.degrees(math.atan2(X[0] - X[1], Y[0] - Y[1]))
                    polygon = cv2.ellipse2Poly((int(mY), int(mX)), (int(length / 2), scaled_stickwidth), int(angle), 0, 360, 1)
                    cv2.fillConvexPoly(canvas, polygon, [int(c * 0.6) for c in color])

                # 画关节圆点
                for i, kp in enumerate(kps):
                    if kp and i < len(COLORS):
                        # 因为现在 kp 里有 3 个值，必须只取前两个画圆
                        cv2.circle(canvas, (kp[0], kp[1]), scaled_joint_radius, COLORS[i], thickness=-1)

            # --- 2. 手部渲染 (Hands) ---
            hand_edges = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20]]
            # 兼容映射表：(前端短名, DWPose短名, 原始长名)
            for side, h_color in [('left', (0, 255, 255)), ('right', (0, 128, 255))]:
                # 按照优先级尝试获取：1.你前端的 'left_hand' | 2.DWPose的 'hand_left' | 3.标准的 'hand_left_keypoints_2d'
                h_flat = person.get(f'{side}_hand', person.get(f'hand_{side}', person.get(f'hand_{side}_keypoints_2d', [])))

                if h_flat and len(h_flat) >= 63:
                    h_kps = [ (int(h_flat[i] * scale_x), int(h_flat[i+1] * scale_y)) if h_flat[i+2] > 0 else None for i in range(0, len(h_flat), 3) ]
                    for e in hand_edges:
                        if e[0] < len(h_kps) and e[1] < len(h_kps):
                            p1, p2 = h_kps[e[0]], h_kps[e[1]]
                            if p1 and p2:
                                cv2.line(canvas, p1, p2, h_color, max(1, scaled_stickwidth // 2))
                    for kp in h_kps:
                        if kp: cv2.circle(canvas, kp, max(1, scaled_joint_radius // 2), (0, 0, 255), -1)

            # --- 3. 脸部渲染 (Face) ---
            # 兼容：优先找 'face', 找不到找 'face_keypoints_2d'
            f_flat = person.get('face', person.get('face_keypoints_2d', []))
            if f_flat and len(f_flat) >= 210:
                f_kps = [ (int(f_flat[i] * scale_x), int(f_flat[i+1] * scale_y)) if f_flat[i+2] > 0 else None for i in range(0, len(f_flat), 3) ]
                for kp in f_kps:
                    if kp: cv2.circle(canvas, kp, 1, (255, 255, 255), -1)

        return cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)

    # 主函数：处理bridge_anything（IMAGE类型）
    def get_images(self, image, output_width_for_dwpose, output_height_for_dwpose, scale_for_xinsr_for_dwpose,
                    backgroundImage, poses_datas, bridge_anything=None, prev_image=None, pose_image=None, pose_point=None,
                    stop_for_edit=False, unique_id=None):

        # 安全性检查：确保核心字符串参数不为 None
        if backgroundImage is None:
            backgroundImage = ""
        if poses_datas is None:
            poses_datas = ""

        # 清理缓存
        if hasattr(folder_paths, 'cache') and isinstance(folder_paths.cache, dict):
            folder_paths.cache.clear()

        # 处理bridge_anything（新增：保存为临时文件）
        if bridge_anything is not None and bridge_anything.shape[0] > 0:
            try:
                bridge_np = (bridge_anything[0].cpu().numpy() * 255).astype(np.uint8)
                bridge_pil = Image.fromarray(bridge_np)
                temp_dir = folder_paths.get_input_directory()
                bridge_filename = f"openpose_bridge_temp_{int(time.time() * 1000)}.png"
                bridge_filepath = os.path.join(temp_dir, bridge_filename)
                bridge_pil.save(bridge_filepath)
                # 可选择将bridge作为背景图使用
                # backgroundImage = bridge_filename
            except Exception as e:
                pass

        # 1. 转换pose_point为JSON
        converted_pose_json = ""
        if pose_point is not None and pose_image is not None:
            converted_pose_json = self.pose_point_to_json(pose_point, pose_image)
            if converted_pose_json:
                try:
                    pose_json = json.loads(converted_pose_json)
                    output_width_for_dwpose = pose_json.get("width", output_width_for_dwpose)
                    output_height_for_dwpose = pose_json.get("height", output_height_for_dwpose)
                except json.JSONDecodeError:
                    pass

        # 2. 保存pose_image为临时文件
        if pose_image is not None and pose_image.shape[0] > 0:
            try:
                pose_image_np = (pose_image[0].cpu().numpy() * 255).astype(np.uint8)
                pose_image_pil = Image.fromarray(pose_image_np)
                temp_dir = folder_paths.get_input_directory()
                bg_filename = f"openpose_lg_temp_{int(time.time() * 1000)}.png"
                bg_filepath = os.path.join(temp_dir, bg_filename)
                pose_image_pil.save(bg_filepath)
            except Exception as e:
                pass
        else:
            pass

        # 3. 保存prev_image为临时文件
        ld_filepath= None
        if prev_image is not None and prev_image.shape[0] > 0:
            try:
                prev_image_np = (prev_image[0].cpu().numpy() * 255).astype(np.uint8)
                prev_image_pil = Image.fromarray(prev_image_np)
                temp_dir = folder_paths.get_input_directory()
                ld_filename = f"openpose_ld_temp_{int(time.time() * 1000)}.png"
                ld_filepath = os.path.join(temp_dir, ld_filename)
                prev_image_pil.save(ld_filepath)
                backgroundImage = ld_filename
            except Exception as e:
                pass
        else:
            pass

        # 4. 更新poses_datas (关键修复：确保从输入连接获取的姿态数据被使用)
        if converted_pose_json:
            poses_datas = converted_pose_json

        # ============================================================
        # 暂停/断点逻辑 (Stop for Edit)
        # ============================================================
        if stop_for_edit and unique_id:
            node_str_id = str(unique_id) # 强制转字符串

            # 初始化暂停状态
            # 关键修复：将当前的 poses_datas (可能刚从输入连接更新) 放入状态中
            # 这样前端如果查询状态，或者后端需要知道当前数据
            PAUSED_NODES[node_str_id] = {'status': 'waiting', 'initial_data': poses_datas}

            # 发送暂停消息给前端
            # 关键修复：把最新的 pose 数据也发给前端，让前端有机会刷新编辑器
            # 同时发送最新的背景图片路径
            PromptServer.instance.send_sync("openpose_node_pause", {
                "node_id": node_str_id,
                "current_pose": poses_datas,  # 携带最新的姿态数据
                "current_background_image": backgroundImage # 携带最新的背景图片路径
            })

            # 阻塞循环
            while True:
                if node_str_id not in PAUSED_NODES:
                    # 异常情况，状态丢失
                    break

                state = PAUSED_NODES[node_str_id]
                status = state.get('status')

                if status == 'resume':
                    # 获取前端传回的新数据
                    new_pose_data = state.get('data')
                    if new_pose_data:
                        poses_datas = new_pose_data
                        # 尝试更新尺寸
                        try:
                            pd = json.loads(new_pose_data)
                            output_width_for_dwpose = pd.get("width", output_width_for_dwpose)
                            output_height_for_dwpose = pd.get("height", output_height_for_dwpose)
                        except:
                            pass
                    # 清理状态
                    del PAUSED_NODES[node_str_id]
                    break

                elif status == 'cancel':
                    del PAUSED_NODES[node_str_id]
                    # 使用 ComfyUI 推荐的方式中断执行
                    interrupt_processing()
                    return (torch.zeros(1, 512, 512, 3), {}, torch.zeros(1, 512, 512, 3)) # 返回空数据防止立即报错

                time.sleep(0.1)

        # --- 输出1: 纯DWPose渲染图 ---
        dw_pose_np = self.render_dw_pose(poses_datas, output_width_for_dwpose, output_height_for_dwpose, scale_for_xinsr_for_dwpose)
        dw_pose_image = torch.from_numpy(dw_pose_np.astype(np.float32) / 255.0).unsqueeze(0).clone()

        # 保存DWPose渲染图
        dw_bg_filename = ""
        try:
            dw_pose_image_pil = Image.fromarray(dw_pose_np)
            temp_dir = folder_paths.get_input_directory()
            dw_bg_filename = f"openpose_dw_bg_temp_{int(time.time() * 1000)}.png"
            dw_bg_filepath = os.path.join(temp_dir, dw_bg_filename)
            dw_pose_image_pil.save(dw_bg_filepath)
        except Exception as e:
            pass

        # --- 输出2: DWPose+背景合成图 ---
        dw_combined_image = dw_pose_image.clone()
        if backgroundImage and backgroundImage.strip() != "":
            bg_image_path = folder_paths.get_annotated_filepath(backgroundImage)
            if os.path.exists(bg_image_path):
                try:
                    bg_image_pil = Image.open(bg_image_path).convert("RGB")
                    bg_image_np = np.array(bg_image_pil)
                    bg_image_resized = cv2.resize(bg_image_np, (output_width_for_dwpose, output_height_for_dwpose), interpolation=cv2.INTER_AREA)

                    dw_pose_gray = cv2.cvtColor(dw_pose_np, cv2.COLOR_RGB2GRAY)
                    _, mask = cv2.threshold(dw_pose_gray, 1, 255, cv2.THRESH_BINARY)
                    dw_combined_np = bg_image_resized.copy()
                    dw_combined_np[mask != 0] = dw_pose_np[mask != 0]
                    dw_combined_image = torch.from_numpy(dw_combined_np.astype(np.float32) / 255.0).unsqueeze(0).clone()
                except Exception as e:
                    pass

        # 构建UI数据
        timestamp = str(time.time() * 1000)
        random_str = str(random.randint(0, 999999))
        ui_data = {
            "poses_datas": [poses_datas],
            "editdPose": [dw_bg_filename],
            "inputPose": [ld_filepath or ""],
            "backgroundImage": [backgroundImage],
            "refresh_trigger": [f"{timestamp}_{random_str}"],
            "dw_pose_shape": [list(dw_pose_image.shape)],
            "combined_shape": [list(dw_combined_image.shape)],
            "dw_pose_width": [output_width_for_dwpose],
            "dw_pose_height": [output_height_for_dwpose]
        }

        # 返回结果
        return {
            "ui": ui_data,
            "result": (dw_pose_image, dw_combined_image, output_width_for_dwpose, output_height_for_dwpose)
        }

# ====================================================================================================
# SavePoseToJson 节点
# ====================================================================================================
class SavePoseToJson:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pose_point": ("POSE_KEYPOINT",),      # 姿态关键点数据（包含canvas尺寸）
                "filename_prefix": ("STRING", {"default": "poses/pose"})  # 保存文件名前缀
            },
            "optional": {
                "pose_image": ("IMAGE",),  # 可选保存图片
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("filename",)
    FUNCTION = "save_json"
    OUTPUT_NODE = True
    CATEGORY = "image"

    def save_json(self, pose_point, filename_prefix="pose", pose_image=None):
        # ========== 核心修改：从pose_point获取canvas尺寸 ==========
        image_width = 512  # 默认值
        image_height = 512 # 默认值

        # 解析pose_point获取canvas尺寸
        if pose_point and isinstance(pose_point, list) and len(pose_point) > 0:
            # 取第一个元素（对应你的JSON数组中的第一个对象）
            first_pose_data = pose_point[0]
            if isinstance(first_pose_data, dict):
                # 从pose数据中读取canvas尺寸
                image_width = first_pose_data.get("canvas_width", 512)
                image_height = first_pose_data.get("canvas_height", 512)

        # ========== 处理姿态关键点数据 ==========
        processed_people = []
        if pose_point and isinstance(pose_point, list):
            for result_dict in pose_point:
                people_in_dict = result_dict.get("people", [])
                for person in people_in_dict:
                    original_keypoints = person.get("pose_keypoints_2d", [])
                    body_keypoints = [0.0] * len(original_keypoints)

                    for i in range(0, len(original_keypoints), 3):
                        x = original_keypoints[i]
                        y = original_keypoints[i + 1]
                        conf = original_keypoints[i + 2]

                        # --- 核心修复逻辑 ---
                        # 如果 x > 1，说明它已经是像素坐标了，直接使用
                        # 如果 x <= 1，说明它是相对坐标，才需要乘以宽度
                        if x <= 1.0 and x > 0:
                            x *= image_width
                        if y <= 1.0 and y > 0:
                            y *= image_height

                        body_keypoints[i] = float(x)
                        body_keypoints[i+1] = float(y)
                        body_keypoints[i+2] = float(conf)

                    processed_people.append({
                        "pose_keypoints_2d": body_keypoints
                    })

        # ========== 保存 JSON 文件 ==========
        # 构建要保存的数据（保留canvas尺寸信息）
        data_to_save = {
            "width": int(image_width),
            "height": int(image_height),
            "canvas_width": int(image_width),   # 兼容保留原字段
            "canvas_height": int(image_height), # 兼容保留原字段
            "people": processed_people
        }

        # 生成保存路径和文件名
        output_dir = folder_paths.get_output_directory()
        full_output_folder, filename, _, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, output_dir, image_width, image_height
        )

        # 确保保存文件夹存在
        os.makedirs(full_output_folder, exist_ok=True)

        # 处理文件计数器（避免重复）
        counter = 1
        try:
            existing_files = [f for f in os.listdir(full_output_folder)
                             if f.startswith(filename + "_") and f.endswith(".json")]
            if existing_files:
                max_counter = 0
                for f in existing_files:
                    try:
                        num_str = f[len(filename)+1:-5]  # 提取数字部分
                        num = int(num_str)
                        if num > max_counter:
                            max_counter = num
                    except ValueError:
                        continue
                counter = max_counter + 1
        except FileNotFoundError:
            pass

        # 保存文件（UTF-8编码，兼容中文）
        final_filename = f"{filename}_{counter:05d}.json"
        file_path = os.path.join(full_output_folder, final_filename)

        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(data_to_save, f, indent=4, ensure_ascii=False)

        result_filename = os.path.join(subfolder, final_filename) if subfolder else final_filename

        # ========== 保存图片文件 (新增功能) ==========
        if pose_image is not None:
            try:
                # 处理 batch 中的第一张图片
                img_tensor = pose_image[0]
                i = 255. * img_tensor.cpu().numpy()
                img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))

                image_filename = f"{filename}_{counter:05d}.png"
                image_file_path = os.path.join(full_output_folder, image_filename)

                img.save(image_file_path)
            except Exception as e:
                pass

        return {"ui": {"text": [result_filename]}, "result": (result_filename,)}


# ====================================================================================================
# 节点注册 + 修复TextConcatenator警告的全局方案
# ====================================================================================================
NODE_CLASS_MAPPINGS = {
    "Nui.OpenPoseEditor": OpenPoseEditor,
    "SavePoseToJson": SavePoseToJson
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Nui.OpenPoseEditor": "OpenPose Editor (DWPose By DocKr)",
    "SavePoseToJson": "Save Pose to JSON (from Keypoint)"
}

# 【关键】全局修复TextConcatenator的IS_CHANGED警告（一次性解决）
try:
    from nodes import TextConcatenator
    # 重写TextConcatenator的IS_CHANGED方法，兼容所有参数
    original_tc_is_changed = TextConcatenator.IS_CHANGED
    @classmethod
    def fixed_tc_is_changed(cls, *args, **kwargs):
        return original_tc_is_changed(cls, *args, **kwargs) if callable(original_tc_is_changed) else str(time.time())
    TextConcatenator.IS_CHANGED = fixed_tc_is_changed
except ImportError:
    pass
