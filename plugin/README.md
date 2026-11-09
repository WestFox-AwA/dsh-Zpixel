# ZPixel 0.5.3-dev

> **Standalone install:** this package is a complete DSH plugin on its own — it registers the seven `zpixel_*` tools and does **not** require godot-master. See [INSTALL.md](INSTALL.md) for the install, upgrade and verification steps.

For embedded Hosts, import [`./capability`](CAPABILITY.md) and call `createCapability(ports, config)`; the standalone `.` entry keeps registering the seven native tools through the real Host adapter. The capability contract documents trusted requests, file policy, image content delivery, actor-scoped review evidence, and session cleanup.

Y-up spatial authoring and exact-grid rendering for top-down game assets. World coordinates are right-handed: +Y up, XZ ground, +X map-right. `semanticFrame` is optional and means actual authored facing; geometry axes remain local to their shape. There is no default asset front. 0.5.3-dev adds domain-owned interaction/execution metadata for embedded Hosts (`descriptor.interaction` and `capability.executionPolicy`) without changing the renderer or scene format. 0.5.1-dev added model-first observation: a transient orthographic camera, `fit`, `isolate`, `physicalOnly`, version pins and a non-delivery observation receipt bound to structure/content/view hashes. `scene.camera` remains the single persistent delivery camera. 0.4.0 added a versioned visual-theme library (`zpixel_theme`) and explicit scene theme binding: a theme stores visual language, reusable tokens, hard and advisory rules, limited adaptations, reference metadata and source evidence; it applies resources and defaults, never geometry or pixels. 0.3.6 added opt-in part-bound appearance layers: a leaf layer can recolor its direct parent part while the part keeps its geometry, depth, normals, shadows and outline. Format remains `dsh-zpixel/2`; existing documents need no conversion, and scenes without `appearanceOf` keep their previous pixels. The renderer remains 0.3.6; the package and service are 0.5.3-dev.

0.5.3-dev adds the interaction/execution metadata and moves the package and service to 0.5.3-dev while the renderer stays 0.3.6. 0.5.1-dev added model-first observation. 0.4.0 added the theme library; 0.3.6 added part-bound appearance; unbound scenes keep their old pixels. 0.3.5 added revision-bound contribution facts to preview and export manifests; 0.3.4 completed the public contract for common edits and list paging and documented outline inheritance and extrusion coordinates. Normal-map math remains unchanged from 0.3.3: `zpixel_render mode:"normals"` remains the world-space diagnostic and `zpixel_export` remains the beauty export.

## Choose the Representation

`group` is a reusable module and inherited transform; `part` is solid geometry for projection, occlusion, lighting, shadows and attachment; `layer` is authored pixels for fixed-view detail and has no volume. Tree ownership is assembly, not physical contact. A free layer keeps its own plane depth and normal: it inherits its parent's pose, not a curved surface beneath it. A bound appearance layer is different: it has no plane geometry of its own and uses the part's depth, normal, shadow and outline while supplying color. Part and layer can both be modular children, and a flat pixel array is a valid representation.

Choose by what the deliverable must show, not by across-view count: silhouette/occlusion/lighting/mating across views, or single-view depth/normals/shadows, call for solid parts; fixed-view color detail can be a free layer or a part-bound appearance layer. A single-view sprite may still need a part, and a multi-view sprite may be entirely flat. There is no representation declaration or gate. Confirm `spatialRelations` with `zpixel_inspect kind:"spatial"` after create or attach. Runnable starters live in `zpixel_guide` `overview`, with details in `nodes`, `geometry`, `anchors` and `spatial`; exact ramp/material fields are in `lighting`.

Extrusion maps profile `[s,t]` and range height `h` to local `P = u*s + v*t + n*h`, then applies node and parent transforms. `axis:"y"` gives `u:+X, v:-Z, n:+Y`; `axis:"x"` gives `u:+Z, v:-Y, n:+X`; arbitrary axes use a normalized axis plus a projected seed, detailed in `zpixel_guide topic:"geometry"`. Changing axis does not preserve profile roll; use a fixed local axis plus a node transform for stable roll.

