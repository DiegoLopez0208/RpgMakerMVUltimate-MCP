# Plan v5 — RpgMakerMVUltimate-MCP

Auditoría completa de las 101 tools (implementación, no solo descripciones) + diseño de la v5.
Fecha: 2026-06-11. Base: v4.1.0.

---

## 1. Hallazgos críticos (tools ROTAS hoy)

### 1.1 Validación Zod con keys equivocadas — rompe 6 tools silenciosamente

`server.ts` aplica los schemas de `src/utils/validation.ts` (snake_case: `map_id`, `mp_cost`,
`damage_formula`) a tools cuyo inputSchema y handler usan camelCase (`mapId`, `mpCost`, `formula`).
Zod **descarta las keys desconocidas** en `parse()`, así que `args = parsed.data` borra los
argumentos reales:

| Tool | Efecto real |
|---|---|
| `create_npc` | **Falla siempre**: Zod exige `map_id`, el cliente manda `mapId` → "Validation error: map_id: Required" |
| `create_damage_skill` | `mpCost` y `formula` se descartan → crea la skill con costo 0 y `damage.formula: undefined` |
| `create_healing_skill` | Ídem: fórmula perdida |
| `create_buff_skill` | `paramId`/`turns` descartados → efecto `{code:31, dataId:undefined}` → crash en MV al usarla |
| `create_state_skill` | `stateId`/`chance` descartados → efecto roto |
| `create_map` | Zod exige `name` (el inputSchema lo declara opcional); descarta `tilesetId`, `bgmName`, `note`, `displayName`; el default de width pasa de 17 a 25 |

**Fix**: una sola fuente de verdad. Definir los schemas en Zod con las MISMAS keys que el
inputSchema y generar el JSON Schema con `zod-to-json-schema` (o el soporte nativo de zod 4).
Esta clase de bug se vuelve imposible. Los unit tests actuales no lo detectaron porque prueban
los schemas en aislamiento; hacen falta tests de integración sobre `handleToolCall` (ver §4).

### 1.2 Self Switch invertido — los eventos de 2 páginas no funcionan

En MV, el comando 123 interpreta `parameters[1] === 0` como **ON** (rpg_objects.js,
`Game_Interpreter.command123`). El código mezcla las dos convenciones:

| Lugar | Código | Efecto |
|---|---|---|
| `createNpc` página 1 (`mapTools.ts:470`) | `['A', 1]` = OFF | La página "ya hablamos" **nunca** se activa |
| `createBossEvent` (`mapTools.ts:946`) | `['A', 1]` = OFF | El boss **reaparece** después de vencerlo |
| `createPuzzleSwitch` puerta pág. 2 (`mapTools.ts:1030`) | `['A', 1]` = OFF | La puerta se vuelve a bloquear |
| `createPuzzleSwitch` switch pág. 1 (`mapTools.ts:988`) | `['A', 0]` = ON | ✓ correcto (inconsistente con lo demás) |
| `cmd.selfSwitchControl` (`commandBuilder.ts:156`) | `value ? 0 : 1` | ✓ correcto — `createChest` se salva por usarlo |
| `validate_map` (`server.ts`, check código 123) | flagea `parameters[1] === 0` como error | **Invertido**: marca como bug los eventos correctos y aprueba los rotos |

**Fix**: usar `cmd.selfSwitchControl()` en todos lados y corregir el chequeo del validador.

### 1.3 `create_shop` vende siempre el ítem 1

`createShop` emite `{code: 302, parameters: [0, 1]}` y TODOS los goods como 605. En MV los
parámetros del 302 **son el primer good** → toda tienda creada vende "Potion" (ítem 1) primero,
además de lo pedido. Encima el handler en `server.ts` descompone `goods` a listas de IDs y
descarta `priceType`/`price` (precios custom documentados en el schema, ignorados de facto).
**Fix**: primer good en el 302, resto en 605, conservando `[type, id, priceType, price]` y
pasando `purchaseOnly`.

