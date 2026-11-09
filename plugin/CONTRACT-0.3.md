# ZPixel Spatial Architecture Contract

**Release:** 0.5.3-dev. Format remains `dsh-zpixel/2`; the package and service are 0.5.3-dev and the renderer remains 0.3.6. 0.5.3-dev adds the embeddable interaction/execution metadata; the scene, theme and observation semantics are unchanged. This file keeps its historical name for link stability; it is the current architecture contract.

**Decision status:** architecture contract for the 0.3 redesign. It replaces implementation-shaped notes. The package is not install-ready until implementation, schemas, guides and tests all follow this model. Do not patch isolated fields around the old representation.

## Product Scope

ZPixel is a model-facing authoring system for top-down game assets broadly: built structures, natural props, directional objects, compounds, and painted ground surfaces. A vehicle is one optional compound, not the organizing domain model. The system describes editable spatial assets and rasterized views; it is not a physics solver or an aesthetic certification system.

Retain the seven native tools, including `zpixel_normalmap` and `zpixel_theme`, atomic revision/txid store, undo/redo, explicit one-time legacy migration, palette/ramp renderer, per-part inside/outside outlines, opt-in part-bound appearance layers, and the versioned theme library with explicit scene binding. Do not add unrelated UI, continuous simulation, CSG or engine import scope.

## Coordinate Spaces

Exactly one world convention is persisted in new scenes:

- Right-handed; +Y is world up.
- Ground is XZ; +X is canonical map-right.
- The canonical top-down view looks along the Y axis. Standard presets use +X screen-right and -Z screen-up. Custom camera bases are explicit and never relabel world axes.
- Camera and light changes never mutate model transforms. Screen pixels, local geometry coordinates, and world coordinates are distinct spaces.

An asset has no implied front. Numeric coordinate defaults may be used inside calculations, but missing semantic facing is unknown, not a guessed +Z/-Z direction.

Legacy format1 is accepted only by explicit migration to a new document ID. Its proper basis conversion is C(x,y,z)=(x,z,-y), determinant +1; affine transforms use C*M*C^-1. Convert geometry, transforms, lights, camera, normals, and painted bases as one operation. Legacy semantic facing was not authored and remains absent/unknown. A legacy view-painted layer freezes to an explicit basis. Never rewrite the source document, history, export or sidecar.

## One Authoring Model

The ownership tree is not the spatial relationship graph. Keep those responsibilities separate.

A node has stable ID, readable name, optional descriptive role/tags, parent, visibility/lock, one local transform, and exactly one content kind:

- `group`: owns child transforms; has no render geometry unless represented by children.
- `part`: owns one solid geometry, material, and optional image-space outline.
- `layer`: owns a finite painted surface with an explicit local basis and row-major pixels; it is not a solid volume. A layer may opt into part-bound appearance with `appearanceOf` (see below); it remains a layer, not a solid.

A node may optionally declare `semanticFrame:{forward,up}`. Omission means the semantic directions are unknown. There is no persisted `frameDeclared` flag and no default semantic forward. `transform` is the only persistent pose. Friendly orientation inputs may be accepted at the tool boundary only if compiled into `transform` immediately and not retained as a second pose representation.

Geometry is local to its node. Shape direction belongs to geometry, not to a node's semantic frame:

- box: bounds or center/size;
- ellipsoid: center/radii;
- cylinder: radius plus explicit local axis/length or explicit local endpoints;
- extrusion: planar profile, range, and explicit axis.

Canonical stored geometry has resolved vectors and dimensions. Endpoint shorthand compiles to center, unit axis and length. `height` is not an alternate cylinder field. Composite objects use ordinary groups and parts; the format is not vehicle-aware. Ground paint uses an explicit surface basis. Curved decals, holes, and implicit volume from a layer are not inferred.

## Part-Bound Appearance (0.3.6)