## Quick Start

The executable generic example is `topDownAssetScene()` in [examples.mjs](src/examples.mjs). It includes a wall and gate with hinge anchors, a trunk/canopy, rock, directional marker, and painted ground. It stores a scene-level relation graph and returns measured geometry evidence separately. In PTC/`run_code`, invoke it as `await tools.zpixel_scene(...)` and return the result; native routes call the tool directly.

```js
zpixel_scene({action:"create",document:"yard",txid:"yard-create",scene:{
  width:64,height:64,
  camera:{preset:"top_down",target:[-2,1,0],pixelsPerUnit:4},
  nodes:[
    {id:"yard",name:"Yard",kind:"group"},
    {id:"wall",name:"Wall",kind:"part",parent:"yard",geometry:{type:"box",min:[-4,0,-.75],max:[4,2,.75]},anchors:{hinge:{point:[-4,1,0],normal:[-1,0,0],tangent:[0,1,0],axis:[0,1,0]}}},
    {id:"gate",name:"Gate",kind:"part",parent:"yard",material:"wood",geometry:{type:"box",min:[-8,0,-.6],max:[-4,2,.6]},anchors:{hinge:{point:[-4,1,0],normal:[1,0,0],tangent:[0,1,0],axis:[0,1,0]}}}
  ],
  spatialRelations:[{id:"gate-hinge",from:{node:"gate",anchor:"hinge"},relation:"coaxial",to:{node:"wall",anchor:"hinge"},angleTolerance:2,distanceTolerance:.02}]
}})
```

Inspect actual world geometry and authored intent separately:

```js
zpixel_inspect({document:"yard",kind:"spatial",node:"gate",other:"wall"})
```

## Model-First Observation

The default order is blockout -> non-delivery observation -> appearance -> delivery. `scene.camera` is the single persistent delivery camera; changing it is a scene edit. Observation uses a transient camera that exists only in the `zpixel_render` or `zpixel_inspect` request: it is never stored, never changes revision and never replaces `scene.camera`. Projection is always orthographic; `three_quarter` and every oblique eye are parallel-ray views, not perspective. There is no perspective, orbit editor or fov.

`zpixel_render` and `zpixel_inspect` accept these optional fields:

- `camera` — the existing scene camera shape: `{preset:"top_down"|"three_quarter"}` or `{position,target,up,mirrorX?,pixelsPerUnit?,center?}`. The camera is transient and orthographic.
- `fit` — boolean; defaults true when `camera` is supplied. Fit re-centers the view target and eye on the observed bounds while preserving the supplied direction, then adjusts `pixelsPerUnit`/`center`; `fit:false` uses the camera exactly. `fit` without `camera` rejects.
- `isolate` — a node ID; observe only that subtree and hide nodes outside it. World transforms and the camera are unchanged. Source visibility is preserved, so hidden nodes stay hidden and isolate does not force descendants visible; a hidden target or hidden ancestor rejects. A bound appearance layer must be isolated via its owner part, and a target with a visible physical ancestor that would remain as an occluder is rejected.
- `physicalOnly` — boolean; suppress layer color/alpha, not inherited visibility, so solid parts (including solid descendants of a layer parent), groups and their outlines remain. Combine with `mode:"normals"`, `"depth"` or `"nodes"`.
- `expectedRevision` / `expectedHash` — pin the observed revision or content hash; a mismatch rejects and observation never writes. In `zpixel_inspect` the pins apply to every kind; `camera`/`fit`/`isolate`/`physicalOnly` are valid only for `view`/`pixel`/`region`/`spatial`.

Observation is non-delivery. A render with `camera`, `isolate` or `physicalOnly` returns `delivery:false` and `observation`, `view` and `authoring` receipts; a supplied camera is always an observation even when it matches `scene.camera`, and only a call without those fields stays the delivery preview. `view` reports the resolved camera, mode, physicalOnly, isolate, fit, delivery, deliveryAngleDegrees, separationDegrees, wholeScene and partPixels; `authoring` reports contract, structureHash, contentHash, observation (`valid`/`stale`/`none`) and deliveryPreview (`current`/`none`). `zpixel_inspect kind:"view"` follows the render preview path: with observation fields it is a non-delivery observation, without them it is the delivery preview. `pixel`, `region` and `spatial` use the same camera and `physicalOnly` when supplied, so the image and the probe agree.