### 1.4 `create_puzzle_switch` — argumentos cruzados

`server.ts` llama `createPuzzleSwitch(p, mapId, switchX, switchY, gameSwitchId, doorX, doorY, switchName)`
y la firma es `(projectPath, mapId, x, y, switchId, doorX, doorY, switchCharacterName)`:
`switchName` (nombre de evento) termina como **filename de sprite** → referencia a gráfico
inexistente; `doorName` se ignora; los nombres quedan hardcodeados 'Switch'/'Door'.
**Fix**: alinear firma/llamada y pasar ambos nombres.

### 1.5 `create_class` genera clases que crashean el engine

`classFactory` pone `params: [[500, 30, 30, 30, 30, 30, 30, 30]]` (1 array de 8 valores), pero MV
espera **8 arrays de (nivel máx + 1) valores** (`params[paramId][level]`). Cualquier actor con una
clase creada por esta tool tiene HP/stats `undefined` → NaN en batalla. El inputSchema encima
documenta un array plano. **Fix**: aceptar 8 valores semilla y generar las 8 curvas de 100 niveles
(interpolación tipo editor), como hace el motor.

### 1.6 `set_map_display_names` no toca el displayName

Modifica `MapInfos[id].name` (nombre interno del árbol del editor), **no** `displayName` del
archivo de mapa (lo que ve el jugador). La tool hace lo contrario de lo que su nombre y
descripción prometen. **Fix**: escribir `displayName` en cada `MapNNN.json` (y opcionalmente
renombrar también el MapInfo con otro flag).

### 1.7 `analyze_screenshot` solo funciona con HTTP plano

Usa el módulo `http` con `port || 80`: cualquier `VISION_API_URL` con `https://` (OpenAI, NVIDIA)
falla. Además `VISION_API_PATH` default `''` postea a `/` en vez de `/v1/chat/completions`.
**Fix**: migrar a `fetch` global de Node, default del path a `/v1/chat/completions`.

---

## 2. Hallazgos transversales (afectan a muchas tools)

1. **Sin coerción numérica**: todos los inputSchema aceptan `['number','string']` pero solo
   `mapTools.toNum()` convierte. Un `create_actor` con `initialLevel: "5"` guarda el **string** en
   el JSON → comportamiento raro en el engine (`"5" + 1 === "51"`). Fix: coerción centralizada en
   el boundary (Zod `z.coerce.number()`).
2. **`id` inyectable en create/update**: `{...factory(id), ...params}` permite que `params.id`
   pise el ID asignado y desincronice índice/id. `crudHelper.update` lo protege, pero
   `updateSkill` y `updateMapEvent` (Object.assign manual) no. Fix: strip de `id` en params y
   migrar skills a `crudHelper`.
3. **Defaults con `||` que pisan valores falsy** (`skillTools.createSkill`): `iconIndex: 0` → 64,
   `successRate: 0` → 100, `scope: 0` → 1. Fix: `??` en todo el repo (`tsconfig` ya es ES2022).
4. **Hack de transporte JSON-RPC** (`server.ts` final): convierte ids numéricos de respuesta a
   string — viola JSON-RPC (el id debe responderse con el mismo tipo) y puede romper clientes
   estrictos. Averiguar para qué cliente se agregó; si no hay razón vigente, eliminarlo.
5. **`setSwitchName`/`setVariableName` sin tope**: `id: 5000000` crea un array de 5M entradas en
   System.json. Fix: validar 1 ≤ id ≤ 9999 (o configurable).
6. **Implementación duplicada**: `get_skills` usa `itemTools.getSkillsList` y existe
   `skillTools.getSkills` idéntico. Unificar en skillTools.
7. **Feature muerta**: `knowledge/` (106 templates, ~MB en el paquete) y
   `searchTemplates`/`generateFromTemplate` existen pero **ninguna tool los expone**
   (el `template_id` solo está en un schema Zod desconectado). Decidir: exponer como modo
   `template` de `generate_map`, o sacar `knowledge/` del paquete npm.