The format remains `dsh-zpixel/2`. `appearanceOf` is an additive, opt-in layer field: a layer with `appearanceOf:"part-id"` is the part's appearance layer rather than a free painted surface. The binding is explicit; position, names, or tree adjacency never imply it. `appearanceShading` is optional `"lit"` or `"unlit"` and is valid only on a bound layer; `"lit"` is the default when bound. Both fields require 0.3.6; older engines validate unknown node fields strictly and reject them rather than flattening them. Existing documents need no conversion, and a scene without `appearanceOf` keeps the old flat-layer path and its previous pixels.

Binding invariants, validated atomically at final scene validation:

- The bound layer is a direct child of the part: `layer.parent === layer.appearanceOf`.
- The layer is a leaf and carries no anchors.
- `castShadow` is false and `outline.enabled` is false; contradictory `true` values are rejected, not ignored.
- At most one bound layer per part, including hidden layers.
- `appearanceShading` is invalid on a free layer.

`node_set` with `values.appearanceOf:null` unbinds and removes `appearanceShading`, restoring a normal free layer with its existing transform, basis and pixels. Moving, hiding, locking or deleting the part carries the bound layer with it. Duplicating a part subtree remaps `appearanceOf` to the duplicated owner; duplicating the bound layer alone under the same owner fails the uniqueness rule.

A bound layer has no geometry instance, physical bounds, support or samples, shadow or outline of its own. The nearest physical surface is selected before color selection, so appearance never occludes a foreground object or adds depth. After a part hit, the renderer transforms the world hit position through the bound layer's world inverse, then computes `u=dot(local,basis.u)/pixelSize` and `v=dot(local,basis.v)/pixelSize`; the perpendicular coordinate is ignored. Sampling is nearest with the existing edge convention. Outside the finite layer extent or a null pixel falls back to the part's original material ramp and old shading byte-for-byte. Projection is an object-space planar projector: it follows the part transform and samples the stored local basis, independent of screen/camera space, and may repeat on opposite or grazing faces. There is no UV/decal system, per-face mapping, wrapping rule, or camera hash.

Lit appearance scales the sampled pixel by the target part's material brightness `clamp(pow((ambient + direct*diffuse + emission)*exposure, ramp.response),0,1)`; the part's lambert/shadow loop is unchanged. Lit output may contain shaded colors outside the authored palette. Unlit appearance uses the sampled pixel as final color and keeps the sampled RGB exactly, but the part still supplies position, depth, normal, shadow observations and outline. There is no new reflection, roughness or albedo output channel, and the bound layer casts no shadow of its own. Normal maps and `zpixel_render mode:"normals"` continue to use the part's geometry normal; appearance pixels add no relief or tangent-space detail.

The returned hit keeps `nodeId` of the part. Only pixels whose final color came from the bound layer add `appearanceNodeId`, `appearancePixel:[x,y]` and `appearanceShading`; these fields are provenance, not ownership. Geometry inside/outside outline pixels clear them where the outline replaces color. `contribution.pixelsByKind` counts the physical hit owner (the part). A separate `contribution.appearances` report lists each bound layer's sampled visible pixels and a total `appearancePixels`; `zeroVisible.layers` lists physical free layers only. Scenes without `appearanceOf` keep the old flat-layer behavior.

## Theme System (0.4.0)

A theme is a versioned visual production spec, not a palette dump, adjective prompt or geometry generator. It stores visual language, reusable tokens, hard and advisory rules, limited adaptations, reference metadata and source evidence. It never generates geometry, paints pixels, chooses parts or replaces modeling. One scene binds at most one theme; there is no subtree, multi-theme or inheritance engine.

Canonical Theme: `{format:'dsh-zpixel-theme/1',id,revision,title,summary,tags,signature,language,tokens,rules,adaptations,references,source}`. `add` assigns format/id/revision 0; the author spec omits them, requires title/summary and defaults other sections empty. `language` sections are identity/view/scale/form/pixel/color/outline/light/materials/detail, each one authored string; omitted means unspecified. `signature` contains existing rule IDs, never a second copy of rule text. The hash is bare SHA-256 hex64 of stable sorted-key canonical JSON, never an author field. Revisions are immutable; `revise` takes `expected_revision` and a complete replacement spec. The same `txid` retry returns its fixed applied revision; a changed payload under the same `txid` errors.

