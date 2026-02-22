/**
 * Exotik Dices – Shared constants and helpers.
 *
 * Centralised here to avoid duplication across main.js,
 * ExotikDiceConfig.js, and dicePorting.js.
 */

export const MODULE_ID = "exotik-dices";

/** Foundry v13+ deprecates the global FilePicker; use the namespaced class. */
export const FP = foundry.applications.apps?.FilePicker ?? FilePicker;

const ASSETS_PATH = `modules/${MODULE_ID}/assets`;

/** Path to the module-shipped default dice. */
export const DICES_PATH = `${ASSETS_PATH}/dices`;

/** Default user data folder for custom dice. */
export const DEFAULT_USER_DICES_PATH = `${MODULE_ID}/dices`;

/** Path to shared 3D geometries (.glb files). */
export const GEOMETRIES_PATH = `${ASSETS_PATH}/geometries`;

/** Runtime accessor for the user-configurable dice data path. */
export function getUserDicePath() {
    try {
        return game.settings.get(MODULE_ID, "diceDataPath") || DEFAULT_USER_DICES_PATH;
    } catch {
        return DEFAULT_USER_DICES_PATH;
    }
}
