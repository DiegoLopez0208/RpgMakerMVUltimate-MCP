import { createCrud } from "../utils/crudHelper.js";
import type { ClassParams, RpgMakerDbEntry } from "../types/rpgmaker.js";

interface Class extends RpgMakerDbEntry {
  params: number[][];
  expParams: number[];
  learnings: { level: number; skillId: number; note: string }[];
  traits: unknown[];
}

// MV expects params as 8 curves (one per stat) of 100 per-level values:
// params[paramId][level], level 1-99 (index 0 unused). A flat 8-value array
// here crashes the engine with NaN stats, so flat input is expanded below.
const DEFAULT_PARAM_SEEDS = [400, 80, 15, 15, 15, 15, 15, 15];

function buildParamCurves(seeds: number[]): number[][] {
  const curves: number[][] = [];
  for (let p = 0; p < 8; p++) {
    const base = Number(seeds[p] ?? DEFAULT_PARAM_SEEDS[p]) || DEFAULT_PARAM_SEEDS[p];
    const curve: number[] = [];
    for (let level = 0; level <= 99; level++) {
      // Linear growth from the seed at level 1 to 10x the seed at level 99
      const t = Math.max(0, level - 1) / 98;
      curve.push(Math.max(1, Math.round(base + base * 9 * t)));
    }
    curves.push(curve);
  }
  return curves;
}

function normalizeClassParams(params: unknown): number[][] {
  if (Array.isArray(params) && params.length > 0 && Array.isArray(params[0])) {
    return params as number[][]; // already full curves
  }
  if (Array.isArray(params)) {
    return buildParamCurves(params.map(Number));
  }
  return buildParamCurves(DEFAULT_PARAM_SEEDS);
}

function classFactory(id: number): Class {
  return {
    id,
    name: "",
    params: buildParamCurves(DEFAULT_PARAM_SEEDS),
    expParams: [30, 20, 30, 30],
    learnings: [],
    traits: [],
    note: "",
  };
}

const classesCrud = createCrud<Class>("Classes.json", classFactory);

async function getClasses(projectPath: string) {
  return classesCrud.getAll(projectPath);
}

async function getClass(projectPath: string, id: number) {
  return classesCrud.getById(projectPath, id);
}

async function createClass(projectPath: string, params: ClassParams) {
  return classesCrud.create(projectPath, (id) => ({
    ...classFactory(id),
    ...params,
    id,
    params: normalizeClassParams((params as Record<string, unknown>).params),
  }));
}

async function updateClass(projectPath: string, id: number, fields: Partial<ClassParams>) {
  const normalized = { ...fields } as Record<string, unknown>;
  if (normalized.params !== undefined) {
    normalized.params = normalizeClassParams(normalized.params);
  }
  return classesCrud.update(projectPath, id, normalized as Partial<Class>);
}

async function searchClasses(projectPath: string, query: string) {
  return classesCrud.search(projectPath, query, ["name"]);
}

async function deleteClass(projectPath: string, id: number) {
  const deleted = await classesCrud.delete(projectPath, id);
  return { deleted };
}

export { getClasses, getClass, createClass, updateClass, searchClasses, deleteClass };