Tokens: colors `{value,role?,usage?}`; ramps `{response?,stops:[{at,color}]}` with response default 1 and strictly ascending stops; materials `{ramp,diffuse?,emission?,specular?,roughness?}`; `defaultMaterial`; `outline`; `lights`; `ambient`; `exposure`; `camera`; `appearanceShading`. Omitted token directives are unspecified; `lights:[]` is explicit no lights. Light `frame` is world or view; view directions compile through the actual scene camera basis, with the canonical top_down camera used and disclosed when no actual camera is supplied. Point position is world only in v1.

Rules: `{id,strength:must|should|must_not,statement,scope?,check?}`. Scope minSize/maxSize refer to `max(scene.width,scene.height)`. Known checks: palette, color_count, binary_alpha, padding, canvas, outline, camera, light_count, appearance_shading, visual, unsupported. Unknown or malformed kinds and conditional fields reject. No check or a visual check means needs_review. `must_not` inverts a mechanical predicate; `should` is advisory and never blocks. Adaptations may change language only for an asset class or size band; they never override tokens or hard rules. References are metadata only: workspace-relative image path (delivery supports PNG/JPEG/WebP/GIF), optional bare hex64 sha256, role, note, crop, observations and inferences. No image bytes, no path escape, no automatic inference or copy. Source records kind concept/reference/hybrid plus brief, observations, inferences, decisions and unknowns; the model authors analysis and the service never calls another model.

Store: `.zpixel/themes/<id>.json` envelope with revisions and receipts, atomic/lock patterns, case-insensitive ID reservation, no document history prune, and no assets touched. `addTheme`, `reviseTheme`, `readTheme` and `listThemes` follow the shared module contract.

Runtime: `compileTheme(theme,context)` returns `{defaults,capabilities,namespace}` with resource IDs prefixed `theme.<id>.<key>`; it never mutates geometry or pixels. `readThemePack` returns a working pack with identity, brief, signature, all applicable or undecidable hard rules, tokens/bindings, capabilities, review checklist and references/source; it never claims pass without a scene. `themeReport(scene,image)` returns null without `scene.theme`, otherwise checks from the actual beauty RGBA including outlines with statuses pass/fail/needs_review/unsupported/not_applicable/waived. Mechanical status is pass/fail/pending; visual rules stay needs_review or not_required. Overrides are waived with deviations preserved. `blocked` is true for a non-waived must/must_not mechanical failure or a required unsupported feature; visual rules never block. No score and no part-count gate.

Scene binding: the outer `theme` parameter of `zpixel_scene` is `{id,revision,hash?,context?,applyDefaults?,bindings?,overwrite?,replace?,overrides?}` or null. `id` and `revision` are required; `hash` is optional and must match the stored revision. Create resolves the theme before scene validation, defaults `applyDefaults:true`, and merges namespaced resources plus lights/ambient/exposure/camera/root outline/default material; explicit initial scene fields win, so initial nodes may reference namespaced IDs; it does not construct nodes, paint pixels or force geometry. Edit defaults false and always merges namespaced resources plus only the listed node bindings; global defaults apply only when `applyDefaults:true`; the result reports `theme_changes` (defaultsApplied; resources `{palette,ramps,materials,lights}`; preservedExplicit/retainedResources `{palette,ramps,materials}`; removedLights; globalFields; nodeBindings; metadataOnly/detached for theme:null). Explicit initial palette/ramp/material entries that collide with theme resource IDs are preserved on create and listed in preservedExplicit. Resource application is additive: existing theme-namespaced palette/ramps/materials are never removed automatically; on edit or replace, entries from the previous theme namespace absent from the new revision are retained and listed in retainedResources, older entries may remain, and scene limits apply. A material binding names a theme material key. `outline:true` applies the token and false explicitly disables the target outline; `appearanceShading:true` applies the token and false leaves it unchanged. Colliding same-namespace resources error unless `overwrite:true`; a different current pin errors unless `replace:true`. `theme:null` on edit detaches metadata only, leaving concrete values and applied resources. The scene stores the canonical snapshot, context and overrides; ordinary scene values remain the render input, so rendering and export survive a missing store. A snapshot is a reproducibility record, not a review: it does not verify the theme source observations, and binding or reading is not a compliance pass. Overrides never rewrite the snapshot.

