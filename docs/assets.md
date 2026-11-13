# Asset log (round 2, 3D scene)

Rule: external assets must be CC0/OFL and logged here with name, URL, author, license, date, file, SHA-256, size, usage.

## External assets
None. No textures, HDRIs or models were downloaded for the 3D scene (ambientCG / Poly Haven candidates were not needed). Nothing here requires attribution.

## Original procedural assets (src/client/scene/)
| asset | where | notes |
|---|---|---|
| Walnut wood albedo + bump (1024 high / 512 low) | materials.ts `woodMaps` | canvas grain strokes, seeded RNG |
| Felt albedo + bump | materials.ts `feltMaps` | canvas fibre noise, sheen in material |
| Marble swirl normal map 128x128 | materials.ts `swirlNormal` | computed height field |
| Café backdrop 1024x512 with 12 bokeh discs | materials.ts `bokehTexture` | gradient + radial blobs |
| Soft circle 64x64 (steam, contact blobs) | materials.ts `softCircleTexture` | |
| Warm interior environment (replaces HDRI), PMREM 256 / 64 | materials.ts `buildEnvironment` | emissive boxes baked by PMREMGenerator |
| Card atlas 2048 high / 1024 low | textures.ts `buildAtlas` | own art, canvas text |
| Espresso cups, saucers, dallah, date bowl, tea glass, napkin/sugar, table, chairs | cafe.ts, avatar.ts | Lathe / primitive geometry |
| Four stylized avatars (cap, fez, bun hair, headscarf variants) | avatar.ts | original design, no existing character |