8. **Mis descripciones v4.1 prometen cosas que la impl. no hace** (corregir impl. o texto):
   `create_common_event` "agrega terminator si falta" (no lo hace); `populate_map_events`
   "posiciones walkable" (es random puro, puede caer en agua/muros); `get_tile_ids_for_tileset`
   "falla con error si no existe" (devuelve listas vacías); `create_chest` default real es
   `'Chest'`, no `'!Chest'` (sprite estándar de MV; el actual no existe en proyectos default).

---

## 3. Auditoría tool por tool (101)

Veredictos: ✅ OK · 🔧 FIX (funciona pero necesita corrección) · ❌ ROTA · 👀 REVISAR (probar in-engine)

**Actors** — `get_actors` ✅ · `get_actor` ✅ · `create_actor` 🔧 (coerción §2.1, id §2.2) ·
`update_actor` ✅ · `search_actors` ✅ · `delete_actor` ✅

**Items/Weapons/Armors** — `get_items` ✅ · `get_weapons` ✅ · `get_armors` ✅ · `get_skills` 🔧 (dup §2.6) ·
`create_item` 🔧 (§2.1/2.2) · `create_weapon` 🔧 (ídem; sacar campo extra `atk` no-MV) ·
`create_armor` 🔧 (ídem; campo extra `def`) · `update_item` ✅ · `search_items` ✅ · `delete_item` ✅

**Skills** — `get_skill` ✅ · `create_skill` 🔧 (defaults `||` §2.3, id §2.2, migrar a crudHelper) ·
`create_damage_skill` ❌ (§1.1) · `create_healing_skill` ❌ (§1.1) · `create_buff_skill` ❌ (§1.1) ·
`create_state_skill` ❌ (§1.1) · `update_skill` 🔧 (id §2.2) · `search_skills` ✅ · `delete_skill` ✅

**Maps** — `get_map_infos` ✅ · `get_map` ✅ · `get_map_events` ✅ · `get_map_event` ✅ ·
`create_map` ❌ (§1.1) · `fill_map_layer` ✅ · `create_map_event` ✅ ·
`generate_map_v3` ✅ · `generate_map_batch` ✅ ·
`connect_maps` 🔧 (la llegada cae SOBRE el evento espejo; offsetear 1 tile) ·
`populate_map_events` 🔧 (sin chequeo de walkability; `opts.x=0` cae al random por `||`) ·
`set_map_display_names` ❌ (§1.6) · `organize_map_tree` ✅ ·
`update_map_event` 🔧 (id §2.2) · `add_event_command` ✅ ·
`create_npc` ❌ (§1.1 + §1.2) · `create_chest` 🔧 (sprite default `'Chest'` inexistente → `'!Chest'`) ·
`create_teleport_event` ✅ · `search_map_events` ✅

**System** — `get_system` ✅ · `get_switches` ✅ · `get_variables` ✅ ·
`set_switch_name` 🔧 (§2.5) · `set_variable_name` 🔧 (§2.5) · `get_game_title` ✅ ·
`update_game_title` ✅ · `update_starting_position` ✅

**Classes** — `get_classes` ✅ · `get_class` ✅ · `create_class` ❌ (§1.5) · `update_class` ✅ ·
`search_classes` ✅ · `delete_class` ✅

**Enemies** — `get_enemies` ✅ · `get_enemy` ✅ ·
`create_enemy` 🔧 (action default `conditionType:1` (turnos) — el default del editor es 0=always) ·
`create_boss_enemy` 🔧 (`specialSkillId||2` → skill Guard si se pasa 0) · `update_enemy` ✅ ·
`search_enemies` ✅ · `delete_enemy` ✅

**States** — `get_states` ✅ · `get_state` ✅ · `create_state` ✅ · `update_state` ✅ ·
`search_states` ✅ · `delete_state` ✅

