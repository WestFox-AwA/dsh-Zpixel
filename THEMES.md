# ZPixel Themes 0.4.0

Status: 0.4.0 theme library and scene binding. The scene format remains `dsh-zpixel/2`; the renderer remains 0.3.6. Themes require 0.4.0. The executable definition and tool sequence live in `zpixel_guide topic:"theme"`; this document is the field and workflow reference.

## What a theme is

A theme is a versioned visual production spec, not a palette dump, adjective prompt or geometry generator. It stores visual language, reusable color/ramp/material/outline/light tokens, hard and advisory rules, limited size/class adaptations, reference metadata and source evidence. It never generates geometry, paints pixels, chooses parts or replaces modeling. One scene binds at most one theme; there is no subtree, multi-theme or inheritance engine.

The library tool is `zpixel_theme` with actions `add`, `read`, `list` and `revise`. Binding is the outer `theme` parameter of `zpixel_scene`. Checks reuse `zpixel_inspect kind:"theme"`, preview and export. There is no separate apply, create, fork, derive, resolve or publish tool.

## Canonical revision

A canonical Theme has:

| Field | Meaning |
| --- | --- |
| `format` | Always `dsh-zpixel-theme/1`. Assigned by `add`; never authored in a spec. |
| `id` | Stable theme ID. Assigned by `add`; preserved exactly and reserved case-insensitively. |
| `revision` | Nonnegative integer. First revision is 0; `revise` appends a new immutable revision. |
| `title` | Required nonempty title. |
| `summary` | Required production summary. |
| `tags` | Bounded descriptive strings. |
| `signature` | Existing rule IDs that identify the theme. It never duplicates rule text. |
| `language` | Authored language sections; see below. |
| `tokens` | Named colors, ramps, materials, outline, lights, ambient, exposure, camera and appearance shading. |
| `rules` | Stable rule IDs with strength, statement, optional scope and optional built-in check. |
| `adaptations` | Limited language changes for an asset class or size band. |
| `references` | Metadata only; no image bytes and no automatic analysis. |
| `source` | Authoring route and evidence: concept, reference or hybrid. |

The author spec omits `format`, `id` and `revision`. `title` and `summary` are required; every other section defaults empty. A canonical revision validates without mutation, including deep-frozen objects. The hash is the bare SHA-256 hex64 of stable sorted-key canonical JSON, never an author-provided field. Revisions are immutable: `revise` takes the observed `expected_revision` and a complete replacement spec, not a patch. The same `txid` retry returns its fixed applied revision; a changed payload under the same `txid` errors. `read` defaults to the head; pass `revision` to pin.

`add` and `revise` return compact theme identity `{id,revision,title}` plus `hash`, `capabilities`, `replayed` and `appliedRevision`; they do not resend the full spec.

Bounded data: 256 KiB per revision, 64 rules, token IDs at most 48 characters so namespaced resource IDs stay within 128.

## Language

`language` has these optional sections. Each is one bounded string; paragraphs are allowed. An omitted section is unspecified, not permission for anything.

| Section | What to record |
| --- | --- |
| `identity` | 3-7 recognizable features, mood, era/medium reference, cross-asset invariants. |
| `view` | Projection, viewing direction and camera expectations. |
| `scale` | Target native sizes, pixel density and transparent margin. |
| `form` | Primary/secondary masses, silhouette, proportion, corners, symmetry and negative space. |
| `pixel` | Block/cluster grammar, stair rhythm, single-pixel use, antialiasing, dithering and texture frequency. |
| `color` | Value organization, temperature, hue shift, saturation, semantic color roles and material ramps. |
| `outline` | Outer boundary versus inner structure lines, width, color and seam treatment. |
| `light` | Key direction and frame, value grouping, ramp count, shadow color, edge hardness and highlight shape. |
| `materials` | How wood, stone, metal, cloth or glass are distinguished through color, edges and texture density. |
| `detail` | Focus, detail density, minimum readable feature size and background relationship. |

