// wrap-viewer.js — 把 Tesla Paint Shop UV-unwrap PNG 真实贴到 3D 车模
// build.js 把 __REGISTRY__ 替换成各车型 GLB 注册表的 JSON 字符串
import * as THREE from 'three';
import { GLTFLoader } from '/assets/vendor/three/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from '/assets/vendor/three/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from '/assets/vendor/three/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from '/assets/vendor/three/jsm/environments/RoomEnvironment.js';

const REG = __REGISTRY__;

// 不同材质的预设（按 tscherrie/tesla-wrap-viewer 派生：body / 玻璃 / 灯 / 后视镜 / 轮胎）
const MAT_PRESETS = {
  tire_mat4:            { color: 0x1a1a1a, metalness: 0, roughness: 0.85 },
  window:               { color: 0x111111, transparent: true, opacity: 0.4 },
  windowpng:            { color: 0x111111, transparent: true, opacity: 0.4 },
  clearglass:           { color: 0x111111, transparent: true, opacity: 0.4 },
  clearglasssidepillar: { color: 0x111111, transparent: true, opacity: 0.4 },
  lightled:             { color: 0xffffff, transparent: true, opacity: 0.6, emissive: 0xff6666, emissiveIntensity: 0.4 },
  rearlightwhite:       { color: 0xffffff, transparent: true, opacity: 0.6, emissive: 0xff4444, emissiveIntensity: 0.5 },
  rearlight_bright:     { color: 0xffffff, transparent: true, opacity: 0.6, emissive: 0xff4444, emissiveIntensity: 0.5 },
  chromheadlight:       { color: 0xffffff, transparent: true, opacity: 0.6 },
  mirror:               { color: 0xeeeeee, metalness: 0.5, roughness: 0.2 },
};

class WrapViewer {
  constructor(root) {
    this.root = root;

    // canvas 容器：viewer3d div 已设宽高，canvas 撑满
    const cv = document.createElement('canvas');
    cv.setAttribute('aria-hidden', 'true');
    root.appendChild(cv);
    this.canvas = cv;

    this.modelKey = root.dataset.model;
    this.cfg = REG[this.modelKey];
    this.bodyMesh = null;
    this.currentTex = null;

    // 场景/相机/渲染器/控制
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
    this.renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.controls = new OrbitControls(this.camera, cv);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.autoRotate = root.dataset.autoRotate === '1';
    this.controls.autoRotateSpeed = 1.0;
    // min/maxDistance 由 fit() 按模型实际包围盒动态设置（硬编码会把相机卡进车内）

    // 环境贴图：RoomEnvironment 提供中性反射，让金属车漆亮起来（否则金属面反射纯黑）
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    } catch (e) {
      console.warn('[wrap-viewer] env map failed', e);
    }

    // 三点打灯（无 HDR 环境图也能看清颜色）
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dl = new THREE.DirectionalLight(0xffffff, 0.85);
    dl.position.set(3, 5, 4);
    this.scene.add(dl);
    const dl2 = new THREE.DirectionalLight(0xffffff, 0.45);
    dl2.position.set(-3, 3, -2);
    this.scene.add(dl2);

    this.setTip(root.dataset.statusInit || '加载 3D 模型中…');

    // 注册表缺该车型 → fallback
    if (!this.cfg || this.cfg.missing) {
      this.fallback();
      return;
    }