**Tilesets** — `get_tilesets` ✅ · `get_tileset` ✅ · `update_tileset` ✅

**Common Events** — `get_common_events` ✅ ·
`create_common_event` 🔧 (no garantiza terminator en `list` custom; `switchId` default 0 inválido si trigger>0 → loop infinito sin aviso) ·
`update_common_event` ✅ · `add_common_event_command` 🔧 (asume terminator; con `list` vacía inserta sin él)

**Troops** — `get_troops` ✅ · `get_troop` ✅ · `create_troop` ✅ · `add_enemy_to_troop` ✅ ·
`create_random_encounter_troop` ✅

**Animations** — `get_animations` ✅ · `get_animation` ✅

**Map helpers** — `delete_map_event` ✅ · `duplicate_map` 🔧 (acepta width/height internos sin
regenerar `data` → mapa corrupto; hoy inalcanzable porque el schema no los expone — eliminar) ·
`create_shop` ❌ (§1.3) · `create_inn` 👀 (estructura de indents del branch Yes/No no estándar;
probar in-engine que el flujo oro/recuperación funcione) · `create_boss_event` ❌ (§1.2) ·
`create_puzzle_switch` ❌ (§1.2 + §1.4)

**Project** — `get_project_summary` ✅ · `get_project_context` ✅ ·
`validate_map` 🔧 (chequeo self-switch invertido §1.2; agregar chequeo de data.length vs width×height×6) ·
`set_project_path` ✅

**Vision/Assets** — `analyze_tileset_image` ✅ · `read_screenshot` ✅ ·
`analyze_screenshot` 🔧 (§1.7) · `render_map_ascii` ✅ (su Zod limita layer a 0-4; el legend dice 0-5) ·
`scan_project_assets` 👀 (heurística A1: kinds 2-3 van a `ground` siendo cascadas; A4 wallTop como
ground sugiere muros caminables) · `get_tile_ids_for_tileset` 🔧 (vacío en vez de error si el
tileset no existe)

**Resumen**: 11 ❌ rotas · 24 🔧 con fix requerido · 3 👀 a verificar in-engine · 63 ✅.

---

## 4. Diseño v5 (breaking)

### 4.1 Consolidación: 101 → 12 tools

Motivación: Glama "Tool Count" 1/5 (recomienda 3-15) y "Disambiguation" 4/5. v5 es major, puede
romper. Los 101 nombres actuales se mapean así:

| # | Tool v5 | Absorbe | Diseño |
|---|---------|---------|--------|
| 1 | `query_database` | los 12 `get_*`/`search_*` de DB (actors…animations) | `{entity, id?, query?}` → lista, entrada única o resultados de búsqueda |
| 2 | `create_database_entry` | los 13 `create_*` de DB + helpers | `{entity, data, preset?}` — presets: `damage_skill`, `healing_skill`, `buff_skill`, `state_skill`, `boss_enemy`, `encounter_troop` |
| 3 | `update_database_entry` | los 9 `update_*` + `add_enemy_to_troop` + `add_common_event_command` | `{entity, id, fields?, append_command?, append_member?}` |
| 4 | `delete_database_entry` | los 7 `delete_*` de DB | `{entity, id}` con las advertencias de referencias |
| 5 | `query_map` | `get_map_infos/get_map/get_map_events/get_map_event/search_map_events/validate_map/render_map_ascii` | `{mapId?, view: infos\|full\|events\|event\|validate\|ascii, ...}` |
| 6 | `generate_map` | `create_map/generate_map_v3/generate_map_batch/duplicate_map` | `{mode: blank\|themed\|procedural\|batch\|duplicate\|template, ...}` — expone los 106 templates de `knowledge/` (§2.7) |
| 7 | `edit_map` | `fill_map_layer/set_map_display_names/organize_map_tree/connect_maps` | `{action, ...}` |
| 8 | `manage_map_event` | `create_map_event/update_map_event/delete_map_event/add_event_command/populate_map_events` + 7 helpers (npc/chest/teleport/shop/inn/boss/puzzle) | `{action: create\|update\|delete\|add_command\|populate, preset?: npc\|chest\|teleport\|shop\|inn\|boss\|puzzle_switch, ...}` |
| 9 | `manage_system` | los 8 de System.json | `{action: get\|set_title\|name_switch\|name_variable\|set_start, ...}` |
| 10 | `get_project_context` | + `get_project_summary`, `scan_project_assets`, `get_tile_ids_for_tileset` | `{detail: summary\|full\|assets\|tileset, tilesetId?}` |
| 11 | `set_project_path` | (igual) | |
| 12 | `analyze_image` | `analyze_screenshot/analyze_tileset_image/read_screenshot` | `{mode: ai\|grid\|colors, image_path?\|base64?}` |