Write guidance that changes an action. "Soft" should become a concrete form decision such as complete primary masses, short chamfers on decorative corners and detail that serves the main volume.

## Tokens

`tokens` is a closed object: unknown token fields reject. Supported fields:

- `colors`: map of key to `{value:"#RRGGBB",role?,usage?}`. `role` and `usage` are author semantics, not renderer parameters.
- `ramps`: map of key to `{response?,stops:[{at,color}]}`. `response` defaults to 1; stops are strictly ascending; `color` is an existing color token key.
- `materials`: map of key to `{ramp,diffuse?,emission?,specular?,roughness?}`. `ramp` is an existing ramp token key; defaults match the scene material.
- `defaultMaterial`: material token key used when a part omits `material`.
- `outline`: `{enabled?,color?,width?,direction?}`. `color` is an existing color token key; width 1 is supported; direction is `inside` or `outside`.
- `lights`: array of `{id,type,position?,direction?,frame?,intensity?,range?,color?}`. `type` is `point` or `directional`; `direction` is light travel; `frame` is `world` or `view`; view coordinates are x=screen-right, y=screen-up, z=toward-viewer. Point position is world only in v1; a view-frame point light is saved but reported unsupported.
- `ambient`: ambient white level.
- `exposure`: ramp exposure.
- `camera`: `{preset:"top_down"|"three_quarter",pixelsPerUnit?}`.
- `appearanceShading`: `lit` or `unlit` default for bound appearance layers.

Omitted token directives are unspecified. `lights:[]` is an explicit no-lights choice. View-frame directions compile through the actual scene camera basis; without an actual camera the canonical `top_down` camera is used and disclosed in capabilities. The theme compiler never mutates geometry or pixels.

Values the engine cannot express may still be saved when their shape is supported: `outline.width` other than 1, `specular` above 0, colored lights, view-frame point lights. Compatibility must report blockers with path, feature, reason and required flag; the compiler must not silently drop or coerce them. A required unsupported token blocks a conforming binding/export; drafts remain allowed. Unknown token fields reject.

## Rules and checks

A rule is `{id,strength,statement,scope?,check?}`:

- `strength`: `must`, `should` or `must_not`.
- `scope`: optional `{assetClasses?,minSize?,maxSize?}`. `minSize` and `maxSize` refer to `max(scene.width,scene.height)`.
- `check`: optional built-in predicate. No check, or a `visual` check, means `needs_review`.

Known check kinds:

| Kind | Fields | What it checks |
| --- | --- | --- |
| `palette` | none | Final opaque beauty RGB belongs to the theme colors. |
| `color_count` | `max` positive integer | Final opaque color count. |
| `binary_alpha` | none | Alpha is binary. |
| `padding` | `min` integer >= 0 | Transparent padding around visible pixels. |
| `canvas` | `width?`, `height?`, `maxWidth?`, `maxHeight?` | Native canvas dimensions. |
| `outline` | `enabled?`, `width?`, `direction?`, `color?` | Effective physical part outline configuration, not painted line morphology. |
| `camera` | `preset` | Scene camera preset. |
| `light_count` | `max` | Number of scene lights. |
| `appearance_shading` | `value:"lit"|"unlit"` | Effective bound appearance shading. |
| `visual` | none | Human/model visual judgment. |
| `unsupported` | `feature` | A known unsupported feature that remains reported. |

Malformed or unknown kinds and conditional fields reject. `must_not` inverts a mechanical predicate's pass/fail. `should` is advisory only and never blocks. Preserve `not_applicable` and `needs_review`; an unsupported known feature remains reported and is never converted to pass. There is no score and no part-count gate.

## Adaptations

`adaptations` is an array of `{id,assetClass?,minSize?,maxSize?,language}`. `language` is a subset of the language sections. Adaptations may change language guidance only; they never override tokens or hard rules. Omitted fields leave the adaptation unrestricted in that dimension.

## References and source

`references` is metadata only: `{id,path?,sha256?,role?,note?,crop?,observations?,inferences?}`.

