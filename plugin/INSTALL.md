# ZPixel 独立插件安装教程

| 项目 | 值 |
|---|---|
| 包名 | `@dsh-external/dsh-zpixel` |
| 版本 | `0.5.3-dev`（当前最新） |
| 形态 | DSH 插件（Cordis bundle），安装后注册 7 个 `zpixel_*` 工具 |
| 运行时依赖 | 无第三方依赖；只需要 Node.js >= 22 |
| 不需要 | godot-master、Godot 引擎、Blender、浏览器渲染器 |

安装包是一个自包含的 `.tgz`：`src/`（领域实现）、`test/`（200 个测试）、`cordis.patch.yml`（bundle 声明）、`locale/`、`icon.png` 和文档全部在内。它不读取 godot-master 的任何文件。

---

## 1. 它能做什么

| 工具 | 作用 |
|---|---|
| `zpixel_scene` | 创建/编辑 Y-up 空间场景：group / part / layer、几何、锚点、关系图、主题绑定、迁移、undo/redo |
| `zpixel_render` | 精确网格正交渲染：beauty / silhouette / depth / normals / nodes；支持临时观察相机、fit、isolate、physicalOnly |
| `zpixel_inspect` | 查树、查节点、查世界几何、查关系判定、查像素/区域、查观察视图、查主题报告 |
| `zpixel_export` | 按 revision 导出透明 PNG + 可编辑 `project.zpixel.json` + 回执；draft / reviewed 两档 |
| `zpixel_normalmap` | 从同一份 beauty hit buffer 生成 sprite-local 法线图（opengl / directx） |
| `zpixel_theme` | 版本化视觉主题库：add / read / list / revise，可被场景按 revision 固定 |
| `zpixel_guide` | 领域指南：overview / camera / observation / nodes / geometry / anchors / spatial / painting / lighting / migration / normalmap / theme / tools / limits |

数据写在**当前会话工作区**的 `.zpixel/` 下，不写用户主目录。

---

## 2. 前置检查

在目标机器上逐条确认：

```bash
dsh --version          # 需要可用的 DSH CLI；本包按 0.1.7-rc.2 的 Host API 验证
node --version         # >= 22
pnpm --version         # dsh plugin 内部调用 pnpm
```

确认要装进哪个 profile：

```bash
# Windows cmd
dir "%USERPROFILE%\.dsh\profiles"
# Windows PowerShell
Get-ChildItem "$env:USERPROFILE\.dsh\profiles"
# macOS / Linux
ls ~/.dsh/profiles
```

常见值是 `web`（`dsh web` 网页端）或 `desktop`（桌面端）。下面统一用 `<profile>` 表示，示例用 `web`。

> 如果目标机还没有 profile，可以先建一个：`dsh --profile myprofile --from-default-profile web`，之后把下面的 `web` 换成 `myprofile`。

---

## 3. 安装

### 3.1 把 tgz 拷到目标机器

例如放到 `D:\plugins\dsh-external-dsh-zpixel-0.5.3-dev.tgz`。路径尽量不含空格；含空格时命令里加引号。

### 3.2 装进 profile

```bash
# Windows
dsh plugin --profile web add "D:\plugins\dsh-external-dsh-zpixel-0.5.3-dev.tgz"

# macOS / Linux
dsh plugin --profile web add /path/to/dsh-external-dsh-zpixel-0.5.3-dev.tgz
```

成功时 pnpm 会打印类似：

```text
+ @dsh-external/dsh-zpixel 0.5.3-dev
```

这一步只把包放进 `profiles/<profile>/node_modules/`，**还不会加载**。

> pnpm 会把 tgz 的绝对路径写进 profile 的 `dependencies`。安装完成后 tgz 可以移走，已安装的副本仍然可用；但下次升级或重新 `install` 前，要么保证该路径还在，要么直接用新 tgz 再 `add` 一次。

### 3.3 加入 bundles（必做）

DSH 只加载 `dsh.profile.bundles` 里列出的 bundle。编辑：

