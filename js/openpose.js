import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";
import "./fabric.min.js";

function dataURLToBlob(dataurl) {
    var arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1],
        bstr = atob(arr[1]), n = bstr.length, u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
}

// --- 核心修改 1：身体连线（增加脚部） ---
const connect_keypoints = [
    // 原本的 18 点身体主干连线
    [0, 1], [1, 2], [2, 3], [3, 4],
    [1, 5], [5, 6], [6, 7], [1, 8],
    [8, 9], [9, 10], [1, 11], [11, 12],
    [12, 13], [14, 0], [14, 16], [15, 0],
    [15, 17],
    
    // 🦶 新增：BODY_25 格式脚部连线
    // 假设右脚踝是 10，左脚踝是 13
    [10, 24], [10, 22], [22, 23], // 右脚: 脚踝连脚跟(24)和大脚趾(22)，大脚趾连小脚趾(23)
    [13, 21], [13, 19], [19, 20]  // 左脚: 脚踝连脚跟(21)和大脚趾(19)，大脚趾连小脚趾(20)
];

// 手部连接 (保持不变)
const hand_connections = [
    [0,1],[1,2],[2,3],[3,4], // 大拇指
    [0,5],[5,6],[6,7],[7,8], // 食指
    [0,9],[9,10],[10,11],[11,12], // 中指
    [0,13],[13,14],[14,15],[15,16], // 无名指
    [0,17],[17,18],[18,19],[19,20]  // 小拇指
];

// ⚠️ 注意：删除了 foot_connections，因为脚部已经合并到 connect_keypoints 里了！

// 面部连线 (保持不变)
const face_connections = [
    [0,16], [17,21], [22,26], [27,30], [31,35], [36,41], [42,47], [48,67]
];

// --- 核心修改 2：颜色扩充到 25 种 ---
const connect_color = [
    [0, 0, 255], [255, 0, 0], [255, 170, 0], [255, 255, 0],
    [255, 85, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0],
    [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255],
    [0, 85, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255],
    [255, 0, 170], [255, 0, 85],
    // 🦶 新增脚部的 7 根连线颜色
    [85, 255, 170], [170, 255, 85], [255, 255, 170], [170, 255, 255],
    [255, 170, 255], [85, 170, 255], [255, 85, 170]
];

// --- 核心修改 3：默认骨架加上 7 个脚部点 ---
const DEFAULT_KEYPOINTS = [
    // 原本的 18 个点
    [241, 77], [241, 120], [191, 118], [177, 183],
    [163, 252], [298, 118], [317, 182], [332, 245],
    [225, 241], [213, 359], [215, 454], [270, 240],
    [282, 360], [286, 456], [232, 59], [253, 60],
    [225, 70], [260, 72],
    // 🦶 新增的 7 个点 (占位坐标，形成默认的脚部形状)
    [282, 360], // 18 (占位，某些版本可能用作骨盆)
    [270, 480], // 19 左大脚趾
    [300, 480], // 20 左小脚趾
    [286, 470], // 21 左脚跟
    [200, 480], // 22 右大脚趾
    [230, 480], // 23 右小脚趾
    [215, 470]  // 24 右脚跟
];

async function readFileToText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async () => resolve(reader.result);
        reader.onerror = async () => reject(reader.error);
        reader.readAsText(file);
    });
}

async function loadImageAsync(imageURL) {
    return new Promise((resolve) => {
        const e = new Image();
        e.setAttribute('crossorigin', 'anonymous');
        e.addEventListener("load", () => { resolve(e); });
        e.src = imageURL;
        return e;
    });
}

async function canvasToBlob(canvas) {
    return new Promise(function (resolve) {
        canvas.toBlob(resolve);
    });
}

class OpenPosePanel {
    node = null;
    canvas = null;
    canvasElem = null;
    panel = null;

    undo_history = [];
    redo_history = [];

    visibleEyes = true;
    flipped = false;
    lockMode = false;

    // 用于缓存上次的pose数据，避免重复更新
    lastPoseData = null;
	getFusiformPoints(start, end) {
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const distance = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2));
    // 定义肢体厚度，通常为长度的 10%
    const width = distance * 0.1;

    return [
        { x: start.x, y: start.y },
        { x: start.x + width * Math.cos(angle + Math.PI / 2), y: start.y + width * Math.sin(angle + Math.PI / 2) },
        { x: end.x, y: end.y },
        { x: start.x + width * Math.cos(angle - Math.PI / 2), y: start.y + width * Math.sin(angle - Math.PI / 2) }
    ];
}

    deleteSelectedPoints() {
        const activeObjects = this.canvas.getActiveObjects();
        if (!activeObjects || activeObjects.length === 0) return;

        const objectsToDelete = new Set();
        const allPolygons = this.canvas.getObjects('polygon');

        activeObjects.forEach(obj => {
            if (obj.type !== 'circle') return;

            let connectionCount = 0;
            allPolygons.forEach(line => {
                if (line._poseId === obj._poseId && (line._startCircle === obj || line._endCircle === obj)) {
                    connectionCount++;
                }
            });

            if (connectionCount <= 1) {
                objectsToDelete.add(obj);
            }
        });

        if (objectsToDelete.size === 0) return;

        allPolygons.forEach(line => {
            if (objectsToDelete.has(line._startCircle) || objectsToDelete.has(line._endCircle)) {
                objectsToDelete.add(line);
            }
        });

        objectsToDelete.forEach(obj => this.canvas.remove(obj));

        this.canvas.discardActiveObject();
        this.canvas.renderAll();
        this.syncDimensionsToNode();
    }

    removeFilteredPose() {
        const filterIndex = parseInt(this.poseFilterInput.value, 10);

        const allCircles = this.canvas.getObjects('circle');
        const poseIds = [...new Set(allCircles.map(c => c._poseId))];
        poseIds.sort((a, b) => a - b);

        const objectsToRemove = new Set();

        if (filterIndex === -1) {
            this.canvas.getObjects().forEach(obj => objectsToRemove.add(obj));
            this.nextPoseId = 0;
        } else if (filterIndex >= 0 && filterIndex < poseIds.length) {
            const targetPoseId = poseIds[filterIndex];
            this.canvas.getObjects().forEach(obj => {
                if (obj._poseId === targetPoseId) {
                    objectsToRemove.add(obj);
                }
            });
        }

        if (objectsToRemove.size === 0) return;

        objectsToRemove.forEach(obj => this.canvas.remove(obj));
        this.poseFilterInput.value = "-1";
        this.applyPoseFilter(-1);
        this.canvas.renderAll();
        this.syncDimensionsToNode();
    }

    applyPoseFilter(filterIndex) {
        if (this.lockMode) return;

        const allCircles = this.canvas.getObjects('circle');
        const poseIds = [...new Set(allCircles.map(c => c._poseId))];
        poseIds.sort((a, b) => a - b);

        let targetPoseId = -1;
        if (filterIndex >= 0 && filterIndex < poseIds.length) {
            targetPoseId = poseIds[filterIndex];
        }

        this.canvas.getObjects().forEach(obj => {
            if (filterIndex === -1) {
                obj.set({
                    selectable: true,
                    evented: true
                });
            } else {
                if (obj._poseId === targetPoseId) {
                    obj.set({
                        selectable: true,
                        evented: true
                    });
                } else {
                    obj.set({
                        selectable: false,
                        evented: false
                    });
                }
            }
        });

        this.canvas.discardActiveObject();
        this.canvas.renderAll();
    }

    selectAll() {
        this.canvas.discardActiveObject();
        if (this.activeSelection) {
            this.activeSelection.forEach(obj => obj.set('stroke', obj.originalStroke));
        }

        const allCircles = this.canvas.getObjects('circle');
        if (allCircles.length > 0) {
            this.activeSelection = [...allCircles];
            this.activeSelection.forEach(obj => {
                obj.originalStroke = obj.stroke;
                obj.set('stroke', '#FFFF00');
            });
            this.canvas.renderAll();
        }
    }

    syncDimensionsToNode() {
        if (!this.node) return;

        const newWidth = Math.round(this.canvas.width);
        const newHeight = Math.round(this.canvas.height);

        this.node.setProperty("output_width_for_dwpose", newWidth);
        this.node.setProperty("output_height_for_dwpose", newHeight);

        const widthWidget = this.node.widgets?.find(w => w.name === "output_width_for_dwpose");
        if (widthWidget) {
            widthWidget.value = newWidth;
            if (widthWidget.callback) {
                widthWidget.callback(newWidth);
            }
            if (widthWidget.inputEl) {
                widthWidget.inputEl.value = newWidth;
            }
        }

        const heightWidget = this.node.widgets?.find(w => w.name === "output_height_for_dwpose");
        if (heightWidget) {
            heightWidget.value = newHeight;
            if (heightWidget.callback) {
                heightWidget.callback(newHeight);
            }
            if (heightWidget.inputEl) {
                heightWidget.inputEl.value = newHeight;
            }
        }

        this.node.setDirtyCanvas(true, true);
        if (app.graph) {
            app.graph.setDirtyCanvas(true, true);
        }
        if (app.canvas) {
            app.canvas.draw(true);
        }

        if (this.node.onPropertyChanged) {
            this.node.onPropertyChanged("output_width_for_dwpose", newWidth, this.node.properties.output_width_for_dwpose);
            this.node.onPropertyChanged("output_height_for_dwpose", newHeight, this.node.properties.output_height_for_dwpose);
        }
    }

    // 修改：从poses_datas属性加载pose数据（不再从输入连接获取）
    async loadFromPoseKeypoint() {
        try {
            // 1. 从节点的poses_datas属性获取数据
            let poseData = this.node.properties?.poses_datas;

            if (!poseData || poseData.trim() === "") {
                alert("未检测到有效的poses_datas数据，请先确保该属性有值！");
                return;
            }

            // 2. 数据格式标准化（处理字符串/对象两种格式）
            let poseJson = null;
            if (typeof poseData === "string") {
                poseJson = JSON.parse(poseData);
            } else if (Array.isArray(poseData) || typeof poseData === "object") {
                poseJson = poseData;
            }

            if (!poseJson) {
                alert("poses_datas数据格式错误！");
                return;
            }

            // 3. 生成数据指纹，避免重复更新
            const dataFingerprint = JSON.stringify(poseJson);
            if (this.lastPoseData === dataFingerprint) {
                alert("pose数据未变化，无需更新！");
                return;
            }
            this.lastPoseData = dataFingerprint;

            // 4. 解析pose数据并加载到画布

            // 提取canvas尺寸
            let canvasWidth = 512;
            let canvasHeight = 512;
            if (Array.isArray(poseJson) && poseJson[0]) {
                canvasWidth = poseJson[0].canvas_width || poseJson[0].width || 512;
                canvasHeight = poseJson[0].canvas_height || poseJson[0].height || 512;
            } else if (poseJson.width && poseJson.height) {
                canvasWidth = poseJson.width;
                canvasHeight = poseJson.height;
            }

            // 调整画布尺寸
            this.resizeCanvas(canvasWidth, canvasHeight);

            // 提取people数据
            let people = [];
            if (Array.isArray(poseJson) && poseJson[0]?.people) {
                people = poseJson[0].people;
            } else if (poseJson.people) {
                people = poseJson.people;
            }

            if (people.length > 0) {
                await this.setPose(people);
                this.saveToNode();
                this.syncDimensionsToNode();
            } else {
                alert("poses_datas中未找到有效的人体关键点信息！");
            }

        } catch (error) {
            alert(`加载pose数据失败：${error.message}`);
        }
    }