- `path` is workspace-relative and cannot escape the workspace; delivery supports PNG, JPEG, WebP and GIF images.
- `sha256` is optional bare hex64.
- `role` is `reference`, `positive` or `negative`.
- `crop` is `[x,y,width,height]` in image pixels.
- `observations` record what was actually visible; `inferences` record interpretation.

No image bytes are stored and no automatic inference or copy occurs. `read` returns availability metadata and may attach ONE named reference image via `reference:"<id>"`; a missing file, unsupported type, image above 8 MiB or hash mismatch fails that read with a clear error. The returned reference note states that visual analysis is performed by the calling model.

`source` is `{kind:"concept"|"reference"|"hybrid",brief?,observations?,inferences?,decisions?,unknowns?}`. The model authors the analysis. The service never calls another model and never analyzes an image in the background. A text-only route can store an analysis authored elsewhere, but the tool result must not claim the service inspected the image; route capability is recorded separately as `image_capable`, `data_only` or `capability_unknown`. No reference count, confidence score or sample count promotes a rule to `must`; the user or an explicit design decision does.

## Complete executable definition

This is one complete spec value. The exact executable `add` call is in `zpixel_guide topic:"theme"`; the same object is accepted by `add` and by `revise` as a complete replacement.

```json
{
  "title": "Soft workshop",
  "summary": "Warm ochre masses, plum shadows and one teal functional accent; broad readable planes, short chamfers and a one-pixel ink boundary. Authored for 32-64 px top-down props.",
  "tags": [
    "warm",
    "workshop",
    "top-down",
    "prop"
  ],
  "signature": [
    "edge.ink",
    "alpha.binary",
    "mass.primary"
  ],
  "language": {
    "identity": "Sturdy hand-built workshop goods read as one family: warm midtones, plum shadow and a single cool accent. Recognition comes from mass and value grouping, not from repeated decoration.",
    "view": "Author for the canonical top-down view; three-quarter is a deliberate variant, not a second default.",
    "scale": "Read at 32-64 px native. Keep at least two transparent pixels of padding and one large quiet plane.",
    "form": "Keep the primary mass complete. Attachments sit under it; chamfers are short and never split the silhouette. Prefer one dominant volume plus one functional secondary volume.",
    "pixel": "Use clusters of two or more pixels. No isolated noise. One-pixel ink is reserved for boundaries; internal seams use the shadow color.",
    "color": "Ochre base, plum shadow, pale ochre light. Teal marks function, never decoration. Group values before adding hue variation.",
    "outline": "One-pixel ink boundary inside the silhouette. Do not add a second ink line for internal structure; use shadow there.",
    "light": "Key light from screen upper-left. Group facets into two or three value steps; do not shade every facet separately.",
    "materials": "Wood reads through broad plank bands and a warm ramp; stone reads through larger facets and a quieter ramp. Do not fake metal with specular.",
    "detail": "Concentrate detail in one functional zone. Leave large planes quiet; at small sizes delete secondary trim before thinning the outline or functional gaps."
  },
  "tokens": {
    "colors": {
      "ink": {
        "value": "#2C2333",
        "role": "boundary",
        "usage": "outline and deepest seams"
      },
      "shadow": {
        "value": "#755146",
        "role": "shadow",
        "usage": "warm material shadow"
      },
      "base": {
        "value": "#BC8758",
        "role": "midtone",
        "usage": "primary mass"
      },
      "light": {
        "value": "#E7BE83",
        "role": "highlight",
        "usage": "lit planes"
      },
      "accent": {
        "value": "#668C83",
        "role": "accent",
        "usage": "functional marks only"
      }
    },
    "ramps": {
      "body": {
        "response": 1,
        "stops": [
          {
            "at": 0,
            "color": "shadow"
          },
          {
            "at": 1,
            "color": "light"
          }
        ]
      }
    },
    "materials": {
      "wood": {
        "ramp": "body",
        "diffuse": 1,
        "emission": 0,
        "specular": 0,
        "roughness": 0.5
      }
    },
    "defaultMaterial": "wood",
    "outline": {
      "enabled": true,
      "color": "ink",
      "width": 1,
      "direction": "inside"
    },
    "lights": [
      {
        "id": "key",
        "type": "directional",
        "direction": [
          0.5,
          -1,
          -0.35
        ],
        "frame": "view",
        "intensity": 1,
        "color": "#ffffff"
      }
    ],
    "ambient": 0.35,
    "exposure": 1,
    "camera": {
      "preset": "top_down",
      "pixelsPerUnit": 4
    },
    "appearanceShading": "unlit"
  },
  "rules": [
    {
      "id": "edge.ink",
      "strength": "must",
      "statement": "Every solid part keeps a one-pixel ink boundary inside the silhouette.",
      "check": {
        "kind": "outline",
        "enabled": true,
        "width": 1,
        "direction": "inside",
        "color": "ink"
      }
    },
    {
      "id": "alpha.binary",
      "strength": "must",
      "statement": "Alpha is binary; no soft or antialiased edges.",
      "check": {
        "kind": "binary_alpha"
      }
    },
    {
      "id": "canvas.margin",
      "strength": "must",
      "statement": "Keep at least two transparent pixels of padding.",
      "check": {
        "kind": "padding",
        "min": 2
      }
    },
    {
      "id": "canvas.size",
      "strength": "must",
      "statement": "Native size is at most 64 px on either axis.",
      "check": {
        "kind": "canvas",
        "maxWidth": 64,
        "maxHeight": 64
      }
    },
    {
      "id": "light.one",
      "strength": "must",
      "statement": "Use one white key light; colored lights are unsupported.",
      "check": {
        "kind": "light_count",
        "max": 1
      }
    },
    {
      "id": "shade.unlit",
      "strength": "must",
      "statement": "Bound appearance layers use unlit shading so sampled colors stay exact.",
      "check": {
        "kind": "appearance_shading",
        "value": "unlit"
      }
    },
    {
      "id": "palette.prefer",
      "strength": "should",
      "statement": "Prefer the five theme colors. Lit ramps may interpolate, so a closed palette is not claimed.",
      "check": {
        "kind": "palette"
      }
    },
    {
      "id": "mass.primary",
      "strength": "must",
      "statement": "The primary mass stays complete; attachments and decoration never split the silhouette.",
      "check": {
        "kind": "visual"
      }
    }
  ],
  "adaptations": [
    {
      "id": "small-prop",
      "assetClass": "prop",
      "maxSize": 48,
      "language": {
        "form": "At 48 px or less, delete secondary trim before thinning the outline or functional gaps.",
        "detail": "One accent mark maximum; keep the largest plane empty."
      }
    }
  ],
  "references": [],
  "source": {
    "kind": "concept",
    "brief": "Authored from this written brief; no reference image was inspected.",
    "observations": [],
    "inferences": [
      "Warm ochre plus plum shadow reads as workshop material without extra texture."
    ],
    "decisions": [
      "Closed palette stays advisory because lit ramps interpolate; unlit appearance is the exact-color path."
    ],
    "unknowns": [
      "Cross-asset consistency is untested beyond this definition."
    ]
  }
}
```