```text
Windows:        %USERPROFILE%\.dsh\profiles\web\package.json
macOS / Linux:  ~/.dsh/profiles/web/package.json
```

在 `dsh.profile.bundles` 数组末尾追加一项（`dependencies` 由 3.2 的 pnpm 自动写入，不需要手改）：

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "@dsh-external/dsh-zpixel"
    ],
    "patchReload": "live"
  }
}
```

> 只追加 `"@dsh-external/dsh-zpixel"`：不要删掉原来的条目，也不要重复添加。
>
> 如果你的 profile 原本没有 `dsh.profile.bundles`（少见），按上面的结构补一个。
>
> Windows 上不想手改 JSON，可以用 Node 一行追加（先确认 profile 名是 `web`）：
>
> ```bash
> node -e "const fs=require('fs'),p=process.env.USERPROFILE+'/.dsh/profiles/web/package.json',j=JSON.parse(fs.readFileSync(p,'utf8'));const b=j.dsh.profile.bundles;if(!b.includes('@dsh-external/dsh-zpixel'))b.push('@dsh-external/dsh-zpixel');fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
> ```

### 3.4 重启

完全退出当前 DSH（网页端停掉 `dsh web`，桌面端退出应用），再重新启动。插件在启动时装配，热重载不保证注册新工具。

---

## 4. 验证

### 4.1 工具是否注册

新开会话，让 agent 调用：

```js
zpixel_guide({topic:"overview"})
```

返回文本以 `ZPixel 0.5.3-dev builds a top-down asset...` 开头，说明 7 个工具已注册。

也可以直接看装配结果：

```bash
# macOS / Linux / Git Bash
dsh --profile web --dump-config | grep -n zpixel
# Windows PowerShell
dsh --profile web --dump-config | Select-String zpixel
```

应能看到 `id: zpixel` 与 `name: '@dsh-external/dsh-zpixel'`。

### 4.2 端到端冒烟

在任意**可写**工作区里：

```js
zpixel_scene({action:"create",document:"smoke",txid:"smoke-1",scene:{
  width:32,height:32,
  camera:{preset:"top_down",target:[0,1,0],pixelsPerUnit:8},
  nodes:[{id:"box",name:"Box",kind:"part",material:"wood",geometry:{type:"box",center:[0,1,0],size:[4,2,4]}}]
}})
zpixel_render({document:"smoke"})
```

预期：

- 第一次调用返回 `format:"dsh-zpixel/2"`、`revision:0`；
- 第二次调用返回一张 PNG 附件（32×32 原生尺寸的预览板）；
- 工作区出现 `.zpixel/documents/smoke.json`。

再导出一次：

```js
zpixel_export({document:"smoke",revision:0,draft:true})
```

预期生成 `.zpixel/exports/smoke-r0-v0.5.3-dev/`，里面有 `sprite.png`、`project.zpixel.json`、`draft.json`。

### 4.3 包内测试（可选，但推荐）

```bash
# Windows cmd
cd "%USERPROFILE%\.dsh\profiles\web\node_modules\@dsh-external\dsh-zpixel"
npm test

# Windows PowerShell
cd "$env:USERPROFILE\.dsh\profiles\web\node_modules\@dsh-external\dsh-zpixel"
npm test