Trade-off asumido: tools consolidadas = más parámetros por tool; se mitiga con discriminated
unions de Zod (schemas `oneOf` por `action`/`preset`/`view`) y descripciones por rama.

Compatibilidad: flag `RPGMV_LEGACY_TOOLS=1` que registra además los 101 nombres v4 como alias
finos sobre los mismos handlers (un release de transición, deprecado en v5.1).

### 4.2 Arquitectura

- **Zod como única fuente de verdad**: schemas en camelCase, `z.coerce.number()` para los campos
  numéricos (resuelve §1.1 y §2.1 de raíz), JSON Schema generado con `zod-to-json-schema`.
  Eliminar `SCHEMA_MAP` y el doble sistema de validación.
- **`outputSchema` + `structuredContent`**: actualizar `@modelcontextprotocol/sdk` y devolver
  resultados estructurados (criterio "Completeness" de Glama; hoy solo va en texto).
- **Capa CRUD única**: migrar skills (y los Object.assign manuales) a `crudHelper`; strip de `id`.
- **Quitar el hack de ids del transporte** (§2.4) salvo que haya un cliente identificado que lo requiera.
- Anotaciones y descripciones v4.1 se conservan/adaptan a las 12 tools.

### 4.3 Tests (la brecha que dejó pasar todo esto)

- Tests de integración sobre `handleToolCall` con un proyecto fixture mínimo en `tests/fixtures/`:
  cada action/preset al menos 1 caso happy-path + 1 de error (hoy: 0 tools cubiertas).
- Test "round-trip": crear NPC/chest/boss → leer el JSON del mapa → asertar comandos 123 con ON,
  terminators, params del 302 del shop.
- Test de coherencia schema↔handler: por cada tool, llamar con los argumentos del inputSchema y
  asertar que ningún argumento se pierde (previene la clase §1.1 para siempre).
- `validate_map` testeado contra fixtures con errores conocidos.

### 4.4 Orden de ejecución

1. **v4.1.1 (hotfix, no breaking, 1 sesión)**: §1.1 (alinear keys Zod), §1.2 (self switch + validador),
   §1.3 (shop), §1.4 (puzzle args), §1.5 (curvas de clase), §1.6 (displayName), §1.7 (https vision),
   `??` en skillTools, sprite `!Chest`. Tag + release (también destraba el ítem "No stable releases" de Glama).
2. **v5.0.0-beta**: consolidación 12 tools + Zod único + coerción + structuredContent + tests de integración.
3. **v5.0.0**: README/CHANGELOG/server.json nuevos, npm publish, GitHub Release, re-scan de Glama.

### 4.5 Verificación end-to-end

- `npm run typecheck && npm run build && npm test` (con los tests nuevos de integración).
- Smoke JSON-RPC: `tools/list` (12 tools, annotations, outputSchema) + `tools/call` de cada action.
- Prueba real: proyecto MV de prueba → crear NPC, chest, shop, boss, puzzle → abrir en RPG Maker MV
  y playtest (páginas 2 activándose, tienda con goods correctos, puerta que queda abierta).