## Tool actions

### add

`zpixel_theme({action:"add",theme:"soft-workshop",txid:"soft-workshop-add",spec})`

Saves a complete spec, assigns format/id/revision 0, validates structure, references, rule conflicts and current-engine compatibility, and returns compact identity plus hash and capabilities. It does not change the current scene and does not call another model.

### read

`zpixel_theme({action:"read",theme:"soft-workshop",revision:0,context:{assetClass:"prop",nativeSize:[32,32],view:"top_down",channels:["beauty","normalmap"]},view:"working"})`

Returns a production pack: identity, brief, signature, every applicable or undecidable hard rule, tokens/bindings, capability notes, review checklist, references and source. It never claims pass without a scene; mechanical checks are pending and visual rules need review. Omitted context stays unknown. `view:"full"` also returns the definition. `sections` narrows optional detail, never hard rules. `list` returns summaries only.

### revise

`zpixel_theme({action:"revise",theme:"soft-workshop",expected_revision:0,txid:"soft-workshop-r1",spec})`

Appends a new immutable revision from the complete replacement spec. The old revision stays readable and pinned scenes do not follow the head.

## Scene binding

The outer `theme` parameter of `zpixel_scene` is an object or `null`:

```js
theme:{
  id:"soft-workshop",
  revision:0,
  hash?,                 // optional; when supplied it must match the stored revision
  context?,              // assetClass, nativeSize, view, channels
  applyDefaults?,        // true on create, false on edit by default
  bindings?:[{node,material?,outline?,appearanceShading?}],
  overwrite?,            // same-namespace resource collisions
  replace?,              // different current pin (hash/revision)
  overrides?:[{rule,reason}]
}
```