Fresh creates default to contract `model-first/1`; a format-2 snapshot with revision and no contract preserves the imported legacy absence, and explicit `contract:"model-first/1"` roundtrips a model-first snapshot. On a new spatial document, `zpixel_scene preview:true` returns a fitted non-delivery `physicalOnly` working view with `preview.workingView:true` and an observation receipt. It is not the final delivery preview. A working-view failure returns `previewError` (`NO_VISIBLE_STRUCTURE` or `WORKING_VIEW_FAILED`) and does not fall back to delivery. Flat-only and legacy documents keep the existing preview. Call `zpixel_render` without observation overrides for final delivery beauty.

The receipt is `observation:{id,document,revision,structureHash,contentHash,viewHash,camera,mode,physicalOnly,isolate,renderer,deliveredTo}`; top-level `observationId` is an optional alias of `observation.id`. `structureHash` covers canvas size, `scene.camera` and each node's id/kind/parent/visible/castShadow/transform/geometry/basis/appearanceOf/semanticFrame/anchors in normalized order. For a free layer it also covers width/height/pixelSize and binary occupancy (null vs non-null), so RGB-only paint keeps the hash stable while a null/non-null change invalidates the observation; a bound appearance layer's pixels/width/height/pixelSize/appearanceShading are excluded. It excludes palette, ramps, materials, lights, ambient/exposure, names/roles/tags/locked/material/outline, spatialRelations, theme, title, document id and revision. `contentHash` is the full stored-scene fingerprint including revision. `viewHash` covers the normalized camera, mode, isolate and physicalOnly. A receipt records what was observed, not geometric approval.

A new spatial document (at least one part) needs a delivered whole-scene observation at the current `structureHash` before a reviewed beauty export; the reviewed export also needs a current delivery beauty preview from an explicit render without overrides, and the working view does not count as one. The observation must be non-delivery, must not use `isolate`, must show at least one solid part pixel, and its view direction must be at least 20 degrees from the delivery viewing axis (parallel and antiparallel do not count; raw `deliveryAngleDegrees` must be 20..160). An isolated or zoom-only observation is insufficient. The gate status is `observed`, `not-observed`, `flat-only-exempt`, `legacy-none` or `waived`. Draft export stays free. Flat-only documents (no parts) and legacy documents are exempt. `structureReview:{waived:true,reason:"..."}` is a narrow recorded waiver for a reviewed export; the reason is 3-360 characters, and it is recorded as `waived`, never as pass, and never bypasses theme rules or the visual review. `zpixel_normalmap` reports `observation.countsAsObservation:false` and cannot satisfy the gate. A reviewed export returns `structureHash`, `spatial`, `observation`, `camera` and records the waiver in the manifest.

`paint is a property of a surface, not an object.` A bound appearance layer changes where color lands, not what the object is: a wheel painted on a track top, or a muzzle face painted on a horizontal top, can be bound correctly and still be semantically wrong. Model and observe the solid when the mark represents a physical part; paint its surface color, wear, markings and fixed-view detail.

```js
zpixel_render({document:"yard",mode:"normals",camera:{preset:"three_quarter"},physicalOnly:true})
zpixel_render({document:"yard",mode:"depth",camera:{position:[8,6,8],target:[0,1,0],up:[0,1,0]},fit:false,physicalOnly:true,isolate:"gate",expectedRevision:3})
zpixel_inspect({document:"yard",kind:"view",camera:{preset:"three_quarter"},physicalOnly:true})
zpixel_export({document:"yard",revision:3,draft:false,review:{identity:true,nativeReadable:true,lighting:true,note:"Gate and wall read at 64 px; hinge clearance is visible."}})
zpixel_export({document:"yard",revision:3,draft:false,structureReview:{waived:true,reason:"Structure was reviewed in an earlier session; this export only rechecks the current paint."},review:{identity:true,nativeReadable:true,lighting:true,note:"Gate and wall read at 64 px; hinge clearance is visible."}})
```

