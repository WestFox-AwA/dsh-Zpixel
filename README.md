# ZPixel 0.5.3-dev

**中文** | [English](#english)

> 给 AI 用的像素资产插件：让模型在真实的 Y-up 空间里搭场景，再用正交俯视渲染成像素图。

ZPixel 是 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai) 的插件。它注册 7 个 `zpixel\_\*` 工具，把"像素画"从一张平面画布变成可编辑的空间资产：几何、遮挡、描边、光照、主题和法线都有明确来源，模型可以局部修改，而不是每次推倒重画。

* 版本：`0.5.3-dev`
* 渲染内核：`dsh-zpixel/renderer-0.3.6`
* 场景格式：`dsh-zpixel/2`
* 运行时依赖：无第三方依赖，只需要 Node.js >= 22
* 不需要 Godot、Blender 或浏览器渲染器

\---

## 对比实验

同一模型（DeepSeek-V4.1-Flash-1017 官方 API）、同一提示词、同一 WeNeed 思维链、同样 128×256 正俯视坦克任务。

|不使用插件|使用 ZPixel|
|-|-|
|!\[无插件](docs/images/compare-no-plugin.png)|!\[使用 ZPixel](docs/images/compare-with-zpixel.png)|

两者 token 开销几乎相等，差异基本可视为实验方差，因此**插件既不减少也不增加 token 开销**。它改变的是模型组织空间信息的方式：部件、遮挡和光照来自场景结构，而不是一次性的平面笔触。

\---

## 安装

### 给 AI 的一键安装说明

把本仓库链接直接发给你的 AI，让它按下面步骤执行即可：

```text
请阅读 https://github.com/WestFox-AwA/dsh-Zpixel 的 README，按 "安装 / Install" 一节把 ZPixel 插件装进当前 DSH。
要求：
1. 下载 https://github.com/WestFox-AwA/dsh-Zpixel/releases/latest/download/dsh-external-dsh-zpixel-0.5.3-dev.tgz （或从 Releases 页面取最新 tgz）；
2. 执行 dsh plugin --profile <profile> add <tgz 绝对路径>；
3. 在 <profile>/package.json 的 dsh.profile.bundles 末尾追加 "@dsh-external/dsh-zpixel"；
4. 不要同时使用 cordis.patch.yml 的 insert，避免 duplicate loader entry；
5. 重启 DSH，新开会话后调用 zpixel\_guide({topic:"overview"}) 验证返回 "ZPixel 0.5.3-dev"。
```

### 手动安装

前置：可用的 DSH、Node.js >= 22、pnpm（`dsh plugin` 内部会调用）。