Reports and export: `zpixel_inspect kind:'theme'` returns `{document,revision,theme_report}`; preview and export share `theme_report`. Reviewed beauty export blocks a blocked theme_report before writing bytes; draft export preserves fail/pending/unsupported. Export embeds `theme.json` from the pinned snapshot, binding metadata and `theme_report`; a missing external store does not block. Normalmap export uses the underlying beauty buffer for the same report; the normal map image is not checked against the beauty palette. Exports remain v0.5.3-dev-addressed; the renderer remains 0.3.6.

Exact palette and lit: a palette check scans final opaque beauty RGBA. Lit parts multiply brightness and interpolate ramps; lit appearance scales sampled pixels. Final RGB can leave the token set even when every input used a token. A hard `palette` rule is honest only for an unlit/flat path or a proven in-palette ramp range; otherwise it may fail legitimately. `unlit` keeps sampled RGB exact while geometry still supplies depth, normal, shadow and outline. Do not silently switch shading to satisfy a palette rule; record the decision or override.

Boundaries: unsupported tokens such as outline.width other than 1, specular above 0, colored lights, view-frame point lights, soft or dashed outlines and mirror reflection may be saved but must be reported; they are never silently dropped or coerced, and a required unsupported token blocks a conforming binding/export. Unknown token fields reject. No hidden LLM calls, no background image analysis, no geometry or pixel mutation by the compiler, no arbitrary scripts, no aesthetic score and no part-count gate. `THEMES.md` and `zpixel_guide topic:'theme'` are the public reference.

## Anchors and One-Shot Placement

Semantic facing and physical attachment are different concepts. Attachment must not require a guessed or unrelated asset front.

A node may author named local anchors/ports, stored as an object keyed by stable anchor name. Each anchor has a local `point` and may include a local `normal`, `tangent`, or `axis` where its use requires them. For example, a ground anchor can expose point+normal; a hinge can expose point+axis+tangent. Anchors are authored data, not live constraints.

One-shot `node_attach` names source and target anchors, or supplies explicit source/target local points. Attachment modes are explicit:

- `translate`: align points only. It does not rotate and remains valid with point-only anchors.
- `frame`: align a complete source/target anchor frame. Each needs a point, normal and tangent. The source normal is opposed to target normal, and the tangents are aligned. This uniquely fixes rotation and translation.
- `normal`: align the two normals only. This leaves a roll degree of freedom and is rejected unless the request also supplies an explicit `rollAxis` or `rollReference`; the result records that policy.

A point+normal pair never silently borrows node semantic up to choose roll. If an operation is underdetermined, it fails before changing scene state. It writes one source transform transactionally and returns the computed placement; it creates no persistent binding. `node_align` likewise requires explicit axes or an authored semantic frame for every omitted direction. Every placement can be re-queried and undone through transaction history.

## Spatial Intent and Observation

Authored intent is the scene-level `spatialRelations` graph, not node-tree ownership and not computed truth. An edge has `{id,from:{node,anchor?},relation,to:{node,anchor?},...relationSpecificValues}`. `contact`, `support`, `avoid_intersection`, and `allow_overlap` are undirected node-pair relations; endpoints are canonicalized by node/anchor key. `coaxial` is also pairwise but compares unoriented axes unless an explicit signed direction is supplied. Examples:

```js
spatialRelations:[
 {id:"gate-support",from:{node:"gate",anchor:"base"},relation:"support",to:{node:"ground",anchor:"surface"},tolerance:.02},
 {id:"gate-hinge",from:{node:"gate",anchor:"hinge"},relation:"coaxial",to:{node:"wall",anchor:"hinge-axis"},angleTolerance:2,distanceTolerance:.02}
]
```

Duplicate edges with the same canonical relation/endpoints but conflicting anchors or tolerances are rejected. `avoid_intersection` conflicts with `allow_overlap` for the same unordered pair; `contact`/`support` can coexist with `allow_overlap` because they make distinct claims. `allow_overlap` only waives an avoidance violation for that exact pair; it never changes geometric evidence or implies another contact. Deleting a node removes incident edges. Duplicating a subtree copies only edges whose both endpoints are internal and remaps node IDs; crossing/external edges are not copied. Intent is never rewritten from measurement.

Spatial queries compute observations from the current compiled revision and return them separately from intent. Every observation includes relation/status, method, certainty, and bounded evidence. Minimum geometry statuses are:

- `separate`: proved by a conservative bound or supported narrow-phase test;
- `touching` / `surface-proximity`: supported within an explicit tolerance;
- `intersecting`: a volume-intersection witness or exact classifier supports it;
- `unresolved`: available tests cannot decide; a sampling miss is never proof of separation.

Permitted overlap suppresses an intent violation but never hides measured intersection. Painted layers are surfaces, not solids. Camera occlusion/projection is a different query from world-space relation. Results are bounded and revision-addressed; broad-phase bounds precede narrow-phase work, and truncation is explicit.

An inspect response separates `intent`, `worldObservations`, and optional `projection`. Do not rename one result field in implementation without changing contract, schema, guide, and tests together.

## Model-First Observation (0.5.3-dev)

The observation contract was introduced in 0.5.1-dev and is unchanged in 0.5.3-dev. The default authoring order is blockout -> non-delivery observation -> appearance -> delivery. `scene.camera` is the single persistent delivery camera; changing it is a scene edit. Observation uses a transient camera that exists only in the `zpixel_render` or `zpixel_inspect` request. It is never stored, never changes revision, never resolves `plane:"view"` and never replaces `scene.camera`. Projection is always orthographic: `three_quarter` and every oblique eye are parallel-ray views, not perspective. The renderer has no perspective projection, orbit editor or fov.

`zpixel_render` and `zpixel_inspect` accept these optional fields:

- `camera` — the existing scene camera shape: `{preset:"top_down"|"three_quarter"}` or `{position,target,up,mirrorX?,pixelsPerUnit?,center?}`. It is transient and orthographic.
- `fit` — boolean; defaults true when `camera` is supplied. Fit re-centers the view target and eye on the observed bounds while preserving the supplied direction, then adjusts `pixelsPerUnit`/`center`; `fit:false` uses the camera exactly. `fit` without `camera` rejects.
- `isolate` — a node ID; observe only that subtree and hide nodes outside it. World transforms and the camera are unchanged. Source visibility is preserved, so hidden nodes stay hidden and isolate does not force descendants visible; a hidden target or hidden ancestor rejects. A bound appearance layer must be isolated via its owner part, and a target with a visible physical ancestor that would remain as an occluder is rejected.
- `physicalOnly` — boolean; suppress layer color/alpha, not inherited visibility, so solid parts (including solid descendants of a layer parent), groups and their outlines remain. Combine with `mode:"normals"`, `"depth"` or `"nodes"`.
- `expectedRevision` / `expectedHash` — pin the observed revision or content hash; a mismatch rejects and observation never writes. In `zpixel_inspect` the pins apply to every kind; `camera`/`fit`/`isolate`/`physicalOnly` are valid only for `view`/`pixel`/`region`/`spatial`.