## Themes

A theme is a versioned visual production spec, not a palette dump, adjective prompt or generator. `zpixel_theme` has four actions: `add` and `revise` save a complete spec and return compact identity plus hash and capabilities; `read` returns a working pack (identity, signature, all applicable hard rules, tokens, capabilities, review checklist) and never claims pass without a scene; `list` returns summaries. Revisions are immutable and the hash is bare SHA-256 of canonical sorted-key JSON.

Bind a pinned revision with the outer `theme` parameter of `zpixel_scene`. On create, `applyDefaults` defaults true and the theme resolves before scene validation, merging namespaced resources plus lights/ambient/exposure/camera/root outline/default material; explicit scene fields win, and initial nodes may reference namespaced palette/material IDs. On edit, `applyDefaults` defaults false: namespaced resources and only the listed node bindings apply, and global defaults require `applyDefaults:true`; the result reports `theme_changes` with `defaultsApplied`, `resources`, `preservedExplicit`, `retainedResources`, `removedLights`, `globalFields` and `nodeBindings`. Explicit initial palette/ramp/material entries that collide with theme resource IDs are preserved on create and listed in `preservedExplicit`. Theme resource application is additive: existing theme-namespaced palette/ramps/materials are never removed automatically; on edit or replace, old entries are retained and reported in `retainedResources`, and scene limits apply. `theme:null` detaches metadata only. The scene stores the canonical snapshot, context and overrides, so rendering and export survive a missing theme store; the snapshot is reproducibility data, not a review or compliance pass.

```js
zpixel_scene({action:"create",document:"crate",txid:"crate-create",theme:{id:"soft-workshop",revision:0,context:{assetClass:"prop",nativeSize:[32,32],view:"top_down"}},scene:{width:32,height:32,nodes:[{id:"crate",kind:"part",geometry:{type:"box",center:[0,1,0],size:[4,2,4]}},{id:"crate-label",kind:"layer",parent:"crate",appearanceOf:"crate",width:4,height:4,pixelSize:1,basis:{u:[1,0,0],v:[0,0,-1]},castShadow:false,outline:{enabled:false},pixels:[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]}]}})
zpixel_scene({action:"edit",document:"crate",revision:0,txid:"crate-theme-bind",theme:{id:"soft-workshop",revision:0,bindings:[{node:"crate",material:"wood",outline:true},{node:"crate-label",appearanceShading:true}]}})
zpixel_inspect({document:"crate",kind:"theme"})
```

`inspect kind:"theme"` returns `{document,revision,theme_report}`; preview and export share it. Mechanical checks scan the final beauty RGBA and effective configuration; visual rules stay `needs_review`; `should` is advisory; overrides are `waived` with deviations preserved; `blocked` is true for a non-waived `must`/`must_not` mechanical failure or a required unsupported feature. There is no aesthetic score or part-count gate. A closed palette is only honestly hard when the output path is unlit/flat: lit ramps interpolate and can leave the token set; use unlit appearance and check final RGBA, or record the deviation.

The complete executable definition, reference/concept authoring, evidence discipline, unsupported-token behavior and revision/export sequences are in [THEMES.md](THEMES.md) and `zpixel_guide topic:"theme"`.

## Part-Bound Appearance

A layer can opt into recoloring a solid part without adding a second surface: set `appearanceOf:"part-id"` on a layer whose direct parent is that part. The layer must be a leaf, carry no anchors, `castShadow:false` and `outline.enabled:false`; contradictory `true` values are rejected, not silently ignored. A part may have at most one bound layer, including hidden ones. Binding is explicit — position or name never implies it. All references and fields are validated atomically with the final scene.