`id` and `revision` are required. The binding pins one revision; rendering never follows the library head.

On create, `applyDefaults` defaults true. The service resolves the theme before scene validation, merges namespaced resources and theme defaults (palette, ramps, materials, lights, ambient, exposure, camera, root outline, default material), and lets explicit initial scene fields win. Initial nodes may therefore reference namespaced palette/material IDs. It does not construct nodes, paint pixels or force geometry.

On edit, `applyDefaults` defaults false. Edit always merges namespaced resources and only the listed node bindings; unlisted nodes keep their values. Global lights/ambient/exposure/camera/root outline/default material apply only when `applyDefaults:true`. Explicit initial palette/ramp/material entries that collide with theme resource IDs are preserved on create and listed in `theme_changes.preservedExplicit`; theme defaults do not overwrite them. `theme_changes` also reports `defaultsApplied`, `resources` (`{palette,ramps,materials,lights}` ID arrays), `preservedExplicit` and `retainedResources` (`{palette,ramps,materials}` ID arrays), `removedLights` (light IDs), `globalFields` and `nodeBindings`; `theme:null` yields `metadataOnly`/`detached`. A material binding names a theme material key, not a scene ID. `outline:true` applies the theme outline token and `outline:false` explicitly disables the target outline; `appearanceShading:true` applies the token and `false` leaves it unchanged.

Resource IDs are prefixed `theme.<id>.<key>`; painted pixels reference the namespaced palette ID. Colliding theme-managed resources in the same namespace error unless `overwrite:true`; a different current pin errors unless `replace:true`. `theme:null` on edit detaches metadata only, leaving concrete values and already-applied resources.

Resource application is additive. Existing theme-namespaced palette/ramps/materials are never removed automatically, because old nodes may still reference them. On edit or replace, entries from the previous theme namespace that are absent from the new revision are retained and listed in `theme_changes.retainedResources`; older retained entries may also remain, and scene limits apply. Cleanup is intentionally not automatic.

The scene stores the canonical snapshot, context and overrides. Ordinary scene values remain the render input; the snapshot is the reproducibility and check source, so rendering and export survive a missing theme store. A snapshot is not a review: it records the authored definition and binding, does not verify the theme source observations, and binding or reading is not a compliance pass. Overrides waive a rule and preserve deviations; they never rewrite the snapshot.

## Reports

`zpixel_inspect({document:"crate",kind:"theme"})` returns `{document,revision,theme_report}`. Preview and export share `theme_report`. It is computed from the actual beauty buffer, including outlines, not from a diagnostic raster, and fixes scope from `scene.theme.context` plus actual native size.

Statuses are `pass`, `fail`, `needs_review`, `unsupported`, `not_applicable` and `waived`. Mechanical checks cover final color membership/count, binary alpha, padding, canvas, effective physical part outline configuration, camera, light count and appearance shading. Visual checks never become machine passes. `must_not` inverts a mechanical predicate; `should` is advisory and never blocks; an unknown scope is `needs_review` with pending mechanical status, not pass. Overrides produce `waived` and preserve deviations. `blocked` is true for a non-waived `must`/`must_not` mechanical failure or a required unsupported feature. There is no aesthetic score, percentage or part-count gate.