Observation is non-delivery. A render with `camera`, `isolate` or `physicalOnly` returns `delivery:false` and `observation`, `view` and `authoring` receipts; a supplied camera is always an observation even when it matches `scene.camera`, and only a call without those fields stays the delivery preview. `view` reports the resolved camera, mode, physicalOnly, isolate, fit, delivery, deliveryAngleDegrees, separationDegrees, wholeScene and partPixels; `authoring` reports contract, structureHash, contentHash, observation (`valid`/`stale`/`none`) and deliveryPreview (`current`/`none`). `zpixel_inspect kind:"view"` follows the render preview path: with observation fields it is a non-delivery observation, without them it is the delivery preview. `pixel`, `region` and `spatial` use the same camera and `physicalOnly` when supplied, so the image and the probe agree. `expectedRevision`/`expectedHash` alone pin a delivery preview or inspection without making it an observation.

Fresh creates default to contract `model-first/1`; a format-2 snapshot with revision and no contract preserves the imported legacy absence, and explicit `contract:"model-first/1"` roundtrips a model-first snapshot. On a new spatial document, `zpixel_scene preview:true` returns a fitted non-delivery `physicalOnly` working view with `preview.workingView:true` and an observation receipt. It is not the final delivery preview. A working-view failure returns `previewError` (`NO_VISIBLE_STRUCTURE` or `WORKING_VIEW_FAILED`) and does not fall back to delivery. Flat-only and legacy documents keep the existing preview. An explicit `zpixel_render` without observation overrides returns the final delivery beauty.

Receipt: `observation:{id,document,revision,structureHash,contentHash,viewHash,camera,mode,physicalOnly,isolate,renderer,deliveredTo}`. `observation.id` is canonical; top-level `observationId` is an optional alias. `deliveredTo` lists the agent IDs that received the image in this session. A receipt records what was observed, not geometric approval.

Hashes are SHA-256 hex64 over stable sorted-key JSON:

- `structureHash` covers canvas width/height, the normalized `scene.camera`, and every node's `id`, `kind`, `parent`, `visible`, `castShadow`, `transform`, `geometry`, `basis`, `appearanceOf`, `semanticFrame` and `anchors` in normalized order. For a free layer it also covers `width`, `height`, `pixelSize` and binary occupancy (`null` vs non-null), so RGB-only paint keeps the hash stable while a null/non-null change invalidates the observation; a bound appearance layer's pixels/width/height/pixelSize/appearanceShading are excluded. It excludes palette, ramps, materials, lights, ambient/exposure, name/role/tags/locked/material/outline, `spatialRelations`, theme, title, document id and revision.
- `contentHash` is the full stored-scene fingerprint including revision.
- `viewHash` covers the normalized camera, `mode`, `isolate` and `physicalOnly`.

A new spatial document (at least one `part`) needs a delivered whole-scene observation at the current `structureHash` before a reviewed beauty export; the reviewed export also needs a current delivery beauty preview from an explicit render without overrides, and the working view does not count as one. The observation must be non-delivery, must not use `isolate`, must show at least one solid part pixel, and its view direction must be at least 20 degrees from the delivery viewing axis (parallel and antiparallel do not count; raw `deliveryAngleDegrees` must be 20..160). An isolated or zoom-only observation is insufficient. The gate status is `observed`, `not-observed`, `flat-only-exempt`, `legacy-none` or `waived`. Draft export stays free. Flat-only documents (no parts) and legacy documents are exempt. `structureReview:{waived:true,reason:"..."}` is a narrow recorded waiver for a reviewed export; the reason is 3-360 characters, and it is recorded as `waived`, never as pass, and never bypasses theme rules or the visual review. `zpixel_normalmap` reports `observation.countsAsObservation:false` and cannot satisfy the gate. A reviewed export returns `structureHash`, `spatial`, `observation`, `camera` and records the waiver in the manifest.

`paint is a property of a surface, not an object.` A bound appearance layer changes where color lands, not what the object is. A wheel painted on a track top or a muzzle face painted on a horizontal top can be bound correctly and still be semantically wrong. Model and observe the solid when the mark represents a physical part; paint the surface's color, wear, markings and fixed-view detail.