A bound layer has no geometry instance, physical bounds, support/samples, shadow or outline of its own. The nearest physical surface is chosen first; appearance never occludes a foreground object. After a part hit, the renderer converts the world hit through the bound layer's world inverse, then samples `u=dot(local,basis.u)/pixelSize` and `v=dot(local,basis.v)/pixelSize`, ignoring the perpendicular coordinate. Sampling is nearest with the existing edge convention. Outside the layer extent or a null pixel keeps the part's old shading byte-for-byte. Projection is an object-space planar projector: it follows the part transform and samples the stored local basis, independent of screen/camera space; it may repeat on opposite or grazing faces. It is not a UV/decal system, and there is no camera hash or per-face mapping.

`appearanceShading:"lit"` (default) scales the sampled pixel by the part material brightness `clamp(pow((ambient + direct*diffuse + emission)*exposure, ramp.response),0,1)`; the part's lambert/shadow loop is unchanged. `"unlit"` uses the sampled pixel as final color, but geometry still supplies position, depth, normal, shadow observations and outline. Lit output may contain shaded colors outside the authored palette; unlit keeps the sampled RGB exactly. There is no new reflection/roughness/albedo output channel. `appearanceShading` is invalid on a free layer.

```js
zpixel_scene({action:"create",document:"crate",txid:"crate-create",scene:{
  width:32,height:32,
  camera:{preset:"top_down",target:[0,1,0],pixelsPerUnit:8},
  nodes:[
    {id:"crate",name:"Crate",kind:"part",material:"wood",geometry:{type:"box",center:[0,1,0],size:[4,2,4]}},
    {id:"crate-label",name:"Crate label",kind:"layer",parent:"crate",appearanceOf:"crate",appearanceShading:"lit",width:4,height:4,pixelSize:1,basis:{u:[1,0,0],v:[0,0,-1]},transform:{position:[-2,2,2]},castShadow:false,outline:{enabled:false},pixels:[null,"white","white",null,"white",null,null,"white","white",null,null,"white",null,"white","white",null]}
  ]
},preview:true})
```

Change shading, unbind or rebind with the revision you observed:

```js
zpixel_scene({action:"edit",document:"crate",revision:0,txid:"crate-label-unlit",ops:[{op:"node_set",id:"crate-label",values:{appearanceShading:"unlit"}}]})
zpixel_scene({action:"edit",document:"crate",revision:1,txid:"crate-label-unbind",ops:[{op:"node_set",id:"crate-label",values:{appearanceOf:null}}]})
zpixel_scene({action:"edit",document:"crate",revision:2,txid:"crate-label-rebind",ops:[{op:"node_set",id:"crate-label",values:{appearanceOf:"crate",appearanceShading:"lit"}}]})
```

`appearanceOf:null` unbinds and removes `appearanceShading`; the layer returns to a normal free layer with its existing transform, basis and pixels. `paint` still edits the bound layer's pixels and never changes the part silhouette. Moving, hiding, locking or deleting the part carries the bound layer with it; duplicating a part subtree remaps `appearanceOf` to the duplicated owner, while duplicating the bound layer alone under the same owner fails uniqueness.

A hit keeps `nodeId` of the part. Only pixels whose final color came from the bound layer add `appearanceNodeId`, `appearancePixel:[x,y]` and `appearanceShading`; these are provenance, not ownership. Geometry inside/outside outline pixels clear those fields where the outline replaces color. Contribution counts the physical hit owner (part); a separate `contribution.appearances` report lists each bound layer's sampled visible pixels and a total `appearancePixels`, and `zeroVisible.layers` lists physical free layers only. Scenes without `appearanceOf` keep the old flat-layer path and old pixels.

## Edit Locally

Find or inspect the node you need, change only that subtree, then render:

```js
zpixel_scene({action:"edit",document:"yard",revision:0,txid:"yard-gate-move",ops:[
  {op:"transform",id:"gate",translate:[1,0,0]}
]})
```

Common edit shapes:

- `transform` — `{id,translate?,rotate?,scale?,space?}`; omitted components stay unchanged, `rotate` is XYZ degrees, `space` is `"parent"` (default) or `"local"`.
- `node_set` — `{id,values:{...}}`; `values` is a partial node, but each supplied field replaces that field wholesale (no deep merge). `values.pixels` replaces a whole layer row-major.
- `paint` — `{id,ops:[...]}` with inner `rect`, `line`, `pixels` or `clear`; it edits regions of one layer.
- `palette_set` — `{id,color:"#RRGGBB"}`.