## Exact palette and lit

A `palette` check scans final opaque beauty RGBA including outline pixels. Lit parts multiply material brightness and interpolate ramps; lit appearance also scales sampled pixels. Final RGB can therefore leave the token set even when every input used a token. Declaring `palette` as `must` is honest only when the output path is unlit/flat or the actual ramp range is proven in-palette; otherwise the check may fail legitimately. `unlit` keeps sampled RGB exact but still uses geometry for depth, normal, shadow and outline. `color_count` has the same issue. Do not silently switch shading to satisfy a palette rule; record the decision or an override. The example keeps palette advisory (`should`) and unlit hard.

## Unsupported and capabilities

Not supported: `outline.width` other than 1, `material.specular` above 0, colored lights, view-frame point lights, soft or dashed outlines, mirror reflection, CSG, animation and arbitrary scripts. Supported-shape unsupported values may be saved, but compatibility must report blockers with path, feature, reason and required flag, and must not silently drop or coerce them. A required unsupported token blocks a conforming binding/export; drafts remain allowed. Unknown token fields reject.

No theme can add geometry, paint pixels, force a part count, replace modeling or turn a flat layer into a solid. The theme store touches only `.zpixel/themes`, never assets or documents.

## Revision snapshots and export

Updating the library or deleting the theme does not change an existing scene. Export embeds `theme.json` from the pinned snapshot, binding metadata and `theme_report`; a missing external store does not block export. Draft export preserves fail/pending/unsupported; reviewed beauty export blocks a blocked `theme_report` before writing any export bytes. Normalmap export uses the underlying beauty buffer for the same report; the normal map image is not checked against the beauty palette. Exports remain v0.4.0-addressed; the renderer is still 0.3.6.

## Authoring workflows

### Reference-based

1. Inspect the real image and record what is visible as observations, with crops when useful.
2. Separate observations from inferences; mark unknowns instead of inventing a complete universe from one image.
3. Extract reusable roles, construction rules, pixel grammar and light logic, not an object inventory.
4. Choose tokens and rules; check current-engine capabilities before promising a strict result.
5. Save with `add` and a source kind of `reference` or `hybrid`.
6. Test the theme on an actual asset, record failures, and `revise` with a complete replacement.

A JPEG or resized sample cannot claim the original palette, and one image cannot prove a cross-asset law. Reference metadata does not copy or analyze pixels.

### Concept-based

1. Write the brief and the recognizable features.
2. Translate adjectives into form, color, outline, pixel and light decisions.
3. Define allowed variation and prohibitions; do not force every object to grow the same decoration.
4. Choose tokens and rules; keep hard rules small and explicit.
5. Save with `add` and source kind `concept`.
6. Test on actual assets and revise from evidence, not from a success count.

### Bind and iterate

Create with a pinned theme and explicit scene fields, then bind nodes explicitly. Inspect `theme_report`, render, and export a draft. Reviewed beauty export requires a current preview and an honest review note, and blocks a blocked theme_report. Rebind an existing work only as an explicit atomic edit with preview; do not auto-repaint it. User intent outranks theme hard rules; record a concrete deviation or override instead of claiming full compliance.

## Constraints

- One theme per scene; no subtree themes, multi-theme blending, inheritance chains or arbitrary selectors/scripts.
- Theme resource application is additive; replacing a theme retains old theme-namespaced palette/ramps/materials and reports them in `theme_changes.retainedResources`. Cleanup is not automatic, and scene limits apply.
- No hidden LLM calls, no background image analysis, no image copy, no geometry or pixel generation by the theme compiler.
- No aesthetic score, percentage or part-count gate.
- Bounded data: 256 KiB per revision, 64 rules, token IDs at most 48 characters.
- Scene format remains `dsh-zpixel/2`; themes require 0.4.0; the renderer remains 0.3.6.