fixLimbs() {
        if (this.lockMode) return;

        // 1. 核心修复：仅处理身体部位的点，防止手部和面部的点 ID 混淆干扰！
        const allCircles = this.canvas.getObjects('circle').filter(c => c._type === 'body' || !c._type);
        const poses = {};
        allCircles.forEach(circle => {
            const poseId = circle._poseId;
            if (!poses[poseId]) poses[poseId] = [];
            poses[poseId].push(circle);
        });

        // 2. 核心修复：强解绝对坐标，防止在框选状态下点击“补全”导致新生成的点坐标飞到画布外
        const getAbsoluteCenter = (obj) => {
            if (obj.group) {
                const matrix = obj.group.calcTransformMatrix();
                return fabric.util.transformPoint(new fabric.Point(obj.left, obj.top), matrix);
            }
            return { x: obj.left, y: obj.top };
        };

        // COCO 18 关键点对称关系
        const symmetryPairs = [
            [2, 5], [3, 6], [4, 7],   // 手臂
            [8, 11], [9, 12], [10, 13], // 腿部
            [14, 15], [16, 17]        // 面部轮廓点
        ];

        // 骨骼延伸推测
        const limbExtensions = [
            [4, 3, 2], [7, 6, 5],   // 手腕
            [10, 9, 8], [13, 12, 11] // 脚踝
        ];

        Object.keys(poses).forEach(poseIdStr => {
            const poseId = parseInt(poseIdStr);
            const poseCircles = poses[poseId];
            const keypoints = new Array(18).fill(null);

            // 填充存在的身体点
            poseCircles.forEach(c => {
                if (c._id >= 0 && c._id < 18) {
                    keypoints[c._id] = c;
                }
            });

            // 添加缺失点的通用方法
            const addMissingPoint = (id, x, y) => {
                if (keypoints[id]) return; // 已存在则跳过

                const colorArr = connect_color[id] || [255, 255, 255];
                const circle = new fabric.Circle({
                    left: x, top: y, radius: 5,
                    fill: `rgb(${colorArr.join(",")})`,
                    stroke: `rgb(${colorArr.join(",")})`,
                    originX: 'center', originY: 'center',
                    hasControls: false, hasBorders: false,
                    _id: id,
                    _poseId: poseId,
                    _type: 'body', // 必须显式标记为身体节点，避免后续计算出错
                    selectable: true,
                    evented: true
                });

                this.canvas.add(circle);
                keypoints[id] = circle; // 存入数组供后续画线使用
            };

            // 策略 A: 对称补全
            const neck = keypoints[1];
            if (neck) {
                const neckPos = getAbsoluteCenter(neck);
                symmetryPairs.forEach(pair => {
                    const rightId = pair[0];
                    const leftId = pair[1];

                    const R = keypoints[rightId];
                    const L = keypoints[leftId];

                    if (L && !R) { // 有左没右，补右
                        const lPos = getAbsoluteCenter(L);
                        addMissingPoint(rightId, neckPos.x + (neckPos.x - lPos.x), lPos.y);
                    } else if (!L && R) { // 有右没左，补左
                        const rPos = getAbsoluteCenter(R);
                        addMissingPoint(leftId, neckPos.x + (neckPos.x - rPos.x), rPos.y);
                    }
                });
            }

            // 策略 B: 骨骼延伸
            limbExtensions.forEach(rule => {
                const [target, p1, p2] = rule;
                if (!keypoints[target] && keypoints[p1] && keypoints[p2]) {
                    const pos1 = getAbsoluteCenter(keypoints[p1]);
                    const pos2 = getAbsoluteCenter(keypoints[p2]);
                    const vX = pos1.x - pos2.x;
                    const vY = pos1.y - pos2.y;
                    addMissingPoint(target, pos1.x + vX, pos1.y + vY);
                }
            });
        });

        // 3. 重新生成连线 (仅针对 body)
        const existingPolygons = this.canvas.getObjects('polygon');

        Object.keys(poses).forEach(poseIdStr => {
            const poseId = parseInt(poseIdStr);
            // 只拿当前角色的 body 关键点，防止把手部点连进身体
            const bodyPoints = this.canvas.getObjects('circle').filter(c => c._poseId === poseId && (c._type === 'body' || !c._type));
            const pointMap = {};
            bodyPoints.forEach(p => pointMap[p._id] = p);

            connect_keypoints.forEach(pair => {
                const start = pointMap[pair[0]];
                const end = pointMap[pair[1]];

                if (start && end) {
                    const hasLine = existingPolygons.some(l =>
                        l._poseId === poseId &&
                        ((l._startCircle === start && l._endCircle === end) ||
                         (l._startCircle === end && l._endCircle === start))
                    );

                    if (!hasLine) {
                        const startPos = getAbsoluteCenter(start);
                        const endPos = getAbsoluteCenter(end);
                        const points = this.getFusiformPoints(startPos, endPos);

                        const colorArr = connect_color[pair[0]] || [255, 255, 255];
                        const polygon = new fabric.Polygon(points, {
                            fill: `rgba(${colorArr.join(",")}, 0.7)`,
                            strokeWidth: 0,
                            selectable: false,
                            evented: false,
                            lockMovementX: true,
                            lockMovementY: true,
                            lockRotation: true,
                            lockScalingX: true,
                            lockScalingY: true,
                            lockSkewingX: true,
                            lockSkewingY: true,
                            hasControls: false,
                            hasBorders: false,
                            originX: 'center',
                            originY: 'center',
                            _startCircle: start,
                            _endCircle: end,
                            _poseId: poseId,
                            _type: 'body'
                        });

                        this.canvas.add(polygon);

                        // 3. 核心修复：同步中心坐标使线完美居中贴合点
                        polygon._calcDimensions();
                        polygon.set({
                            left: polygon.pathOffset.x,
                            top: polygon.pathOffset.y
                        });
                        polygon.setCoords();

                        this.canvas.sendToBack(polygon); // 将连线放到圆点下层
                    }
                }
            });
        });

        this.canvas.requestRenderAll();
    }

    showPauseControls() {
        const pauseToolbar = this.pauseToolbar;
        if (!pauseToolbar) return;

        pauseToolbar.innerHTML = ""; // 清空
        pauseToolbar.style.display = "flex"; // 显示

        // 提示文本
        const statusText = document.createElement("span");
        statusText.innerText = "⚠️ 运行暂停中...";
        statusText.style.cssText = "color: #ffcc00; font-weight: bold; font-size: 12px; margin-right: 15px;";
        pauseToolbar.appendChild(statusText);

        // 继续按钮
        const btnContinue = document.createElement("button");
        btnContinue.innerText = "继续运行";
        btnContinue.title = "提交当前编辑并继续工作流";
        btnContinue.style.cssText = "background: #228be6; color: white; border: none; padding: 5px 15px; border-radius: 4px; cursor: pointer; font-weight: bold;";

        btnContinue.onclick = async () => {
            try {
                btnContinue.innerText = "提交中...";
                btnContinue.disabled = true;

                // 获取最新的姿态数据
                const poseData = this.serializeJSON();

                // 发送给后端
                await api.fetchApi("/openpose/update_pose", {
                    method: "POST",
                    body: JSON.stringify({ node_id: this.node.id, pose_data: poseData })
                });

                // 隐藏控制区并重置状态
                pauseToolbar.style.display = "none";
                this.node.is_paused = false;

                // 自动关闭编辑器窗口
                if (this.panel) {
                    this.panel.close();
                }
            } catch (e) {
                alert("提交失败: " + e.message);
                btnContinue.innerText = "重试";
                btnContinue.disabled = false;
            }
        };

        // 停止按钮
        const btnCancel = document.createElement("button");
        btnCancel.innerText = "终止";
        btnCancel.title = "取消当前工作流";
        btnCancel.style.cssText = "background: #fa5252; color: white; border: none; padding: 5px 15px; border-radius: 4px; cursor: pointer; font-weight: bold;";

        btnCancel.onclick = async () => {
            if(!confirm("确定要终止当前工作流吗？")) return;

            try {
                await api.fetchApi("/openpose/cancel", {
                    method: "POST",
                    body: JSON.stringify({ node_id: this.node.id })
                });
                // 隐藏控制区并重置状态
                pauseToolbar.style.display = "none";
                this.node.is_paused = false;

                // 自动关闭编辑器窗口
                if (this.panel) {
                    this.panel.close();
                }
            } catch (e) {
                alert("取消失败: " + e.message);
            }
        };

        pauseToolbar.appendChild(btnContinue);
        pauseToolbar.appendChild(btnCancel);
    }

    constructor(panel, node, initialData = {}) {
        this.panel = panel;
        this.node = node;
        this.nextPoseId = 0;

        // 存储初始状态，用于重置
        this.initialPoseData = null;
        this.initialBackgroundImage = null;

        this.panel.style.overflow = 'hidden';
        this.setPanelStyle();

        const rootHtml = `
                <canvas class="openpose-editor-canvas" />
                <div class="canvas-drag-overlay" />
                <input bind:this={fileInput} class="openpose-file-input" type="file" accept=".json" />
                <input class="openpose-bg-file-input" type="file" accept="image/jpeg,image/png,image/webp" />
        `;

        const container = this.panel.addHTML(rootHtml, "openpose-container");
        // 使用绝对定位布局，留出顶部 Header 和底部 Footer 的空间
        // 增加底部预留空间给两行按钮 (50px -> 90px)
        container.style.cssText = "position: absolute; top: 40px; bottom: 100px; left: 10px; right: 10px; overflow: hidden; display: flex; align-items: center; justify-content: center;";

        // 确保 footer 在底部且不遮挡内容
        this.panel.footer.style.position = "absolute";
        this.panel.footer.style.bottom = "0";
        this.panel.footer.style.left = "0";
        this.panel.footer.style.right = "0";
        this.panel.footer.style.height = "90px"; // 增加高度
        this.panel.footer.style.padding = "5px 10px";
        this.panel.footer.style.boxSizing = "border-box";
        this.panel.footer.style.overflow = "hidden";
        this.panel.footer.style.display = "flex";
        this.panel.footer.style.flexDirection = "column"; // 改为垂直排列
        this.panel.footer.style.justifyContent = "flex-end"; // 底部对齐
        this.panel.footer.style.gap = "5px";

        // 创建两个工具栏容器
        this.pauseToolbar = document.createElement("div");
        this.pauseToolbar.className = "pause-toolbar";
        this.pauseToolbar.style.cssText = "width: 100%; height: 40px; display: none; align-items: center; justify-content: center; gap: 10px; background: rgba(50, 50, 50, 0.5); border-radius: 4px;";

        this.mainToolbar = document.createElement("div");
        this.mainToolbar.className = "main-toolbar";
        this.mainToolbar.style.cssText = "width: 100%; height: 40px; display: flex; align-items: center; justify-content: space-between;";

        this.panel.footer.appendChild(this.pauseToolbar);
        this.panel.footer.appendChild(this.mainToolbar);

        container.style.pointerEvents = 'none';

        this.canvasWidth = this.node.properties.output_width_for_dwpose || 512;
        this.canvasHeight = this.node.properties.output_height_for_dwpose || 512;

        this.canvasElem = container.querySelector(".openpose-editor-canvas");
        this.canvasElem.width = this.canvasWidth;
        this.canvasElem.height = this.canvasHeight;
        this.canvasElem.style.cssText = "margin: 0.25rem; border-radius: 0.25rem; border: 0.5px solid;";

        this.canvas = this.initCanvas(this.canvasElem);
        this.canvas.wrapperEl.style.pointerEvents = 'auto';

        this.fileInput = container.querySelector(".openpose-file-input");
        this.fileInput.style.display = "none";
        this.fileInput.addEventListener("change", this.onLoad.bind(this));

        // 重新定义 addButton 方法，使其添加到 mainToolbar
        this.panel.addButton = (name, callback) => {
            const btn = document.createElement("button");
            btn.innerText = name;
            btn.onclick = callback;
            btn.style.cssText = "background: #222; color: #ddd; border: 1px solid #444; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 12px;";
            this.mainToolbar.appendChild(btn);
            return btn;
        };

this.panel.addButton("新增测试(含手)", () => {
            const pid = this.nextPoseId++;

            // 1. 生成身体
            const body = [];
            DEFAULT_KEYPOINTS.forEach(pt => body.push(pt[0], pt[1], 1.0));
            this.addPose(body, pid, "body");

            // 2. 强制生成一个左手 (在画布坐标 100, 100 位置)
            const mockHand = new Array(21 * 3).fill(0);
            for(let i=0; i<21; i++) {
                mockHand[i*3] = 100 + i;
                mockHand[i*3+1] = 100 + i;
                mockHand[i*3+2] = 1.0;
            }
            this.addPose(mockHand, pid, "left_hand"); // 强制传入 left_hand 类型

            this.saveToNode();
        });

        this.panel.addButton("删点", () => { this.deleteSelectedPoints(); this.saveToNode(); });
        this.panel.addButton("清空", () => { this.removeFilteredPose(); this.saveToNode(); });
        this.panel.addButton("重置", () => {
            if (this.initialPoseData) {
                this.loadJSON(this.initialPoseData);

                if (this.initialBackgroundImage) {
                    this.node.setProperty("backgroundImage", this.initialBackgroundImage);
                    // 重新加载背景图
                    const imageUrl = `/view?filename=${this.initialBackgroundImage}&type=input&t=${Date.now()}`;
                    fabric.Image.fromURL(imageUrl, (img) => {
                        if (!img || !img.width) return;
                        img.set({
                            scaleX: this.canvas.width / img.width,
                            scaleY: this.canvas.height / img.height,
                            opacity: 0.6,
                            selectable: false,
                            evented: false,
                        });
                        this.canvas.setBackgroundImage(img, this.canvas.renderAll.bind(this.canvas));
                    }, { crossOrigin: 'anonymous' });
                } else {
                    this.canvas.setBackgroundImage(null, this.canvas.renderAll.bind(this.canvas));
                    this.node.setProperty("backgroundImage", "");
                }

                this.saveToNode();
                this.syncDimensionsToNode();
            } else {
                // 如果没有初始状态，回退到原来的逻辑
                this.resetCanvas();
                this.node.setProperty("backgroundImage", "");

                const default_pose_keypoints_2d = [];
                DEFAULT_KEYPOINTS.forEach(pt => {
                    default_pose_keypoints_2d.push(pt[0], pt[1], 1.0);
                });
                const defaultPeople = [{ "pose_keypoints_2d": default_pose_keypoints_2d }];

                this.setPose(defaultPeople);

                this.saveToNode();
                this.syncDimensionsToNode();
            }
        });

        this.panel.addButton("保存", () => {
            this.save();
            this.syncDimensionsToNode();
        });
        this.panel.addButton("加载", () => this.load());
        this.panel.addButton("全选", () => {
            const selectableCircles = this.canvas.getObjects('circle').filter(obj => obj.selectable);

            if (selectableCircles.length > 0) {
                this.canvas.discardActiveObject();

                const selection = new fabric.ActiveSelection(selectableCircles, {
                    canvas: this.canvas,
                });
                this.canvas.setActiveObject(selection);

                this.canvas.fire('selection:created', { target: selection });

                this.canvas.renderAll();
            }
        });

        // 新增补全按钮
        this.panel.addButton("补全", () => {
            this.fixLimbs();
            this.saveToNode();
        });

        this.bgFileInput = container.querySelector(".openpose-bg-file-input");
        this.bgFileInput.style.display = "none";
        this.bgFileInput.addEventListener("change", (e) => this.loadBackgroundImage(e));
        this.panel.addButton("背景", () => this.bgFileInput.click());

        const setupDimensionInput = (label, value, callback) => {
            const lbl = document.createElement("label");
            lbl.innerHTML = label;
            lbl.style.cssText = "font-family: Arial; padding: 0 0.5rem; color: #ccc; display: none;"; // 隐藏 label
            const input = document.createElement("input");
            input.style.cssText = "background: #1c1c1c; color: #aaa; width: 60px; border: 1px solid #444; display: none;"; // 隐藏 input
            input.type = "number";
            input.min = "64";
            input.max = "4096";
            input.step = "64";
            input.value = value;
            input.addEventListener("change", (e) => {
                const newValue = parseInt(e.target.value);
                if (!isNaN(newValue)) {
                    callback(newValue);
                    this.syncDimensionsToNode();
                }
            });
            this.mainToolbar.appendChild(lbl);
            this.mainToolbar.appendChild(input);
            return input;
        };

        this.widthInput = setupDimensionInput("", this.canvasWidth, (value) => {
            this.resizeCanvas(value, this.canvasHeight);
            this.saveToNode();
        });
        this.heightInput = setupDimensionInput("", this.canvasHeight, (value) => {
            this.resizeCanvas(this.canvasWidth, value);
            this.saveToNode();
        });

        this.widthInput.addEventListener("input", (e) => {
            const val = parseInt(e.target.value);
            if (!isNaN(val) && val > 0) {
                this.canvasWidth = val;
                this.canvas.setWidth(val);
                this.canvas.renderAll();
            }
        });
        this.heightInput.addEventListener("input", (e) => {
            const val = parseInt(e.target.value);
            if (!isNaN(val) && val > 0) {
                this.canvasHeight = val;
                this.canvas.setHeight(val);
                this.canvas.renderAll();
            }
        });

        const lbl = document.createElement("label");
        lbl.innerHTML = "人物";
        lbl.style.cssText = "font-family: Arial; padding: 0 0.5rem; color: #ccc;";

        this.poseFilterInput = document.createElement("input");
        this.poseFilterInput.style.cssText = "background: #1c1c1c; color: #aaa; width: 60px; border: 1px solid #444;";
        this.poseFilterInput.type = "number";
        this.poseFilterInput.min = "-1";
        this.poseFilterInput.step = "1";
        this.poseFilterInput.value = this.node.properties.poseFilterIndex || "-1";

        this.poseFilterInput.addEventListener("input", () => {
            const filterValue = parseInt(this.poseFilterInput.value, 10);
            this.applyPoseFilter(filterValue);
            this.node.setProperty("poseFilterIndex", filterValue);
            this.syncDimensionsToNode();
        });

        this.mainToolbar.appendChild(lbl);
        this.mainToolbar.appendChild(this.poseFilterInput);

        setTimeout(() => {
            // 检查是否处于暂停状态，如果是则显示控制按钮
            if (this.node.is_paused) {
                this.showPauseControls();
            }

            const savedFilterIndex = this.node.properties.poseFilterIndex;
            if (savedFilterIndex !== undefined && savedFilterIndex !== null) {
                this.poseFilterInput.value = savedFilterIndex;
                this.applyPoseFilter(savedFilterIndex);
            }

            const bgImageFilename = this.node.properties.backgroundImage;
            if (bgImageFilename) {
                // 保存初始背景图设置
                this.initialBackgroundImage = bgImageFilename;

                const imageUrl = `/view?filename=${bgImageFilename}&type=input&t=${Date.now()}`;
                fabric.Image.fromURL(imageUrl, (img) => {
                    if (!img || !img.width) {
                        return;
                    }
                    img.set({
                        scaleX: this.canvas.width / img.width,
                        scaleY: this.canvas.height / img.height,
                        opacity: 0.6,
                        selectable: false,
                        evented: false,
                    });
                    this.canvas.setBackgroundImage(img, this.canvas.renderAll.bind(this.canvas));
                }, { crossOrigin: 'anonymous' });
            }

            if (this.node.properties.poses_datas && this.node.properties.poses_datas.trim() !== "") {
                // 保存初始姿态数据
                this.initialPoseData = this.node.properties.poses_datas;

                const error = this.loadJSON(this.node.properties.poses_datas);
                if (error) {
                    this.resizeCanvas(this.canvasWidth, this.canvasHeight);
                    this.setPose(DEFAULT_KEYPOINTS);
                }
            } else {
                this.resizeCanvas(this.canvasWidth, this.canvasHeight);

                const default_pose_keypoints_2d = [];
                DEFAULT_KEYPOINTS.forEach(pt => {
                    default_pose_keypoints_2d.push(pt[0], pt[1], 1.0);
                });
                const defaultPeople = [{ "pose_keypoints_2d": default_pose_keypoints_2d }];

                this.setPose(defaultPeople);
                this.syncDimensionsToNode();

                // 即使是默认姿态，也保存为初始状态
                this.initialPoseData = JSON.stringify({
                    width: this.canvasWidth,
                    height: this.canvasHeight,
                    people: defaultPeople
                });
            }
            // 移除自动检测定时器的启动代码
        }, 0);

        const keyHandler = this.onKeyDown.bind(this);
        document.addEventListener("keydown", this.onKeyDown.bind(this));
        this.panel.onClose = () => {
            document.removeEventListener("keydown", keyHandler);
            this.syncDimensionsToNode();
            // 移除定时器停止代码
        };
    }

    // 移除自动检测相关的定时器方法
    setPanelStyle() {
        this.panel.style.transform = `translate(-50%,-50%)`;
        this.panel.style.margin = `0px 0px`;
        // 再次强制确保层级最高
        this.panel.style.zIndex = "2147483647";
        this.panel.style.position = "fixed";
    }

    onKeyDown(e) {
        if (e.key === "z" && e.ctrlKey) {
            this.undo()
            e.preventDefault();
            e.stopImmediatePropagation();
        }
        else if (e.key === "y" && e.ctrlKey) {
            this.redo()
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }

    getFusiformPoints(start, end) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        let length = Math.sqrt(dx * dx + dy * dy);
        if (length === 0) length = 1; // 避免除零

        // 中点
        const midX = (start.x + end.x) / 2;
        const midY = (start.y + end.y) / 2;

        // 法向量 (Normalized): (-dy, dx)
        const nx = -dy / length;
        const ny = dx / length;

        // 设定纺锤体最大宽度
        // 可以是固定的，也可以根据长度动态调整（例如长度的 15%，但不超过 14px）
        const maxWidth = 14;
        // const calculatedWidth = Math.min(length * 0.15, maxWidth);
        const halfWidth = maxWidth / 2;

        // 生成四个顶点：起点 -> 侧边1 -> 终点 -> 侧边2
        return [
            { x: start.x, y: start.y },
            { x: midX + nx * halfWidth, y: midY + ny * halfWidth },
            { x: end.x, y: end.y },
            { x: midX - nx * halfWidth, y: midY - ny * halfWidth }
        ];
    }