Sparse `[x,y,color]`, rectangular `x/y/w/h` plus `w*h` colors, and whole-array replacement are distinct forms; `points` remains the legacy alias for sparse pixels. One edit call can combine operations: the batch is atomic and retains revision/txid protection.

## Outlines

`outline:{enabled,color,direction,width,group,occlusion}` is an image-space effect, not geometry. Root defaults to enabled, `ink`, `inside`, width 1. A node without an explicit outline inherits the parent chain; layer creation defaults `enabled:false`, and descendants inherit that until they set it themselves. `width` is always 1. `group` is a legacy stored field with no union behavior; `occlusion:false` is legacy and does not suppress part boundaries — use `enabled:false` to disable an outline. Outline controls do not change physical mating; do not add a general one-pixel overlap just to control line appearance. A bound appearance layer cannot enable its own outline: it has no outline of its own, and outline pixels that replace color clear appearance provenance.

## Placement

Anchors use local geometry coordinates: `{point,normal?,tangent?,axis?}`. They do not persist as constraints. `node_attach` changes one transform atomically and can be undone:

- `mode:"translate"` aligns points without rotation.
- `mode:"frame"` requires normal+tangent on both anchors and determines a full rigid alignment.
- `mode:"normal"` aligns normals and requires `rollPolicy:"align_tangent"` with both tangents, or `"preserve_source"` for the shortest-arc rotation.

Point+normal alone does not determine roll. Underdetermined requests fail. A nonzero gap requires an explicit target normal.

## Relation Evidence

`spatialRelations` is a scene-level graph of stable-ID edges: `contact`, `support`, `avoid_intersection`, `allow_overlap`, and `coaxial`. It is authored intent, not measurement. `allow_overlap` waives only an avoidance intent for that pair; the intersecting geometry remains visible in observations. Box SAT is exact within tolerance; sampled shapes return a witness or `unresolved`, never a separation claim from a sampling miss. Painted layers are surfaces, not solids. Bound appearance layers have no physical bounds, support or samples, so spatial queries ignore them; the part remains the solid. Camera visibility is reported separately from world-space relations.

Nodes form the ownership/transform tree (`group`, `part`, `layer`). A single world compiler provides transforms, bounds, anchors, and geometry instances to rendering, shadows, spatial queries, and placement. Camera motion does not change model transforms or world-space lights.

## Migration and Existing Capabilities

Format2 is the only live coordinate system. Format1 projects require explicit migration to a new document ID:

```js
zpixel_scene({action:"migrate",document:"yard-yup",source_document:"yard-old",txid:"yard-copy"})
```

Migration applies `[x,y,z] -> [x,z,-y]` and `C*M*C^-1` to transforms, lights, cameras, primitives and layer bases. It does not alter the source project, history or exports. Legacy semantic facing stays unknown.

Format remains `dsh-zpixel/2`. `appearanceOf` and `appearanceShading` are additive 0.3.6 fields; existing documents need no conversion. Older ZPixel engines validate unknown node fields strictly and reject them rather than flattening, so a document using these fields requires 0.3.6.

`action:"list"` pages an alphabetical catalog of existing user documents: `offset` defaults to 0, `limit` is 1–50 and defaults to 50, and the response carries `nextOffset`. It is a document catalog, not a set of recommended examples and not permission to reuse another project's assets.

Atomic edits retain revision checks, txid replay safety, undo/redo and version-addressed exports. Inside/outside one-pixel outlines remain image-space effects. Draft transparent PNG and editable scene JSON are supported; reviewed export requires a current preview, image-capable route and an honest review note.

## Sprite Normal Maps