## One Compiled Spatial Representation

A single compiler validates scene authoring and produces a revision-addressed world representation containing normalized nodes, world transforms, geometry instances, bounds, anchors, and render state. Geometry queries, support placement, spatial relationships, camera rays, hard shadows, visibility, and exports consume that same representation.

The geometry kernel defines one contract for every supported primitive: local ray hit/normal, conservative bounds, containment where defined, support in an explicit direction, and deterministic samples only where a classifier is unavailable. Queries state whether evidence is exact, witnessed, conservative, or unresolved. Rendering may not retain a second, differently oriented primitive implementation.

The compiler caches world normal by inverse-transpose, directions by the affine linear transform, and orthonormalized semantic/anchor frames. Each reported frame carries a quality flag: `rigid` when transformed basis remains orthogonal, `orthogonalized` when Gram-Schmidt repairs a non-rigid basis, or `degenerate` when the transformed directions cannot define a frame. Align/attach operations requiring a `degenerate` frame fail. No `orthogonalized` frame is presented as an unchanged rigid frame. Camera, lights and painted surface bases are transformed/read from the same compiled revision, with projection pixels identified as geometry visibility separately from outline-only image pixels.

World transforms compose only through the ownership tree. Spatial edges never alter the tree. Node pose edits, anchor placement, and group reparenting are atomic scene operations and preserve revision, txid, conflict and undo semantics. Bound appearance layers have no geometry instance, bounds, support or samples; they are sampled after a part hit and never enter the ray, support or sample sets.

## General Asset Coverage

Examples and core validation are organized by reusable asset family, not vehicle subsystems:

1. Built environment: ground surface, wall segment, doorway/gate, and an overhang. Check ground-plane placement, anchors, contact, occlusion and shadow.
2. Natural props: trunk plus canopy, bush and simple irregular rock. No semantic front is required; ground anchors and vertical extent remain explicit.
3. Directional objects: arrow, tool, barrel or lamp. Geometry axis is explicit; semantic forward is declared only when useful to editing/query.
4. Surface assets: tile, decal or painted terrain. Basis, finite footprint, transparency and surface-versus-volume semantics are explicit.
5. Compound placement: a small generic assembly (for example, a gate on a wall or a prop on a platform) demonstrates group transforms, anchors, intentional overlap, one-shot attach, query and undo.

A vehicle can remain a secondary stress fixture. It must not define default roles, fields, axes or the overview guide.

## Model-Facing Operations

Keep `zpixel_scene`, `zpixel_render`, `zpixel_inspect`, `zpixel_normalmap`, `zpixel_export`, `zpixel_guide`, and `zpixel_theme`. Schemas derive from this contract and expose coordinate spaces, local geometry axes/endpoints, optional semantic frame, anchor placement, relation intent, evidence certainty, part-bound appearance fields and unbinding, the transient observation camera/fit/isolate/physicalOnly/expectedRevision/expectedHash, inspect kind view, the reviewed-export structureReview waiver, the outer scene theme binding, theme actions and theme_report, and one-shot/undo effects on the relevant parameters. The overview starts with generic environment/prop examples. Focused topics cover camera, geometry, anchors/placement, relations, paint, lights, normal maps, themes, migration and limits.

`zpixel_normalmap` is a same-source sibling of a beauty render: it reuses that document, revision and camera hit buffer and its alpha, including inside/outside outline pixels, without re-tracing or re-shading. It emits linear sprite/view RGB (R right, G up for OpenGL or down for DirectX, B toward the viewer); solid surfaces use the inverse-transformed geometry normal, free painted layers use only the visible face of their authored plane and never inferred relief, bound appearance layers contribute no normal and keep the part's geometry normal, and generated outer outline pixels are neutral view-facing. It is not the world-space `zpixel_render mode:"normals"` diagnostic, which remains unchanged, nor a replacement for beauty `zpixel_export`. Preview metadata reports a bounded color list; exported metadata is technical data, not aesthetic review. Arguments are strict: only `document`, `revision`, `convention`, `scale` and `export` are accepted, and unknown fields fail with `UNSUPPORTED_FIELD` rather than being ignored; no height, strength, blur, edge or normal-source parameter exists. Results carry additive `diagnostics` (`sourceMode:"geometry"`, `relief:"none"`, representation, camera view, visible/surface/layer pixel counts, exact `uniqueColorCount`, area-weighted `dominantColor`/`dominantShare`, `neutralEncodedShare` of pixels encoded as `128,128,255`, `flatness` and warnings) that describe the encoded image without changing pixels; `neutralEncodedShare` is not `fallbackCounts.neutralPixels`.