addPose(keypoints = [], poseId = null, type = "body") {
    const currentPoseId = poseId !== null ? poseId : this.nextPoseId++;
    const circles = {};
    const lines = [];

    let connections = connect_keypoints;
    let baseColor = [255, 255, 255];
    let radius = 5;

    if (type === "left_hand") {
        connections = hand_connections;
        baseColor = [0, 255, 0];
        radius = 3.2; // 稍微调大，防止看不见
    } else if (type === "right_hand") {
        connections = hand_connections;
        baseColor = [255, 0, 0];
        radius = 3.2;
    } else if (type === "face") {
        connections = face_connections;
        baseColor = [255, 255, 255];
        radius = 1.5;
    }

    for (let i = 0; i < keypoints.length / 3; i++) {
        const x = Number(keypoints[i * 3]);
        const y = Number(keypoints[i * 3 + 1]);
        let confidence = Number(keypoints[i * 3 + 2]);

        // ==========================================
        // 🚨 终极钢铁防线：过滤所有形态的“僵尸数据” 🚨
        // ==========================================

        // 1. 拦截未检测点标记 (-1, -1) 或 (-1, -1, 0)
        // 只要 x 或 y 其中一个是 -1 (允许一定浮点误差)，直接抛弃！
        if (x <= 0 && y <= 0 && confidence === 1) {
            continue;
        }
        if (Math.abs(x + 1) < 0.1 || Math.abs(y + 1) < 0.1) {
            continue;
        }

        // 2. 拦截绝对的 (0,0) 原点标记 (应对面部数组后半段的 0,0,0)
        // 正常肢体绝对不会出现在距离原点不到 1 像素的地方
        if (Math.abs(x) < 1 && Math.abs(y) < 1) {
            continue;
        }

        // 3. 拦截 NaN 和低置信度 (应对极端噪点)
        if (isNaN(x) || isNaN(y) || (!isNaN(confidence) && confidence < 0.05)) {
            continue;
        }

        // ==========================================

        // 存活下来的点，给满置信度以保稳定
        confidence = 1.0;

        const colorArr = (type === "body" && connect_color[i]) ? connect_color[i] : baseColor;

        const circle = new fabric.Circle({
            left: x, top: y, radius: radius,
            fill: `rgb(${colorArr.join(",")})`,
            stroke: `rgb(${colorArr.join(",")})`,
            strokeWidth: 1,
            originX: 'center', originY: 'center',
            hasControls: false, hasBorders: false,
            _id: i,
            _poseId: currentPoseId,
            _type: type,
            selectable: true
        });

        circles[i] = circle;
    }

    connections.forEach((pair) => {
        const startCircle = circles[pair[0]];
        const endCircle = circles[pair[1]];
        
        // 自动断线保护：如果在上面的循环中某个废点被 continue 跳过了，
        // 这里自然找不到对应的圆点对象，直接 return (在 forEach 中等同于 continue)，
        // 从而完美阻止了飞向左上角的纺锤线生成。
        if (!startCircle || !endCircle) return;

        const points = this.getFusiformPoints(
            { x: startCircle.left, y: startCircle.top },
            { x: endCircle.left, y: endCircle.top }
        );

        const line = new fabric.Polygon(points, {
            fill: startCircle.fill.replace("rgb", "rgba").replace(")", ", 0.6)"),
            strokeWidth: 0,
            selectable: false,
            evented: false,
            originX: 'center',
            originY: 'center',
            _startCircle: startCircle,
            _endCircle: endCircle,
            _poseId: currentPoseId,
            _type: type // 标记连线的类型
        });
        lines.push(line);
    });

    // 核心修正：先加线，后加点，确保点在顶层
    if (lines.length > 0) this.canvas.add(...lines);
    const circleObjs = Object.values(circles);
    if (circleObjs.length > 0) {
        this.canvas.add(...circleObjs);
        // 强制所有点同步物理坐标并置顶
        circleObjs.forEach(c => {
            c.setCoords();
            c.bringToFront();
        });
    }

    return new Promise(resolve => {
        requestAnimationFrame(() => {
            this.canvas.requestRenderAll();
            resolve();
        });
    });
}
async setPose(people) {
    if (!people || people.length === 0) return;

    const tempBackgroundImage = this.canvas.backgroundImage;

    // 1. 停止所有正在进行的渲染，防止移动时的冲突
    this.canvas.discardActiveObject();
    this.canvas.clear();

    this.canvas.backgroundImage = tempBackgroundImage;
    this.canvas.backgroundColor = "#000";
    this.nextPoseId = 0;

    // 2. 使用快照防止异步数据漂移
    const peopleData = JSON.parse(JSON.stringify(people));
    const posePromises = [];

    peopleData.forEach(person => {
        const pid = this.nextPoseId++;

        // 身体
        const bodyData = person.body || person.pose_keypoints_2d || [];
        posePromises.push(this.addPose(bodyData, pid, "body"));

        // 左手
        const leftHandData = person.left_hand || person.hand_left_keypoints_2d;
        if (leftHandData && leftHandData.length > 0) {
            posePromises.push(this.addPose(leftHandData, pid, "left_hand"));
        }

        // 右手
        const rightHandData = person.right_hand || person.hand_right_keypoints_2d;
        if (rightHandData && rightHandData.length > 0) {
            posePromises.push(this.addPose(rightHandData, pid, "right_hand"));
        }

        // 脸部
        const faceData = person.face || person.face_keypoints_2d;
        if (faceData && faceData.length > 0) {
            posePromises.push(this.addPose(faceData, pid, "face"));
        }
    });

    await Promise.all(posePromises);

    // 3. 优化锁定逻辑：增加对手部的单独层级管理
    this.canvas.getObjects().forEach(obj => {
        if (obj.type === 'polygon') {
            obj.set({
                selectable: false,
                evented: false,
                lockMovementX: true,
                lockMovementY: true,
                hasControls: false
            });
        }
        // 关键：确保点位坐标在 Fabric 内部同步
        obj.setCoords();
    });

    this.canvas.requestRenderAll();

    // 🚨 极其关键：只有当数据真正发生改变且不是在“拖拽中”才保存
    if (!this.canvas._isDragging) {
        this.saveToNode();
    }
}
    calcResolution(width, height) {
        const viewportWidth = window.innerWidth / 2.25;
        const viewportHeight = window.innerHeight * 0.75;
        const ratio = Math.min(viewportWidth / width, viewportHeight / height);
        return { width: width * ratio, height: height * ratio }
    }

    resizeCanvas(width, height) {

        if (width != null && height != null) {
            this.canvasWidth = width;
            this.canvasHeight = height;

            this.widthInput.value = `${width}`
            this.heightInput.value = `${height}`

            this.canvas.setWidth(width);
            this.canvas.setHeight(height);
        }

        const rectPanel = this.canvasElem.closest('.openpose-container').getBoundingClientRect();

        if (rectPanel.width == 0 && rectPanel.height == 0) {
            setTimeout(() => {
                this.resizeCanvas();
            }, 100)
            return;
        }

        // 重新实现缩放逻辑：始终使用 CSS transform 来缩放，保持 Canvas 内部分辨率不变
        const availableWidth = rectPanel.width;
        const availableHeight = rectPanel.height;

        // 计算缩放比例，留出一点 padding
        const padding = 20; // 增加一点 padding
        const scaleX = (availableWidth - padding) / this.canvasWidth;
        const scaleY = (availableHeight - padding) / this.canvasHeight;

        // 保持宽高比，移除 1.0 限制，允许无限放大以填满窗口
        const scale = Math.min(scaleX, scaleY);

        // 获取 Fabric Wrapper 元素 (通常是 canvasElem 的父元素)
        // 更加严谨的获取方式
        const wrapperEl = this.canvas.wrapperEl || this.canvasElem.parentElement;

        if (wrapperEl) {
            // 必须重置 wrapper 的尺寸，否则它会占据实际像素空间，导致 flex 居中失效或撑开容器
            // 但 fabricjs 需要 wrapper 尺寸正确以处理事件...
            // 技巧：wrapper 设为 absolute center，然后 transform

            wrapperEl.style.position = "absolute";
            wrapperEl.style.left = "50%";
            wrapperEl.style.top = "50%";
            wrapperEl.style.width = `${this.canvasWidth}px`;
            wrapperEl.style.height = `${this.canvasHeight}px`;
            // 使用 translate(-50%, -50%) 实现绝对居中，再叠加 scale
            wrapperEl.style.transform = `translate(-50%, -50%) scale(${scale})`;
            wrapperEl.style.transformOrigin = "center center"; // 其实 translate 后 origin 无所谓了，但保持一致

            // 确保内部 canvas 也是 100% 填充 wrapper
            this.canvasElem.style.width = "100%";
            this.canvasElem.style.height = "100%";
            // 上层 canvas (fabric 用于交互的层)
            if (this.canvas.upperCanvasEl) {
                this.canvas.upperCanvasEl.style.width = "100%";
                this.canvas.upperCanvasEl.style.height = "100%";
            }
        }
    }

    undo() {
        if (this.undo_history.length > 0) {
            this.lockMode = true;
            if (this.undo_history.length > 1)
                this.redo_history.push(this.undo_history.pop());
            const content = this.undo_history[this.undo_history.length - 1];
            this.canvas.loadFromJSON(content, () => {
                this.canvas.renderAll();
                this.lockMode = false;
            });
        }
    }

    redo() {
        if (this.redo_history.length > 0) {
            this.lockMode = true;
            const content = this.redo_history.pop();
            this.undo_history.push(content);
            this.canvas.loadFromJSON(content, () => {
                this.canvas.renderAll();
                this.lockMode = false;
            });
        }
    }

  // --- 核心逻辑替换区：请替换原文件中 initCanvas 到 captureCanvasCombined 之间的部分 ---