# macOS / Linux
cd ~/.dsh/profiles/web/node_modules/@dsh-external/dsh-zpixel
npm test
```

预期 `200 pass / 0 fail`（约 4 秒）。测试只依赖 Node 内置模块，不需要 DSH 在运行。

---

## 5. 数据目录与权限

| 内容 | 位置 |
|---|---|
| 场景文档（含历史/undo） | `<workspace>/.zpixel/documents/<id>.json` |
| 导出 | `<workspace>/.zpixel/exports/<id>-r<rev>-<version>/` |
| 主题库 | `<workspace>/.zpixel/themes/` |

- 只读工作区只能 `open` / `render` / `inspect` / `guide`；写操作会返回 `READ_ONLY`。
- 写操作要求 `workspace-write` 或 `danger-full-access`，且输出必须落在会话工作区内。
- 不要手改 `.zpixel/documents` 里的 JSON；用 `zpixel_scene` 的 edit/undo/redo，revision 与 txid 会保护并发。

---

## 6. 升级

用同一条 `add` 命令装新 tgz 即可覆盖：

```bash
dsh plugin --profile web add "D:\plugins\dsh-external-dsh-zpixel-<new>.tgz"
```

然后重启。`bundles` 里的名字不变，不需要再改。

确认版本：

```js
zpixel_guide({topic:"limits"})
```

或看 `profiles/web/node_modules/@dsh-external/dsh-zpixel/package.json` 的 `version`。

---

## 7. 卸载

1. 从 `profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里删掉 `"@dsh-external/dsh-zpixel"`；
2. 执行：

   ```bash
   dsh plugin --profile web remove @dsh-external/dsh-zpixel
   ```

3. 重启。

已有的 `.zpixel/` 数据不会被删除。

---

## 8. 与 godot-master 共存

可以共存，互不冲突：

- godot-master 只注册一个 `godot` 工具，并通过 `@dsh-external/dsh-zpixel/capability` 调用**同一份**实现；
- 本插件注册的是 `zpixel_*` 七个工具；
- 两者读写的都是工作区里的 `.zpixel/`，文档格式一致。

唯一要避免的是**同一个包用两种方式装两次**（见 FAQ 第 1 条）。

---

## 9. 常见问题

**1) 启动报 `duplicate loader entry id: zpixel`**

同时用了两种启用方式：`dsh.profile.bundles` 和 `cordis.patch.yml` 里的 `insert`。二选一：

- 推荐：保留 `bundles` 里的条目，删掉 `cordis.patch.yml` 中 `id: zpixel` 的 insert；
- 或者反过来。

**2) 工具没出现**

按顺序检查：

1. `profiles/<profile>/node_modules/@dsh-external/dsh-zpixel` 是否存在；
2. `package.json` 的 `dsh.profile.bundles` 是否包含 `"@dsh-external/dsh-zpixel"`；
3. 是否完全重启（不是只刷新页面）；
4. `dsh --profile <profile> --dump-config | grep zpixel` 是否有输出。

**3) `pnpm: command not found`**

安装 pnpm 并确保在 PATH 中：`npm i -g pnpm`。

**4) 安装时报权限/EPERM**

换一个可写目录放 tgz；Windows 下避免把包放在受保护目录（如 `C:\Program Files`）。pnpm 的全局 store 需要可写。

**5) reviewed export 被拒绝：`VISUAL_INPUT_REQUIRED`**

reviewed 导出要求当前模型被 Host 证明具备图像输入能力。换一个支持图像的模型，或先用 `draft:true` 导出。draft 不受影响。

**6) 渲染图没有显示**

渲染结果通过 Host 的附件通道返回。若当前客户端不显示图片，检查模型/客户端是否支持图像；`zpixel_export` 仍会把 PNG 写到磁盘。

**7) 画布太大/太慢**

原生画布上限 256×256，`scale` 1..8。大场景请拆成多个 document，而不是放大画布。

---

## 10. 校验

- `CHECKSUMS.txt` 里有 tgz 的 SHA-256；Windows 可用 `certutil -hashfile <tgz> SHA256`，macOS/Linux 用 `shasum -a 256 <tgz>`。
- 包内文件清单：

```text
package.json  cordis.patch.yml  LICENSE  README.md  INSTALL.md
CAPABILITY.md  CONTRACT-0.3.md  THEMES.md  icon.png
locale/en.json  locale/zh.json
src/*.mjs（25 个）  test/*.mjs（25 个测试 + helpers + fixtures）
```

- 插件运行时不联网、不下载模型、不修改 profile 之外的任何文件；安装由 pnpm 完成，pnpm 自身的版本检查可能访问网络。