## Core Invariants

The small release test set verifies architectural invariants, not broad performance or art quality:

- Basis conversion is a proper rotation and preserves both legacy camera rasters.
- World/local transforms, geometry axes, camera basis, light direction and layer basis agree under one coordinate contract.
- Camera orbit never changes world pose or light values.
- The same compiled geometry instance produces consistent ray, bounds, support/anchor placement, relation evidence, shadow and raster results.
- Omitted semantic frame stays unknown while a wall, tree, surface layer or simple prop remains editable/renderable.
- Explicit anchor attach is reversible, records intent only when requested, and re-query reports actual geometry separately.
- Permitted overlap remains visible in observations and is not reported as an avoid-intersection failure.
- A bound appearance layer is a leaf direct child of its part, unique per part including hidden ones, with no anchors, castShadow or outline; invalid bindings fail final validation atomically.
- Unbound scenes and fallback pixels remain byte-identical; bound appearance adds no geometry, bounds, shadow, outline or depth and never occludes foreground.
- Hit nodeId stays the part; appearance provenance appears only on appearance-colored pixels and is cleared by outline replacement; contribution counts the part and reports appearances separately.
- Planar appearance projection is object-local, may repeat on opposite/grazing faces, and adds no UV/decal/camera-hash or reflection/roughness/albedo channel.
- Outline masks, transaction conflict/replay/undo, export addressing and source-preserving migration continue to pass.
- Theme canonical revisions validate without mutation, hash stable sorted-key JSON, keep old revisions immutable, and replay a fixed applied revision for the same txid.
- Theme compilation adds namespaced resources and defaults only; it never mutates geometry or pixels, and unsupported tokens are reported rather than dropped or coerced.
- Theme resource application is additive; replacement retains old theme-namespaced palette/ramps/materials and reports them in theme_changes.retainedResources; cleanup is not automatic and scene limits apply.
- Scene theme binding pins id/revision/hash/snapshot; create/edit defaults and explicit node bindings behave as documented; theme:null detaches metadata only.
- theme_report is computed from the actual beauty buffer, separates mechanical from visual results, preserves waived deviations, and blocks reviewed export only for non-waived hard mechanical failures or required unsupported features.
- Export embeds the pinned theme snapshot and theme_report; a missing external store does not block export, and the renderer stays 0.3.6.
- Observation camera is transient and orthographic; it never writes, never changes revision and never replaces scene.camera; fit changes framing only, never view direction or projection.
- structureHash, contentHash, viewHash and the observation receipt id are stable for identical inputs and change only as documented; a receipt records what was observed, not geometric approval.
- A new spatial document's reviewed export requires a delivered whole-scene observation at the current structureHash with at least one solid part pixel and at least 20 degrees from the delivery viewing axis (parallel and antiparallel do not count; raw deliveryAngleDegrees 20..160); isolated and zoom-only views do not count; flat-only and legacy documents are exempt; structureReview is recorded as waived, never as pass.
- paint is a property of a surface, not an object; binding color does not make a painted symbol a modeled part.
- Representative examples cover the asset families above; a vehicle is optional.

No bundle is ready until source modules import, these invariants pass, schemas/guides match observed results, theme revisions/hashes, scene snapshots and theme_report agree with observed results, migration-source bytes remain unchanged, and the active Harness installation is separately verified.