initCanvas(elem) {
        const canvas = new fabric.Canvas(elem, {
            backgroundColor: '#000',
            preserveObjectStacking: true,
            selection: true,
            fireRightClick: true,
            stopContextMenu: true
        });

        // 1. 强制禁用右键菜单，防止干扰拖拽
        const disableMenu = (e) => { e.preventDefault(); return false; };
        if (canvas.wrapperEl) canvas.wrapperEl.addEventListener('contextmenu', disableMenu);
        canvas.upperCanvasEl.addEventListener('contextmenu', disableMenu);

        // --- 内部状态变量 ---
        let isDragging = false;
        let lastPosX, lastPosY;
        let wasSelectionEnabled = true;

        // 2. 缩放逻辑 (支持 CSS Transform 修正)
        canvas.on('mouse:wheel', (opt) => {
            const delta = opt.e.deltaY;
            let zoom = canvas.getZoom() * (0.999 ** delta);
            zoom = Math.min(Math.max(zoom, 0.1), 20);

            const rect = canvas.getElement().getBoundingClientRect();
            if (rect.width > 0) {
                const x = (opt.e.clientX - rect.left) * (canvas.width / rect.width);
                const y = (opt.e.clientY - rect.top) * (canvas.height / rect.height);
                canvas.zoomToPoint({ x, y }, zoom);
            }
            opt.e.preventDefault();
            opt.e.stopPropagation();
        });

        // 3. 拖拽逻辑 (修正：仅中键或 Alt+左键 触发拖拽，保留右键用于菜单或其它)
        const handleDragStart = (e) => {
            if (e.altKey || e.button === 1) {
                isDragging = true;
                wasSelectionEnabled = canvas.selection;
                canvas.selection = false;
                lastPosX = e.clientX;
                lastPosY = e.clientY;
                canvas.setCursor('grabbing');
                e.preventDefault();
            }
        };
        canvas.upperCanvasEl.addEventListener('mousedown', handleDragStart);

        canvas.on('mouse:move', (opt) => {
            if (!isDragging) return;
            const e = opt.e;
            const vpt = canvas.viewportTransform;
            const rect = canvas.getElement().getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;

            vpt[4] += (e.clientX - lastPosX) * scaleX;
            vpt[5] += (e.clientY - lastPosY) * scaleY;
            canvas.requestRenderAll();
            lastPosX = e.clientX;
            lastPosY = e.clientY;
        });

        const handleDragEnd = () => {
            if (isDragging) {
                canvas.setViewportTransform(canvas.viewportTransform);
                isDragging = false;
                canvas.selection = wasSelectionEnabled;
                canvas.setCursor('default');
            }
        };
        canvas.on('mouse:up', handleDragEnd);
        window.addEventListener('mouseup', handleDragEnd);

         // --- 核心修复区：4. 关键点连线同步 ---

        // 恢复原版：仅在移动单点时，实时更新连线
        const updateLines = (target) => {
            // 魔法1：如果是多选组(activeSelection)，直接跳过实时更新，避免错乱
            if (!target || target.type !== 'circle') return;

            canvas.getObjects('polygon').forEach(polygon => {
                if (polygon._startCircle === target || polygon._endCircle === target) {
                    const start = polygon._startCircle.getCenterPoint();
                    const end = polygon._endCircle.getCenterPoint();
                    const newPoints = this.getFusiformPoints(start, end);
                    polygon.set({ points: newPoints });
                    polygon.setCoords();
                }
            });
        };

        // 仅在移动时触发
        canvas.on('object:moving', (e) => updateLines(e.target));

        // 5. 选区过滤 (防止误选不可选的连线)
        canvas.on('selection:created', (e) => {
            const selection = e.target;
            if (selection.type === 'activeSelection') {
                const selectableObjects = selection.getObjects().filter(obj => obj.selectable);
                if (selectableObjects.length < selection.size()) {
                    canvas.discardActiveObject();
                    if (selectableObjects.length > 1) {
                        const correctSelection = new fabric.ActiveSelection(selectableObjects, { canvas: canvas });
                        canvas.setActiveObject(correctSelection);
                    } else if (selectableObjects.length === 1) {
                        canvas.setActiveObject(selectableObjects[0]);
                    }
                }
            }
        });

// 6. 核心监听：只在松手时触发一次“绝对同步”与“磁性吸附”
canvas.on("object:modified", (e) => {
    if (this.lockMode || !e.target) return;

    const target = e.target;
    const SNAP_DISTANCE = 15; // 🧲 吸附距离阈值（像素），你可以根据手感调大或调小
    let movedCircles = [];    // 记录本次被鼠标移动的圆点

    // 1. 处理全选移动 (ActiveSelection) 与单选移动，并收集移动点
    if (target.type === 'activeSelection') {
        target.setCoords();
        const objects = target.getObjects();

        objects.forEach(obj => {
            if (obj.type === 'circle') {
                const absoluteCenter = obj.getCenterPoint();
                obj.set({
                    left: absoluteCenter.x,
                    top: absoluteCenter.y,
                });
                obj.set("group", null);
                obj.setCoords();
                movedCircles.push(obj); // 收集被拖动的点
            }
        });
        canvas.discardActiveObject();
    } else {
        target.setCoords();
        if (target.type === 'circle') {
            movedCircles.push(target); // 收集单选拖动的点
        }
    }

// ==========================================
    // 🧲 新增功能：判断并执行“磁性吸附” (动态精度版)
    // ==========================================
    if (movedCircles.length > 0) {
        const allCircles = this.canvas.getObjects('circle');

        movedCircles.forEach(movedObj => {
            let closestObj = null;
            let minDistance = Infinity;

            // 🎯 核心优化：根据当前拖动的部位，动态决定吸附灵敏度
            const type = movedObj._type || "body";
            let currentSnapDist = 12; // 身体骨架较大，吸附距离给 12
            if (type === "left_hand" || type === "right_hand") {
                currentSnapDist = 6;  // 手指密集，距离缩小到 6
            } else if (type === "face") {
                currentSnapDist = 3;  // 面部极度密集，只有几乎完全重合(3px)才吸附
            }

            allCircles.forEach(otherObj => {
                if (otherObj === movedObj) return;
                if (movedCircles.includes(otherObj)) return;

                const p1 = movedObj.getCenterPoint();
                const p2 = otherObj.getCenterPoint();
                const dist = Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));

                // 使用专属的 currentSnapDist 进行判定
                if (dist < minDistance && dist <= currentSnapDist) {
                    minDistance = dist;
                    closestObj = otherObj;
                }
            });

            if (closestObj) {
                const targetCenter = closestObj.getCenterPoint();
                movedObj.set({
                    left: targetCenter.x,
                    top: targetCenter.y
                });
                movedObj.setCoords();
            }
        });
    }
    // ==========================================

    // 3. 此时 Canvas 上的所有 Circle 已经拥有了正确的像素坐标（如果有吸附，坐标已经完全重叠）
    // 延迟 20ms 执行闭环重绘（强烈建议加个短暂延迟，让 Fabric 有时间把销毁的组清理干净，防止线条闪烁）
    setTimeout(() => {
        const poseJson = this.serializeJSON();

        // 由于坐标重合，loadJSON 生成的新纺锤线会自动合二为一
        this.loadJSON(poseJson);

        this.saveToNode();
        this.canvas.requestRenderAll();

        console.log(">>> [绝对坐标同步 & 磁性吸附] 处理完成");
    }, 20);
});