`zpixel_normalmap` derives a sprite-local normal map from the same beauty hit buffer as the sprite — same document, revision and `scene.camera`; it does not accept a transient observation camera. Its alpha matches the beauty sprite, including the one-pixel inside/outside outlines. Preview is always available; `export:true` additionally writes native `normal.png`, the same-source `sprite.png`, `project.zpixel.json` and `normalmap.json` into a separate convention-tagged `v0.5.3-dev-normalmap-<convention>` generation. Normal-map math is unchanged from 0.3.3; the renderer is 0.3.6, the package and service are 0.5.3-dev, and scenes without `appearanceOf` keep their previous pixels. `zpixel_guide({topic:"normalmap"})` carries the tool-facing rules.

```js
zpixel_normalmap({document:"yard",convention:"opengl"})
zpixel_normalmap({document:"yard",revision:1,convention:"directx",scale:4,export:true})
```

Encoding is sprite/view basis: R is sprite-right, G is sprite-up for `opengl` or sprite-down for `directx`, B points toward the camera. RGB is `round((n*0.5+0.5)*255)`, so neutral is `128,128,255`; camera orientation and `mirrorX` are baked in, so mirroring flips R. Treat the PNG as linear, non-color data: do not sRGB-decode it, do not antialias it, and use nearest filtering for the pixel map.

Solid parts contribute the actual inverse-transformed geometry normal. A free painted layer contributes the visible face normal of its authored plane; pixels are not a height field, so a fully painted sprite yields one flat normal, not recovered 3D shape, hull or bumps. A part-bound appearance layer changes beauty color only: the normal map still uses the part's geometry normal, not a normal derived from sampled pixels; appearance adds no relief, tangent-space detail or new normal channel. Unlit appearance also leaves depth, normal and shadow observations on the part. Inner outline pixels reuse the source face; generated outer outline pixels get the neutral view normal. Both conventions are generated; no game engine's convention or import behavior is asserted. This is a 2D sprite normal for 2D lighting, not a mesh tangent frame. `zpixel_render mode:"normals"` remains the world-space diagnostic and `zpixel_export` remains the beauty export.

Arguments are strict: only `document`, `revision`, `convention`, `scale` and `export` are accepted; any other field fails with `UNSUPPORTED_FIELD` instead of being ignored, because there is no strength, height, blur, edge or normal-source parameter. Every result also carries `diagnostics` — `sourceMode:"geometry"`, `relief:"none"`, `representation`, `camera.view`, `visiblePixels`, `surfacePixels`, `layerPixels`, `uniqueColorCount` (the full count, not the 32-color preview list), `dominantColor`, `dominantShare`, `neutralEncodedShare`, `flatness` and `warnings` — which describe the encoded image without changing pixels. `neutralEncodedShare` counts pixels encoded as exactly `128,128,255`; it is not `fallbackCounts.neutralPixels`, which counts only outside-outline and degenerate fallbacks and can be 0 on a fully neutral image. `flatness` is `flat` (one encoded color), `near-flat` (dominant share at least 0.9), `varied`, or `empty`.

The beauty sprite still contains baked light and shadow. Using that color with the normal map and dynamic lighting can double-light the asset. ZPixel does not unlight the sprite or generate an unlit albedo; correct use depends on your engine material. `normalmap.json` records technical version, hash and camera metadata, not an aesthetic certification. No Godot import was tested, and engine import settings are not modified.

Run the full check suite with `npm test`. See [CONTRACT-0.3.md](CONTRACT-0.3.md) for the spatial data model, observation contract and theme contract, [THEMES.md](THEMES.md) for the theme reference, and [VERIFICATION-0.5.1-dev.md](VERIFICATION-0.5.1-dev.md) for the 0.5.1-dev verification record (0.5.3-dev adds metadata only); [VERIFICATION-0.4.0.md](VERIFICATION-0.4.0.md) and [VERIFICATION-0.3.6.md](VERIFICATION-0.3.6.md), [VERIFICATION-0.3.5.md](VERIFICATION-0.3.5.md), [VERIFICATION-0.3.3.md](VERIFICATION-0.3.3.md), [VERIFICATION-0.3.2.md](VERIFICATION-0.3.2.md) and [VERIFICATION-0.3.md](VERIFICATION-0.3.md) remain historical records.