1. 下载 [`dsh-external-dsh-zpixel-0.5.3-dev.tgz`](https://github.com/WestFox-AwA/dsh-Zpixel/releases/latest/download/dsh-external-dsh-zpixel-0.5.3-dev.tgz)（或从 [Releases](https://github.com/WestFox-AwA/dsh-Zpixel/releases) 页面选择版本）。
2. 安装到目标 profile：

```bash
dsh plugin --profile web add "/绝对路径/dsh-external-dsh-zpixel-0.5.3-dev.tgz"
```

3. 编辑 `\~/.dsh/profiles/<profile>/package.json`，在 `dsh.profile.bundles` 末尾追加：

```json
{
  "dsh": {
    "profile": {
      "bundles": \[
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@dsh-external/dsh-zpixel"
      ]
    }
  }
}
```

4. 完全退出并重启 DSH（不是只刷新页面）。
5. 新开会话，验证：

```js
zpixel\_guide({ topic: "overview" })
// 返回以 "ZPixel 0.5.3-dev builds a top-down asset..." 开头
```

### 从源码开发

```bash
git clone https://github.com/WestFox-AwA/dsh-Zpixel.git
cd dsh-Zpixel/plugin
npm test          # 200 项测试
```

把 `plugin/` 目录链接进 profile 的 `node\_modules/@dsh-external/dsh-zpixel`，或打包后按上面的方式安装。

### 常见问题

* **工具没出现**：确认 `bundles` 里有 `@dsh-external/dsh-zpixel`，并且是完整重启。
* **duplicate loader entry id: zpixel**：`bundles` 和 `cordis.patch.yml` 的 `insert` 二选一，不要同时用。
* **reviewed 导出被拒**：需要当前模型具备图像输入能力；否则先用 `draft:true`。

\---

## 基本原理

ZPixel 不把像素图当成一张画布，而是当成一个小型空间场景：

1. **场景图**：`group` 负责模块与变换继承，`part` 是实体几何（box / ellipsoid / cylinder / extrude），`layer` 是固定视角的像素层。一个部件可以绑定一张 `appearanceOf` 外观层，只改变颜色，保留实体的深度、法线、遮挡和描边。
2. **正交渲染**：场景相机是唯一持久的交付相机；渲染是精确网格的平行射线投影，没有透视。`beauty / silhouette / depth / normals / nodes` 五种模式共享同一份几何。
3. **调色板与光照**：颜色用命名 palette，材质用 ramp；实体亮度经 ramp 映射成离散色阶，因此像素风格可控且可复现。
4. **描边**：每个节点可以启用 1px 内/外描边，沿父链继承；描边是图像空间效果，不改变几何。
5. **模型优先工作流**：新建空间文档默认先返回一个斜向、只显示实体的工作视图；模型先检查空间结构，再上色，最后用俯视交付相机出图。reviewed 导出要求当前结构有过一次非交付观察，避免"用平面符号盖住空间错误"。
6. **主题**：`zpixel\_theme` 保存可版本化的画风规范（色系、材质、描边、光影、规则），场景按 revision 固定，主题更新不会悄悄改变旧作品。
7. **法线图**：`zpixel\_normalmap` 从同一份 beauty 命中缓冲生成 sprite-local 法线图，并报告 `sourceMode/relief/flatness` 等诊断，区分"设计上就是平的"和"缺少高度输入"。

### 工具

|工具|作用|
|-|-|
|`zpixel\_scene`|创建/编辑场景：节点、几何、锚点、关系、主题、迁移、undo/redo|
|`zpixel\_render`|交付渲染或临时结构观察（camera / fit / isolate / physicalOnly）|
|`zpixel\_inspect`|查树、节点、空间关系、像素、观察视图、主题报告|
|`zpixel\_export`|按 revision 导出 PNG + 可编辑工程 + 回执（draft / reviewed）|
|`zpixel\_normalmap`|生成 sprite-local 法线图（opengl / directx）|
|`zpixel\_theme`|版本化主题库：add / read / list / revise|
|`zpixel\_guide`|领域指南：overview / camera / observation / nodes / geometry / painting / lighting / theme / limits 等|

\---

### 仓库结构 / Repository layout

```text
README.md            # 本页 / this page
docs/images/         # 对比图 / comparison images
plugin/              # 插件包：src、test、locale、package.json、契约文档
LICENSE
```

插件本体在 `plugin/`，`npm test` 也在该目录运行。
The plugin package lives in `plugin/`; run `npm test` there.

## 其他信息

* 反馈 QQ 群：**1121399051**
* 许可证：[MIT](LICENSE)
* 数据位置：所有场景、导出和主题都写在**当前会话工作区**的 `.zpixel/` 下，不写用户主目录。
* 贡献：欢迎 issue / PR；提交前请跑 `npm test`。

\---

# English

**English** | [中文](#zPixel)

> A pixel-asset plugin for AI agents: build a real Y-up scene, then render it as a top-down pixel sprite with an orthographic camera.

ZPixel is a [DSH (DeepSeek Harness)](https://github.com/deepseek-ai) plugin. It registers seven `zpixel\_\*` tools and turns pixel art from a flat canvas into an editable spatial asset: geometry, occlusion, outlines, lighting, themes and normals all have explicit sources, so a model can edit one part instead of regenerating the whole image.

* Version: `0.5.3-dev`
* Renderer: `dsh-zpixel/renderer-0.3.6`
* Scene format: `dsh-zpixel/2`
* Runtime dependencies: none; Node.js >= 22 only
* No Godot, Blender or browser renderer required

## Comparison

Same model (DeepSeek-V4.1-Flash-1017 official API), same prompt, same WeNeed reasoning chain, same 128×256 top-down tank task.

|Without the plugin|With ZPixel|
|-|-|
|!\[without plugin](docs/images/compare-no-plugin.png)|!\[with ZPixel](docs/images/compare-with-zpixel.png)|

Token cost is essentially identical; the difference is within experimental variance. **The plugin neither reduces nor increases token usage** — it changes how the model organizes spatial information: parts, occlusion and lighting come from scene structure instead of one-off flat brush strokes.

## Install

### One-shot instructions for an AI agent

Send this repository link to your AI and ask it to follow these steps:

```text
Read https://github.com/WestFox-AwA/dsh-Zpixel and install ZPixel into the current DSH by following the Install section:
1. Download https://github.com/WestFox-AwA/dsh-Zpixel/releases/latest/download/dsh-external-dsh-zpixel-0.5.3-dev.tgz (or the latest tgz from the Releases page);
2. Run: dsh plugin --profile <profile> add <absolute path to tgz>;
3. Append "@dsh-external/dsh-zpixel" to dsh.profile.bundles in <profile>/package.json;
4. Do not also add an insert entry in cordis.patch.yml (duplicate loader entry);
5. Restart DSH, open a new session, and verify zpixel\_guide({topic:"overview"}) returns "ZPixel 0.5.3-dev".
```

### Manual install

Requirements: a working DSH, Node.js >= 22, pnpm.

1. Download [`dsh-external-dsh-zpixel-0.5.3-dev.tgz`](https://github.com/WestFox-AwA/dsh-Zpixel/releases/latest/download/dsh-external-dsh-zpixel-0.5.3-dev.tgz) (or pick a version on [Releases](https://github.com/WestFox-AwA/dsh-Zpixel/releases)).
2. Install it into your profile:

```bash
dsh plugin --profile web add "/absolute/path/dsh-external-dsh-zpixel-0.5.3-dev.tgz"
```

3. Add the bundle to `\~/.dsh/profiles/<profile>/package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": \[
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@dsh-external/dsh-zpixel"
      ]
    }
  }
}
```

4. Fully quit and restart DSH.
5. In a new session, verify:

```js
zpixel\_guide({ topic: "overview" })
// starts with "ZPixel 0.5.3-dev builds a top-down asset..."
```

### Develop from source

```bash
git clone https://github.com/WestFox-AwA/dsh-Zpixel.git
cd dsh-Zpixel/plugin
npm test          # 200 tests
```

Link the `plugin/` directory into your profile's `node\_modules/@dsh-external/dsh-zpixel`, or pack it and install as above.

### Troubleshooting

* **Tools missing**: confirm `@dsh-external/dsh-zpixel` is in `bundles` and that DSH was fully restarted.
* **duplicate loader entry id: zpixel**: use either `bundles` or a `cordis.patch.yml` insert, not both.
* **Reviewed export rejected**: the current model needs image input; use `draft:true` otherwise.

## How it works

ZPixel treats a sprite as a small spatial scene:

1. **Scene graph**: `group` owns modules and inherited transforms, `part` is solid geometry (box / ellipsoid / cylinder / extrude), `layer` is fixed-view pixels. A part can bind one `appearanceOf` layer that changes color only while keeping the part's depth, normals, occlusion and outline.
2. **Orthographic rendering**: the scene camera is the single persistent delivery camera; rays are parallel, with no perspective. `beauty / silhouette / depth / normals / nodes` share the same geometry.
3. **Palette and lighting**: named palette colors and ramp-based materials map brightness to discrete shades, so the pixel style is controllable and reproducible.
4. **Outlines**: each node can enable a 1px inside/outside stroke inherited down the parent chain; outlines are image-space effects and do not change geometry.
5. **Model-first workflow**: new spatial documents first return an oblique, physical-only working view; the model checks structure, then paints, then renders the top-down delivery image. Reviewed export requires a non-delivery observation of the current structure, so a flat symbol cannot silently cover a spatial mistake.
6. **Themes**: `zpixel\_theme` stores versioned art-direction specs (palette, materials, outlines, lighting, rules). Scenes pin a revision, so theme updates never change old assets.
7. **Normal maps**: `zpixel\_normalmap` derives a sprite-local normal map from the same beauty hit buffer and reports diagnostics such as `sourceMode/relief/flatness`.

### Tools

|Tool|Purpose|
|-|-|
|`zpixel\_scene`|Create/edit scenes: nodes, geometry, anchors, relations, themes, migration, undo/redo|
|`zpixel\_render`|Delivery render or transient structural observation (camera / fit / isolate / physicalOnly)|
|`zpixel\_inspect`|Inspect tree, nodes, spatial relations, pixels, observation views, theme reports|
|`zpixel\_export`|Revision-addressed PNG + editable project + manifest (draft / reviewed)|
|`zpixel\_normalmap`|Sprite-local normal map (opengl / directx)|
|`zpixel\_theme`|Versioned theme library: add / read / list / revise|
|`zpixel\_guide`|Domain guides: overview / camera / observation / nodes / geometry / painting / lighting / theme / limits|

## Other

* Feedback QQ group: **1121399051**
* License: [MIT](LICENSE)
* Data lives under `.zpixel/` in the current session workspace, never in your home directory.
* Contributions: issues and PRs are welcome; please run `npm test` before submitting.