return canvas;
    } // <-- 这里正确闭合 initCanvas 方法


    saveToNode() {
        const newPoseJson = this.serializeJSON();

        this.node.setProperty("poses_datas", newPoseJson);

        if (this.node.jsonWidget) {
            this.node.jsonWidget.value = newPoseJson;
        }

        this.uploadAndSetImages();
    }

    async captureCanvasClean() {
        this.lockMode = true;

        // 保存当前视口状态
        const originalViewportTransform = this.canvas.viewportTransform;
        // 重置视口以获取完整未缩放的图像
        this.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];

        const backgroundImage = this.canvas.backgroundImage;

        // 保存图片对象的原始不透明度
        const imageOpacities = new Map();

        try {
            if (backgroundImage) {
                backgroundImage.visible = false;
            }

            this.canvas.getObjects("image").forEach((img) => {
                imageOpacities.set(img, img.opacity);
                img.opacity = 0;
            });

            this.canvas.discardActiveObject();
            this.canvas.renderAll();

            const dataURL = this.canvas.toDataURL({
                multiplier: 1,
                format: 'png'
            });
            const blob = dataURLToBlob(dataURL);
            return blob;
        } catch (e) {
            throw e;
        } finally {
            if (backgroundImage) {
                backgroundImage.visible = true;
            }

            this.canvas.getObjects("image").forEach((img) => {
                if (imageOpacities.has(img)) {
                    img.opacity = imageOpacities.get(img);
                } else {
                    img.opacity = 1; // 默认恢复
                }
            });

            // 恢复视口状态
            this.canvas.viewportTransform = originalViewportTransform;
            this.canvas.renderAll();

            this.lockMode = false;
        }
    }

    async captureCanvasCombined() {
        this.lockMode = true;

        // 保存当前视口状态
        const originalViewportTransform = this.canvas.viewportTransform;
        // 重置视口以获取完整未缩放的图像
        this.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];

        const backgroundImage = this.canvas.backgroundImage;
        let originalOpacity = 1.0;

        try {
            if (backgroundImage) {
                originalOpacity = backgroundImage.opacity;
                backgroundImage.opacity = 1.0;
            }

            this.canvas.discardActiveObject();
            this.canvas.renderAll();

            const dataURL = this.canvas.toDataURL({
                multiplier: 1,
                format: 'png'
            });
            const blob = dataURLToBlob(dataURL);
            return blob;
        } catch (e) {
            throw e;
        } finally {
            if (backgroundImage) {
                backgroundImage.opacity = originalOpacity;
            }

            // 恢复视口状态
            this.canvas.viewportTransform = originalViewportTransform;
            this.canvas.renderAll();

            this.lockMode = false;
        }
    }


    async uploadAndSetImages() {
        try {
            const cleanBlob = await this.captureCanvasClean();
            if (!cleanBlob || cleanBlob.size === 0) {
                return;
            }

            const cleanFilename = `ComfyUI_OpenPose_${this.node.id}.png`;

            const bodyClean = new FormData();
            bodyClean.append("image", cleanBlob, cleanFilename);
            bodyClean.append("overwrite", "true");

            const respClean = await fetch("/upload/image", { method: "POST", body: bodyClean });
            if (respClean.status !== 200) {
                throw new Error(`Failed to upload clean pose image: ${respClean.statusText}`);
            }
            const dataClean = await respClean.json();
            await this.node.setImage(dataClean.name);

            if (this.canvas.backgroundImage) {
                const combinedBlob = await this.captureCanvasCombined();
                const combinedFilename = `ComfyUI_OpenPose_${this.node.id}_combined.png`;

                const bodyCombined = new FormData();
                bodyCombined.append("image", combinedBlob, combinedFilename);
                bodyCombined.append("overwrite", "true");

                const respCombined = await fetch("/upload/image", { method: "POST", body: bodyCombined });
            }

        } catch (error) {
            alert(error);
        }
    }


    resetCanvas() {
        this.canvas.clear();
        this.canvas.setBackgroundImage(null, this.canvas.renderAll.bind(this.canvas));
        this.canvas.backgroundColor = "#000";
        this.nextPoseId = 0;
    }

    load() {
        this.fileInput.value = null;
        this.fileInput.click();
    }

    async onLoad(e) {
        const file = this.fileInput.files[0];
        const text = await readFileToText(file);
        const error = await this.loadJSON(text);
        if (error != null) {
            app.ui.dialog.show(error);
        }
        else {
            this.saveToNode();
        }
    }

