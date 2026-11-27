export const CONFIG_FILE = '.ndev.json'
export const LEGACY_CONFIG_FILE = '.neil-dev.json'
export const MIGRATE_CONFIG = 'ndev project migrate-config'

export type ConfigChoice =
  | { path: string; text: string | undefined; legacy: string | undefined; conflict?: undefined }
  | { conflict: { message: string; repair: string } }

const sorted = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted((value as Record<string, unknown>)[k])]))
      : value

const canonical = (text: string) => {
  try {
    return JSON.stringify(sorted(JSON.parse(text)))
  } catch {
    return text
  }
}

export const sameConfig = (a: string, b: string) => a === b || canonical(a) === canonical(b)

export function chooseConfig(root: string, current: string | undefined, legacy: string | undefined): ConfigChoice {
  const currentPath = `${root}/${CONFIG_FILE}`
  const legacyPath = `${root}/${LEGACY_CONFIG_FILE}`
  if (current !== undefined && legacy !== undefined && !sameConfig(current, legacy)) {
    return {
      conflict: {
        message: `${currentPath} and ${legacyPath} both exist and their settings differ, so neither is read`,
        repair: `Put the settings to keep in ${currentPath}, delete ${legacyPath}, then run ${MIGRATE_CONFIG} to check.`,
      },
    }
  }
  if (current !== undefined) return { path: currentPath, text: current, legacy: legacy === undefined ? undefined : legacyPath }
  if (legacy !== undefined) return { path: legacyPath, text: legacy, legacy: legacyPath }
  return { path: currentPath, text: undefined, legacy: undefined }
}
