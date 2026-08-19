/** Resolves a persisted, model-authorized skill catalog against freshly hydrated runtime skills. */
import path from "node:path";
import { isSkillSecretOwnerUnavailable } from "../loading/config.js";
import {
  WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
  type ModelInvocableSkillIdentity,
  type ResolvedSkill,
  type SkillSnapshot,
} from "../types.js";

const MODEL_SKILL_CATALOG_MAX_NAME_CHARS = 256;
const MODEL_SKILL_CATALOG_MAX_KEY_CHARS = 1_024;
const MODEL_SKILL_CATALOG_MAX_DESCRIPTION_CHARS = 16_000;
const MODEL_SKILL_CATALOG_MAX_VERSION_CHARS = 256;

export type AuthorizedModelSkill = {
  name: string;
  description: string;
  promptVersion?: string;
  readContent?: string;
  /** Local capability root; never return it through the model-facing tool. */
  resourceRoot?: string;
};

function isExactNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isExactBoundedString(value: unknown, maxChars: number): value is string {
  return isExactNonEmptyString(value) && value.length <= maxChars;
}

function indexUniqueIdentities(
  identities: readonly ModelInvocableSkillIdentity[],
): Map<string, ModelInvocableSkillIdentity> | undefined {
  const indexed = new Map<string, ModelInvocableSkillIdentity>();
  for (const identity of identities) {
    if (
      !identity ||
      typeof identity !== "object" ||
      !isExactBoundedString(identity.name, MODEL_SKILL_CATALOG_MAX_NAME_CHARS) ||
      !isExactBoundedString(identity.skillKey, MODEL_SKILL_CATALOG_MAX_KEY_CHARS) ||
      indexed.has(identity.name)
    ) {
      return undefined;
    }
    indexed.set(identity.name, identity);
  }
  return indexed;
}

function indexPersistedSkills(
  skills: SkillSnapshot["skills"],
): Map<string, { name: string; skillKey?: string }> | undefined {
  const indexed = new Map<string, { name: string; skillKey?: string }>();
  for (const skill of skills) {
    if (
      !skill ||
      typeof skill !== "object" ||
      !isExactBoundedString(skill.name, MODEL_SKILL_CATALOG_MAX_NAME_CHARS) ||
      (skill.skillKey !== undefined &&
        !isExactBoundedString(skill.skillKey, MODEL_SKILL_CATALOG_MAX_KEY_CHARS)) ||
      indexed.has(skill.name)
    ) {
      return undefined;
    }
    indexed.set(skill.name, skill);
  }
  return indexed;
}

function indexResolvedSkills(
  skills: readonly ResolvedSkill[],
): Map<string, ResolvedSkill> | undefined {
  const indexed = new Map<string, ResolvedSkill>();
  for (const skill of skills) {
    if (
      !skill ||
      typeof skill !== "object" ||
      !isExactBoundedString(skill.name, MODEL_SKILL_CATALOG_MAX_NAME_CHARS) ||
      !isExactBoundedString(skill.skillKey, MODEL_SKILL_CATALOG_MAX_KEY_CHARS) ||
      !isExactBoundedString(skill.description, MODEL_SKILL_CATALOG_MAX_DESCRIPTION_CHARS) ||
      !isExactNonEmptyString(skill.filePath) ||
      !isExactNonEmptyString(skill.baseDir) ||
      (skill.promptVersion !== undefined &&
        !isExactBoundedString(skill.promptVersion, MODEL_SKILL_CATALOG_MAX_VERSION_CHARS)) ||
      (skill.readContent !== undefined && typeof skill.readContent !== "string") ||
      indexed.has(skill.name)
    ) {
      return undefined;
    }
    indexed.set(skill.name, skill);
  }
  return indexed;
}

function resolveSkillResourceRoot(skill: ResolvedSkill): string | undefined | false {
  if (skill.readContent !== undefined) {
    return undefined;
  }
  if (!path.isAbsolute(skill.filePath) || !path.isAbsolute(skill.baseDir)) {
    return false;
  }
  const resourceRoot = path.resolve(skill.baseDir);
  return path.resolve(skill.filePath) === path.join(resourceRoot, "SKILL.md")
    ? resourceRoot
    : false;
}

/**
 * Intersects persisted prompt authority with persisted eligible identities and
 * the current hydrated runtime. Any malformed or ambiguous input fails closed.
 */
export function resolveAuthorizedModelSkills(
  snapshot: SkillSnapshot | undefined,
): AuthorizedModelSkill[] {
  if (
    !snapshot ||
    snapshot.promptFormatVersion !== WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION ||
    !Array.isArray(snapshot.modelInvocableSkills) ||
    !Array.isArray(snapshot.skills) ||
    !Array.isArray(snapshot.resolvedSkills)
  ) {
    return [];
  }
  const authorized = indexUniqueIdentities(snapshot.modelInvocableSkills);
  const persisted = indexPersistedSkills(snapshot.skills);
  const resolved = indexResolvedSkills(snapshot.resolvedSkills);
  if (!authorized || !persisted || !resolved) {
    return [];
  }

  const catalog: AuthorizedModelSkill[] = [];
  for (const identity of authorized.values()) {
    const persistedSkill = persisted.get(identity.name);
    const runtimeSkill = resolved.get(identity.name);
    if (
      !persistedSkill ||
      persistedSkill.skillKey !== identity.skillKey ||
      !runtimeSkill ||
      runtimeSkill.skillKey !== identity.skillKey
    ) {
      return [];
    }
    if (
      runtimeSkill.disableModelInvocation ||
      isSkillSecretOwnerUnavailable(runtimeSkill.skillKey)
    ) {
      continue;
    }
    const resourceRoot = resolveSkillResourceRoot(runtimeSkill);
    if (resourceRoot === false) {
      return [];
    }
    catalog.push({
      name: identity.name,
      description: runtimeSkill.description,
      ...(runtimeSkill.promptVersion ? { promptVersion: runtimeSkill.promptVersion } : {}),
      ...(runtimeSkill.readContent !== undefined ? { readContent: runtimeSkill.readContent } : {}),
      ...(resourceRoot ? { resourceRoot } : {}),
    });
  }
  return catalog.toSorted((left, right) => left.name.localeCompare(right.name));
}