serializeJSON() {
    if (!this.canvas) return "";

    // 重置视口，确保 getCenterPoint 获取的是不受 transform 影响的画布绝对坐标
    const originalViewportTransform = this.canvas.viewportTransform;
    this.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];

    const allCircles = this.canvas.getObjects('circle');
    const poses = {};

    allCircles.forEach(circle => {
        const poseId = circle._poseId;
        if (typeof poseId === 'undefined' || poseId === null) return;

        if (!poses[poseId]) {
            poses[poseId] = {
                body: new Array(25 * 3).fill(0),
                left_hand: new Array(21 * 3).fill(0),
                right_hand: new Array(21 * 3).fill(0),
                face: new Array(70 * 3).fill(0)
            };
        }

        // 使用 getCenterPoint 确保获取的是不受 transform 影响的绝对中心像素坐标
        const center = circle.getCenterPoint();
        const type = circle._type || "body";
        const idx = circle._id * 3;

        // 统一 Key 名映射到 DWPose 的 4 个核心字段
        let targetArr = null;
        if (type === "body") targetArr = poses[poseId].body;
        else if (type === "left_hand") targetArr = poses[poseId].left_hand;
        else if (type === "right_hand") targetArr = poses[poseId].right_hand;
        else if (type === "face") targetArr = poses[poseId].face;

        if (targetArr && idx < targetArr.length) {
            targetArr[idx] = Math.round(center.x);
            targetArr[idx + 1] = Math.round(center.y);
            targetArr[idx + 2] = 1.0; // 只要点在画布上，置信度就给满
        }
    });

    const people = [];
    Object.keys(poses).sort((a,b)=>a-b).forEach(pid => {
        const p = poses[pid];

        // 辅助判定某个部位是否有有效数据
        const hasData = (arr) => arr && arr.some(v => v !== 0);

        people.push({
            // --- 统一输出标准字段名，完美适配 loadJSON 的字段寻找逻辑 ---
            "pose_keypoints_2d": p.body,
            "hand_left_keypoints_2d": hasData(p.left_hand) ? p.left_hand : null,
            "hand_right_keypoints_2d": hasData(p.right_hand) ? p.right_hand : null,
            "face_keypoints_2d": hasData(p.face) ? p.face : null
        });
    });

    // 按照 DWPose 官方标准构造最终 JSON，输出 canvas_width 以防止漂移
    const json = JSON.stringify({
        "width": Math.round(this.canvas.width),
        "height": Math.round(this.canvas.height),
        "canvas_width": Math.round(this.canvas.width),
        "canvas_height": Math.round(this.canvas.height),
        "people": people
    }, null, 4);

    this.canvas.viewportTransform = originalViewportTransform;
    return json;
}
    async loadBackgroundImage(e) {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const body = new FormData();
            body.append("image", file);
            body.append("overwrite", "true");

            const resp = await fetch("/upload/image", { method: "POST", body: body });
            if (resp.status !== 200) {
                throw new Error(`Failed to upload background image: ${resp.statusText}`);
            }
            const data = await resp.json();
            const filename = data.name;

            this.node.setProperty("backgroundImage", filename);
            if (this.node.bgImageWidget) {
                this.node.bgImageWidget.value = filename;
            }

            const imageUrl = `/view?filename=${filename}&type=input&subfolder=${data.subfolder}&t=${Date.now()}`;
            fabric.Image.fromURL(imageUrl, (img) => {
                img.set({
                    scaleX: this.canvas.width / img.width,
                    scaleY: this.canvas.height / img.height,
                    opacity: 0.6,
                    selectable: false,
                    evented: false,
                });
                this.canvas.setBackgroundImage(img, this.canvas.renderAll.bind(this.canvas));

                this.uploadAndSetImages();

            }, { crossOrigin: 'anonymous' });

        } catch (error) {
            alert(error);
        } finally {
            e.target.value = '';
        }
    }

    save() {
        const json = this.serializeJSON()
        const blob = new Blob([json], {
            type: "application/json"
        });
        const filename = "pose-" + Date.now().toString() + ".json"
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

loadJSON(text) {
    if (!text) return "Empty data";

    try {
        // 1. 深度克隆数据，防止原地修改导致的第二次运行逻辑错误
        const rawJson = typeof text === 'string' ? JSON.parse(text) : text;
        const json = JSON.parse(JSON.stringify(rawJson));

        // 2. 增强型尺寸读取
        const width = json.canvas_width || json.width || (this.canvas ? this.canvas.width : 512);
        const height = json.canvas_height || json.height || (this.canvas ? this.canvas.height : 512);

        this.resizeCanvas(width, height);

        const people = json.people || [];

        // 3. 智能坐标转换与字段对齐
        people.forEach(person => {
            // 模糊匹配：只要包含这些关键字的 Key 都处理
            const allKeys = Object.keys(person);
            allKeys.forEach(key => {
                if (key.includes("keypoints_2d") || key === "body" || key === "face" || key.includes("hand")) {
                    const kpts = person[key];
                    if (Array.isArray(kpts) && kpts.length > 0) {

                        // 改进的相对坐标判定：检查前 10 个有效点
                        let isRelative = false;
                        for (let i = 0; i < Math.min(kpts.length, 30); i += 3) {
                            const x = kpts[i];
                            const y = kpts[i+1];
                            const conf = kpts[i+2];
                            // 只要有一个置信度大于 0 且坐标在 0-1.1 之间的点，就认为是相对坐标
                            if (conf > 0 && x > 0 && x <= 1.1 && y > 0 && y <= 1.1) {
                                isRelative = true;
                                break;
                            }
                        }

                        if (isRelative) {
                            for (let i = 0; i < kpts.length; i += 3) {
                                kpts[i] *= width;
                                kpts[i + 1] *= height;
                            }
                        }
                    }
                }
            });
        });

        // 4. 强制重置渲染状态并调用渲染
        if (this.canvas) {
            this.canvas.discardActiveObject();
            // 在这里调用 setPose
            this.setPose(people);
        }

        // 5. 恢复过滤器
        if (this.poseFilterInput) {
            const idx = parseInt(this.poseFilterInput.value, 10);
            if (!isNaN(idx)) this.applyPoseFilter(idx);
        }

        return null;
    } catch (e) {
        console.error("loadJSON 优化版运行失败:", e);
        return `Failed to parse JSON: ${e.message}`;
    }
}
}