    const loader = new GLTFLoader();
    // Draco 压缩模型解码（model3.glb 已用 gltf-transform draco 压缩，23.7MB→1.6MB）
    const draco = new DRACOLoader();
    draco.setDecoderPath('/assets/vendor/three/jsm/libs/draco/gltf/');
    loader.setDRACOLoader(draco);
    loader.load(this.cfg.file, (gltf) => {
      this.scene.add(gltf.scene);
      gltf.scene.traverse((ch) => {
        if (!ch.material) return;
        const n = (ch.material.name || '').toLowerCase();
        if (n === (this.cfg.bodyMaterial || 'body').toLowerCase()) {
          // 车身：保留为可贴图状态
          this.bodyMesh = ch;
          ch.material = new THREE.MeshPhysicalMaterial({
            color: 0xffffff, metalness: 0.12, roughness: 0.4,
            clearcoat: 0.25, clearcoatRoughness: 0.2, side: THREE.DoubleSide,
          });
        } else if (MAT_PRESETS[n]) {
          // 玻璃 / 灯 / 镜 / 轮胎：硬编码预设
          ch.material = new THREE.MeshPhysicalMaterial(MAT_PRESETS[n]);
        }
      });
      this.fit();
      this.resize();
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(root);
      this._animate = this._animate.bind(this);
      this._animate();
      root._viewerReady = true;
      const def = root.dataset.defaultSkinUrl;
      if (def) this.apply(def);
      else this.setTip(root.dataset.statusApplied || '已就绪');
    }, undefined, (err) => {
      console.error('[wrap-viewer] GLB load error', err);
      this.setTip(root.dataset.statusError || '3D 模型加载失败');
      this.fallback();
    });
  }

  // 包围盒自适应相机
  fit() {
    const box = new THREE.Box3().setFromObject(this.scene);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    this.controls.target.copy(center);
    const fov = this.camera.fov * Math.PI / 180;
    const dist = (size / (2 * Math.tan(fov / 2))) * 1.12;
    const off = new THREE.Vector3(0.6, 0.32, 1).normalize().multiplyScalar(dist);
    this.camera.position.copy(center.clone().add(off));
    this.camera.near = Math.max(0.05, dist / 100);
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    // 动态缩放范围：让初始位置落在可达区间里，允许用户放大/缩小
    this.controls.minDistance = dist * 0.35;
    this.controls.maxDistance = dist * 6;
    this.controls.update();
  }

  resize() {
    const r = this.root.getBoundingClientRect();
    const w = Math.max(2, Math.floor(r.width));
    const h = Math.max(2, Math.floor(r.height));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  // 换肤：UV-unwrap PNG → 车身 baseColorTexture
  apply(url) {
    if (!this.bodyMesh || !url) return;
    if (this.currentTex) { try { this.currentTex.dispose(); } catch (e) {} }
    const tex = new THREE.TextureLoader().load(url, () => {
      this.setTip(this.root.dataset.statusApplied || '已贴上该皮肤图案');
    }, undefined, (err) => {
      console.error('[wrap-viewer] texture error', err);
      this.setTip(this.root.dataset.statusError || '贴图加载失败');
    });
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false; // 与 Blender 默认 UV 出口一致
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    this.currentTex = tex;
    this.bodyMesh.material.map = tex;
    this.bodyMesh.material.color.set(0xffffff);
    this.bodyMesh.material.needsUpdate = true;
  }

  setTip(text) {
    const tip = this.root.querySelector('.viewer-tip');
    if (tip) tip.textContent = text;
  }

  // 车型暂未找到匹配的 GLB → fallback：静态整车图
  // 注册表里为每个车型配了 staticImage（/assets/models/*.png 整车渲染图）。
  // 详情页还会叠一张当前皮肤的缩略角标，让用户看得到"车+这套涂装"。
  fallback() {
    this.root.classList.add('viewer-static');
    this.setTip(this.root.dataset.statusFallback || '3D 预览开发中');
    if (this.canvas) this.canvas.style.display = 'none';
    // 隐藏对静态图无意义的换肤/还原按钮
    const applyBtn = this.root.querySelector('[apply-tex]');
    const resetBtn = this.root.querySelector('[reset-tex]');
    if (applyBtn) applyBtn.style.display = 'none';
    if (resetBtn) resetBtn.style.display = 'none';

    const imgUrl = this.cfg && this.cfg.staticImage;
    if (imgUrl) {
      const img = document.createElement('img');
      img.src = imgUrl;
      img.alt = this.modelKey || 'vehicle';
      img.loading = 'lazy';
      img.className = 'viewer-static-img';
      const tip = this.root.querySelector('.viewer-tip');
      if (tip) this.root.insertBefore(img, tip);
      else this.root.appendChild(img);
    }

    // 详情页：右上角叠加当前皮肤缩略图
    const thumb = this.root.dataset.skinThumb;
    if (thumb) {
      const b = document.createElement('div');
      b.className = 'viewer-static-badge';
      b.innerHTML = '<img src="' + thumb + '" alt="' + (this.modelKey || 'skin') + '" />'
        + '<span>' + (this.root.dataset.skinName || '') + '</span>';
      const tip = this.root.querySelector('.viewer-tip');
      if (tip) this.root.insertBefore(b, tip);
      else this.root.appendChild(b);
    }
  }

  _animate() {
    requestAnimationFrame(this._animate);
    if (!this.renderer) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

function bootViewers() {
  document.querySelectorAll('.viewer3d').forEach((r) => {
    if (r._viewer) return;
    r._viewer = new WrapViewer(r);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootViewers);
} else {
  bootViewers();
}

// 卡片换肤：data-viewer + data-skin-url
document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-viewer][data-skin-url]');
  if (!card) return;
  // <a> 卡片允许默认跳转
  if (card.tagName === 'A' && card.dataset.nav !== '1') return;
  const id = card.dataset.viewer;
  const url = card.dataset.skinUrl;
  const root = document.getElementById(id);
  if (!root || !root._viewer) return;
  if (root._viewerReady) {
    root._viewer.apply(url);
    document.querySelectorAll('[data-viewer="' + id + '"]').forEach((c) => c.classList.remove('active'));
    card.classList.add('active');
  }
  // 详情页 / 车型页 related（不是 <a>，是 <div>）：阻止默认以防外层链接冒泡
  e.preventDefault();
});

// [apply-tex] 按钮：轮换 data-related 里的下一张
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[apply-tex]');
  if (!btn) return;
  const root = btn.closest('.viewer3d');
  if (!root || !root._viewer) return;
  const list = JSON.parse(root.dataset.related || '[]');
  if (!list.length) return;
  const cur = root.dataset.skinUrl || root.dataset.defaultSkinUrl;
  const idx = list.findIndex((r) => r.url === cur);
  const next = list[(idx + 1 + list.length) % list.length];
  root.dataset.skinUrl = next.url;
  root._viewer.apply(next.url);
  if (next.file) {
    const tip = root.querySelector('.viewer-tip');
    if (tip) tip.textContent = next.file;
  }
});

// [reset-tex] 按钮：还原为出厂（应用 init skin）
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[reset-tex]');
  if (!btn) return;
  const root = btn.closest('.viewer3d');
  if (!root || !root._viewer) return;
  const init = root.dataset.initSkinUrl || root.dataset.defaultSkinUrl;
  if (init) root._viewer.apply(init);
});