app.registerExtension({
    name: "Nui.OpenPoseEditor",
    setup() {
        api.addEventListener("openpose_node_pause", (event) => {
            const nodeId = event.detail.node_id;
            const currentPose = event.detail.current_pose; // 获取后端传来的最新姿态数据
            const currentBackgroundImage = event.detail.current_background_image; // 获取最新背景图

            const node = app.graph.getNodeById(nodeId);
            if (!node) return;


            // 标记节点处于暂停状态
            node.is_paused = true;

            // 0. 关键修复：如果后端传来了最新的姿态数据，强制更新节点属性和编辑器
            if (currentPose && currentPose.trim() !== "") {
                node.setProperty("poses_datas", currentPose);

                // 如果编辑器实例存在，直接加载新数据
                if (node.openPosePanel) {
                    node.openPosePanel.loadJSON(currentPose);
                }
            }

            // 0.5 关键修复：如果后端传来了最新的背景图，强制更新
            if (currentBackgroundImage && currentBackgroundImage.trim() !== "") {
                node.setProperty("backgroundImage", currentBackgroundImage);

                if (node.openPosePanel) {
                    // 强制刷新背景图
                    const imageUrl = `/view?filename=${currentBackgroundImage}&type=input&t=${Date.now()}`;
                    fabric.Image.fromURL(imageUrl, (img) => {
                        if (!img || !img.width) return;
                        img.set({
                            scaleX: node.openPosePanel.canvas.width / img.width,
                            scaleY: node.openPosePanel.canvas.height / img.height,
                            opacity: 0.6,
                            selectable: false,
                            evented: false,
                        });
                        node.openPosePanel.canvas.setBackgroundImage(img, node.openPosePanel.canvas.renderAll.bind(node.openPosePanel.canvas));
                    }, { crossOrigin: 'anonymous' });
                }
            }

            // 1. 确保编辑器已打开
            if (node.openWidget && node.openWidget.callback) {
                // 如果面板未打开，调用callback打开它
                if (!node.openPosePanel || !node.openPosePanel.panel || !document.body.contains(node.openPosePanel.panel)) {
                    node.openWidget.callback();
                }
            }

            // 2. 在面板底部添加控制按钮
            if (node.openPosePanel && node.openPosePanel.panel) {
                // 调用封装好的方法
                node.openPosePanel.showPauseControls();
            }
        });
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "Nui.OpenPoseEditor") {
            return
        }

        fabric.Object.prototype.transparentCorners = false;
        fabric.Object.prototype.cornerColor = '#108ce6';
        fabric.Object.prototype.borderColor = '#108ce6';
        fabric.Object.prototype.cornerSize = 10;

        const makePanelDraggable = function (panelElement) {
            let isDragging = false;
            let startX, startY;
            let initialLeft, initialTop;

            // 尝试查找标题栏，如果没有则使用整个面板但限制点击区域
            // ComfyUI/LiteGraph 面板通常没有标准的 header class，但内容在顶部
            // 我们通过监听 mousedown 并判断点击位置来实现

            panelElement.addEventListener("mousedown", (e) => {
                const rect = panelElement.getBoundingClientRect();

                // 1. 排除右下角缩放手柄区域 (例如 30x30 像素)
                if (e.clientX > rect.right - 30 && e.clientY > rect.bottom - 30) {
                    return;
                }

                // 2. 排除交互元素 (Input, Button, Canvas 等)
                const target = e.target;
                const tagName = target.tagName.toUpperCase();

                if (tagName === 'INPUT' ||
                    tagName === 'BUTTON' ||
                    tagName === 'SELECT' ||
                    tagName === 'TEXTAREA' ||
                    tagName === 'CANVAS') {
                    return;
                }

                // 排除 Fabric 的容器 (避免误触 Canvas 边缘)
                if (target.classList.contains('canvas-container')) {
                    return;
                }

                // 3. 允许拖动 (只要不是上述元素，点击面板任何空白处都可以拖动)
                isDragging = true;
                startX = e.clientX;
                startY = e.clientY;

                // 关键：在开始拖动时，将 transform 转换为绝对的 left/top 坐标
                // 这样可以避免 transform: translate(-50%, -50%) 带来的计算复杂性
                const computedStyle = window.getComputedStyle(panelElement);
                const currentLeft = rect.left;
                const currentTop = rect.top;

                // 拖动时保持 fixed 定位，移除 transform，直接使用 left/top
                panelElement.style.transform = "none";
                panelElement.style.position = "fixed";
                panelElement.style.left = currentLeft + "px";
                panelElement.style.top = currentTop + "px";
                panelElement.style.margin = "0";
                // 确保拖拽时层级依然最高
                panelElement.style.zIndex = "2147483647";

                initialLeft = currentLeft;
                initialTop = currentTop;

                document.body.style.userSelect = "none";
                panelElement.style.cursor = "move";
            });

            window.addEventListener("mousemove", (e) => {
                if (!isDragging) return;

                e.preventDefault();
                const deltaX = e.clientX - startX;
                const deltaY = e.clientY - startY;

                panelElement.style.left = (initialLeft + deltaX) + "px";
                panelElement.style.top = (initialTop + deltaY) + "px";
            });

            window.addEventListener("mouseup", () => {
                if (isDragging) {
                    isDragging = false;
                    document.body.style.userSelect = "";
                    panelElement.style.cursor = "default";
                }
            });
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            if (!this.properties) {
                this.properties = {};
            }
            if (!this.properties.poses_datas) {
                this.properties.poses_datas = "";
            }

            this.serialize_widgets = true;

            this.imageWidget = this.widgets.find(w => w.name === "image");
            this.imageWidget.callback = this.showImage.bind(this);
            this.imageWidget.disabled = true;


            this.bgImageWidget = this.addWidget("text", "backgroundImage", this.properties.backgroundImage || "", () => { }, {});
            if (this.bgImageWidget && this.bgImageWidget.inputEl) {
                this.bgImageWidget.inputEl.style.display = "none";
            }

			this.jsonWidget = this.addWidget("text", "poses_datas", this.properties.poses_datas, "poses_datas");
            if (this.jsonWidget && this.jsonWidget.inputEl) {
                this.jsonWidget.inputEl.style.display = "none";
            } else {
            }
			// ========== 关键修改：添加"应用姿态"按钮（从poses_datas加载） ==========
            this.applyPoseWidget = this.addWidget("button", "应用姿态", "image", async () => {
                try {
                    // 检查编辑器是否已打开
                    if (this.openPosePanel) {
                        // 如果编辑器已打开，直接调用加载pose数据的方法
                        await this.openPosePanel.loadFromPoseKeypoint();
                    } else {
                        // 如果编辑器未打开，直接从poses_datas属性读取数据
                        let poseData = this.properties?.poses_datas;

                        if (!poseData || poseData.trim() === "") {
                            alert("未检测到有效的poses_datas数据，请先确保该属性有值！");
                            return;
                        }

                        // 数据格式标准化
                        let poseJson = null;
                        if (typeof poseData === "string") {
                            poseJson = JSON.parse(poseData);
                        } else if (Array.isArray(poseData) || typeof poseData === "object") {
                            poseJson = poseData;
                        }

                        if (!poseJson) {
                            alert("poses_datas数据格式错误！");
                            return;
                        }

                        // 提取宽高信息
                        let canvasWidth = 512;
                        let canvasHeight = 512;
                        if (Array.isArray(poseJson) && poseJson[0]) {
                            canvasWidth = poseJson[0].canvas_width || poseJson[0].width || 512;
                            canvasHeight = poseJson[0].canvas_height || poseJson[0].height || 512;
                        } else if (poseJson.width && poseJson.height) {
                            canvasWidth = poseJson.width;
                            canvasHeight = poseJson.height;
                        }

                        // 更新节点的宽高属性
                        this.setProperty("output_width_for_dwpose", canvasWidth);
                        this.setProperty("output_height_for_dwpose", canvasHeight);

                        // 更新对应的输入框
                        const widthWidget = this.widgets?.find(w => w.name === "output_width_for_dwpose");
                        if (widthWidget) {
                            widthWidget.value = canvasWidth;
                            if (widthWidget.callback) widthWidget.callback(canvasWidth);
                            if (widthWidget.inputEl) widthWidget.inputEl.value = canvasWidth;
                        }

                        const heightWidget = this.widgets?.find(w => w.name === "output_height_for_dwpose");
                        if (heightWidget) {
                            heightWidget.value = canvasHeight;
                            if (heightWidget.callback) heightWidget.callback(canvasHeight);
                            if (heightWidget.inputEl) heightWidget.inputEl.value = canvasHeight;
                        }

                        // 提取people数据并保存到节点（确保数据格式正确）
                        let people = [];
                        if (Array.isArray(poseJson) && poseJson[0]?.people) {
                            people = poseJson[0].people;
                        } else if (poseJson.people) {
                            people = poseJson.people;
                        }

                        if (people.length > 0) {
                            // 序列化pose数据并保存到节点
                            const poseJsonData = JSON.stringify({
                                "width": canvasWidth,
                                "height": canvasHeight,
                                "people": people
                            }, null, 4);

                            this.setProperty("poses_datas", poseJsonData);
                            if (this.jsonWidget) {
                                this.jsonWidget.value = poseJsonData;
                            }

                            // 触发节点刷新
                            this.setDirtyCanvas(true, true);
                            if (app.graph) app.graph.setDirtyCanvas(true, true);
                            if (app.canvas) app.canvas.draw(true);

                        } else {
                            alert("poses_datas中未找到有效的人体关键点信息！");
                        }
                    }
                } catch (error) {
                    alert(`应用姿态失败：${error.message}`);
                }
            });
            this.applyPoseWidget.serialize = false;

            this.openWidget = this.addWidget("button", "姿态编辑", "image", () => {
                const graphCanvas = LiteGraph.LGraphCanvas.active_canvas
                if (graphCanvas == null)
                    return;

                // 【修改】移除pose_keypoint输入检查，改为检查poses_datas属性
                if (this.properties.poses_datas && this.properties.poses_datas.trim() !== "") {
                } else {
                }

                const panel = graphCanvas.createPanel("姿态编辑器", { closable: true });
                panel.node = this;
                panel.classList.add("openpose-editor");

                // 设置更大的默认尺寸
                panel.style.width = "900px";
                panel.style.height = "800px";
                // 终极修复：使用独立的遮罩层容器
                let mask = document.getElementById("openpose-mask-container");
                if (!mask) {
                    mask = document.createElement("div");
                    mask.id = "openpose-mask-container";
                    mask.style.cssText = "position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;";
                    document.body.appendChild(mask);
                }

                // 强制将 panel 移入遮罩层，并设置最高优先级样式
                mask.appendChild(panel);

                // 确保 panel 自身样式正确，并启用交互
                panel.style.position = "fixed";
                panel.style.top = "50%";
                panel.style.left = "50%";
                panel.style.transform = "translate(-50%, -50%)";
                panel.style.zIndex = "2147483647";
                panel.style.pointerEvents = "auto";
                panel.style.boxShadow = "0 0 50px rgba(0,0,0,0.5)"; // 添加阴影增加可视性

                this.openPosePanel = new OpenPosePanel(panel, this);
                makePanelDraggable(panel, this.openPosePanel);

                // 确保 resize handle 也跟过去
                const resizer = document.createElement("div");
                resizer.style.width = "10px";
                resizer.style.height = "10px";
                resizer.style.background = "#888";
                resizer.style.position = "absolute";
                resizer.style.right = "0";
                resizer.style.bottom = "0";
                resizer.style.cursor = "se-resize";
                panel.appendChild(resizer);

                // 添加保活机制：防止 LiteGraph 或其他脚本将 panel 移走
                // 每 500ms 检查一次，如果 panel 不在 mask 中，则移回
                const keepAliveInterval = setInterval(() => {
                    if (panel && mask && panel.parentElement !== mask) {
                         mask.appendChild(panel);
                    }
                    // 如果 panel 被关闭（通常是从 DOM 移除），清除定时器
                    // 注意：LiteGraph 的 close 可能会移除元素，我们需要检测
                    if (!document.body.contains(mask)) {
                        clearInterval(keepAliveInterval);
                    }
                }, 500);

                // 劫持 panel.close 以清理 mask 和定时器
                const originalClose = panel.close;
                panel.close = function() {
                    clearInterval(keepAliveInterval);
                    if (originalClose) originalClose.call(panel);
                    if (mask && mask.parentNode) {
                        mask.parentNode.removeChild(mask);
                    }
                };

                let isResizing = false;
                resizer.addEventListener("mousedown", (e) => {
                    e.preventDefault();
                    isResizing = true;
                });

                document.addEventListener("mousemove", (e) => {
                    if (!isResizing) return;
                    const rect = panel.getBoundingClientRect();
                    panel.style.width = `${e.clientX - rect.left}px`;
                    panel.style.height = `${e.clientY - rect.top}px`;
                });

                document.addEventListener("mouseup", () => {
                    isResizing = false;
                    this.openPosePanel.resizeCanvas()
                });
            });
            this.openWidget.serialize = false;

            // ====================================================

            requestAnimationFrame(async () => {
                if (this.imageWidget.value) {
                    await this.setImage(this.imageWidget.value);
                }
            });
        }

        const onExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {

			if (onExecuted) {
				onExecuted.apply(this, arguments);
			}


			let dataUpdated = false;

			if (message && message.poses_datas && message.poses_datas.length > 0) {
				const poseData = message.poses_datas[0];
				if (poseData && poseData.trim() !== "") {
					this.setProperty("poses_datas", poseData);

					const poseShape = message.dw_pose_shape && message.dw_pose_shape[0] ? message.dw_pose_shape[0] : [];
					if (poseShape.length >= 4) {
						const height = poseShape[1];
						const width = poseShape[2];

						this.setProperty("output_width_for_dwpose", width);
						this.setProperty("output_height_for_dwpose", height);

						const widthWidget = this.widgets?.find(w => w.name === "output_width_for_dwpose");
						if (widthWidget) {
							widthWidget.value = width;
							widthWidget.callback?.(width);
						}

						const heightWidget = this.widgets?.find(w => w.name === "output_height_for_dwpose");
						if (heightWidget) {
							heightWidget.value = height;
							heightWidget.callback?.(height);
						}
					}

					if (this.imageWidget) {
						this.imageWidget.value = poseData;
					}
					if (this.jsonWidget) {
						this.jsonWidget.value = poseData;
					}


					requestAnimationFrame(async () => {
						if (this.imageWidget.value) {
							await this.setImage(message.editdPose[0]);
						}
					});

					dataUpdated = true;
				}
			}

				if (message && message.backgroundImage && message.backgroundImage.length > 0) {
					const bgImage = message.backgroundImage[0];
					if (bgImage && bgImage.trim() !== "") {
						this.setProperty("backgroundImage", bgImage);
						if (this.bgImageWidget) {
							this.bgImageWidget.value = bgImage;
						}
						dataUpdated = true;
					}
				}

				if (message && message.inputPose && message.inputPose.length > 0) {
					const bgImage = message.inputPose[0];
					if (bgImage && bgImage.trim() !== "") {
						this.setProperty("backgroundImage", bgImage);
						if (this.bgImageWidget) {
							this.bgImageWidget.value = bgImage;
						}
						dataUpdated = true;
					}
				}

			if (dataUpdated && this.openPosePanel) {

				if (this.properties.poses_datas && this.properties.poses_datas.trim() !== "") {
					const error = this.openPosePanel.loadJSON(this.properties.poses_datas);
				}

				if (this.properties.backgroundImage && this.properties.backgroundImage.trim() !== "") {
					const imageUrl = `/view?filename=${this.properties.backgroundImage}&type=input&t=${Date.now()}`;
					fabric.Image.fromURL(imageUrl, (img) => {
						if (!img || !img.width) {
							return;
						}
						img.set({
							scaleX: this.openPosePanel.canvas.width / img.width,
							scaleY: this.openPosePanel.canvas.height / img.height,
							opacity: 0.6,
							selectable: false,
							evented: false,
						});
						this.openPosePanel.canvas.setBackgroundImage(img, this.openPosePanel.canvas.renderAll.bind(this.openPosePanel.canvas));
					}, { crossOrigin: 'anonymous' });
				}
			}

			if (dataUpdated) {
				app.graph.setDirtyCanvas(true, true);
				this.onResize?.(this.size);
				app.canvas.draw(true);
			}

			this.setDirtyCanvas(true, true);
		}
        nodeType.prototype.showImage = async function (name) {
            let folder_separator = name.lastIndexOf("/");
            let subfolder = "";
            if (folder_separator > -1) {
                subfolder = name.substring(0, folder_separator);
                name = name.substring(folder_separator + 1);
            }
            const img = await loadImageAsync(`/view?filename=${name}&type=input&subfolder=${subfolder}&t=${Date.now()}`);
            this.imgs = [img];
            app.graph.setDirtyCanvas(true);
        }

        nodeType.prototype.setImage = async function (name) {
            this.imageWidget.value = name;
            await this.showImage(name);
        }

        const baseOnPropertyChanged = nodeType.prototype.onPropertyChanged;
        nodeType.prototype.onPropertyChanged = function (property, value, prev) {
            if (property === "poses_datas" && this.jsonWidget) {
                this.jsonWidget.value = value;
            } else if (baseOnPropertyChanged) {
                baseOnPropertyChanged.call(this, property, value, prev);
            }
        };

    }
});
