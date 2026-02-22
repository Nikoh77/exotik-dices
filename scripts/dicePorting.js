/**
 * Exotik Dices – Filesystem sync & Export helpers.
 *
 * The filesystem is the **single source of truth** for dice definitions.
 * Each dice lives in its own folder and contains a `dice.json` file.
 *
 * On startup (`syncDiceFromFilesystem`) the module scans all dice folders,
 * reads every `dice.json`, and compares the result with the DB cache
 * (`diceDefinitions` setting).  If anything changed the cache is updated
 * and a world-reload is requested so that CONFIG.Dice.terms can be
 * re-registered.
 *
 * Export builds a portable ZIP of the dice folder (dice.json + assets).
 *
 * `writeDiceJson` uploads a fresh dice.json into a dice folder via
 * FilePicker.upload so the editor can persist changes.
 */

import { zipSync } from "./vendor/fflate.min.js";

const MODULE_ID = "exotik-dices";

/** Foundry v13+ deprecates the global FilePicker; use the namespaced class. */
const FP = foundry.applications.apps?.FilePicker ?? FilePicker;

/** Module-shipped default dice path. */
const DICES_PATH = `modules/${MODULE_ID}/assets/dices`;
const DEFAULT_USER_DICES_PATH = `${MODULE_ID}/dices`;

/** Runtime accessor for the user-configurable dice data path. */
function getUserDicePath() {
    try {
        return (
            game.settings.get(MODULE_ID, "diceDataPath") ||
            DEFAULT_USER_DICES_PATH
        );
    } catch {
        return DEFAULT_USER_DICES_PATH;
    }
}

/* ──────────────────────────────────────────── */
/*  Export                                       */
/* ──────────────────────────────────────────── */

/**
 * Recursively collect all file paths under a given folder via FilePicker.
 * @param {string} dir  Server-relative path
 * @returns {Promise<string[]>}
 */
async function collectFiles(dir) {
    const result = await FP.browse("data", dir);
    let files = [...(result.files || [])];
    for (const sub of result.dirs || []) {
        files = files.concat(await collectFiles(sub));
    }
    return files;
}

/**
 * Export a dice definition as a downloadable ZIP blob.
 *
 * The ZIP contains:
 *   <slug>/dice.json          — definition (freshly serialised)
 *   <slug>/textures/...       — all asset files
 *   <slug>/bump_maps/...
 *   <slug>/chat_2d/...
 *
 * @param {object} diceDef   The dice definition object
 */
export async function exportDice(diceDef) {
    const slug = diceDef.slug;
    if (!slug) {
        ui.notifications.error("Cannot export a dice without a slug.");
        return;
    }

    // Determine base path: try user data first, then module assets
    let basePath;
    try {
        await FP.browse("data", `${getUserDicePath()}/${slug}`);
        basePath = `${getUserDicePath()}/${slug}`;
    } catch {
        basePath = `${DICES_PATH}/${slug}`;
    }
    const prefixLen = basePath.length + 1;

    // Collect all files from the dice folder
    let allFiles;
    try {
        allFiles = await collectFiles(basePath);
    } catch (e) {
        console.warn(
            `${MODULE_ID} | exportDice: could not browse ${basePath}`,
            e,
        );
        ui.notifications.error(
            game.i18n.format("EKD.Export.FolderError", { name: diceDef.name }),
        );
        return;
    }

    // Filter out any dice.json already on disk (we generate a fresh one)
    const assetFiles = allFiles.filter(
        (f) => !f.endsWith("/dice.json") && !f.endsWith("\\dice.json"),
    );

    // Build the fflate input object
    const zipInput = {};

    // 1. Fresh dice.json with relative paths
    const exportDef = foundry.utils.deepClone(diceDef);
    for (const face of exportDef.faceMap || []) {
        for (const key of ["texture", "bump", "icon"]) {
            if (face[key] && face[key].startsWith(basePath)) {
                face[key] = face[key].slice(prefixLen);
            }
        }
    }
    const jsonBytes = new TextEncoder().encode(
        JSON.stringify(exportDef, null, 2),
    );
    zipInput[`${slug}/dice.json`] = jsonBytes;

    // 2. Asset files
    const fetchPromises = assetFiles.map(async (filePath) => {
        try {
            const resp = await fetch(filePath);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const buf = await resp.arrayBuffer();
            const relPath = filePath.slice(basePath.length - slug.length);
            zipInput[relPath] = new Uint8Array(buf);
        } catch (e) {
            console.warn(`${MODULE_ID} | exportDice: skipping ${filePath}`, e);
        }
    });
    await Promise.all(fetchPromises);

    // 3. Create ZIP
    const zipped = zipSync(zipInput, { level: 6 });
    const blob = new Blob([zipped], { type: "application/zip" });

    // 4. Trigger browser download
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    ui.notifications.info(
        game.i18n.format("EKD.Export.Success", { name: diceDef.name }),
    );
}

/* ──────────────────────────────────────────── */
/*  Write dice.json                              */
/* ──────────────────────────────────────────── */

/**
 * Write (or overwrite) a dice.json file inside a dice folder.
 *
 * Paths in faceMap are converted to relative (relative to the dice folder)
 * before writing, so the result is portable.
 *
 * @param {object} diceDef   The dice definition (with absolute paths)
 * @param {string} basePath  The dice folder  e.g. "exotik-dices/dices/my_slug"
 */
export async function writeDiceJson(diceDef, basePath) {
    const exportDef = foundry.utils.deepClone(diceDef);

    // Convert absolute paths to relative
    const prefix = basePath.endsWith("/") ? basePath : basePath + "/";
    for (const face of exportDef.faceMap || []) {
        for (const key of ["texture", "bump", "icon"]) {
            if (face[key] && face[key].startsWith(prefix)) {
                face[key] = face[key].slice(prefix.length);
            }
        }
    }

    const jsonStr = JSON.stringify(exportDef, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const file = new File([blob], "dice.json", { type: "application/json" });

    try {
        await FP.upload("data", basePath, file, {});
        console.log(`${MODULE_ID} | dice.json written to ${basePath}`);
    } catch (err) {
        console.error(`${MODULE_ID} | Failed to write dice.json to ${basePath}:`, err);
        throw err;
    }
}

/* ──────────────────────────────────────────── */
/*  Filesystem -> DB sync                        */
/* ──────────────────────────────────────────── */

/**
 * Read a dice.json from disk, resolving relative paths to absolute.
 *
 * @param {string} jsonPath  Full server path to the dice.json file
 * @param {string} folderPath  The parent folder path
 * @returns {Promise<object|null>}  Parsed definition or null
 */
async function readDiceJson(jsonPath, folderPath) {
    try {
        const resp = await fetch(jsonPath);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const def = await resp.json();

        if (!def.name || !def.denomination || !def.faceMap) {
            console.warn(`${MODULE_ID} | Invalid dice.json in ${folderPath}`);
            return null;
        }

        // Resolve relative asset paths to absolute
        const prefix = folderPath.endsWith("/") ? folderPath : folderPath + "/";
        for (const face of def.faceMap || []) {
            for (const key of ["texture", "bump", "icon"]) {
                if (
                    face[key] &&
                    !face[key].startsWith("modules/") &&
                    !face[key].startsWith(MODULE_ID)
                ) {
                    face[key] = prefix + face[key];
                }
            }
        }

        // Ensure slug matches folder name
        def.slug = folderPath.split("/").pop();

        return def;
    } catch (e) {
        console.warn(`${MODULE_ID} | Could not read ${jsonPath}:`, e);
        return null;
    }
}

/**
 * Scan all dice folders, read their dice.json files, and compare with the
 * DB cache.  If anything changed, update the cache.
 *
 * @returns {Promise<{changed: boolean, definitions: object[]}>}
 *   `changed` is true when the DB was updated (caller should prompt reload).
 *   `definitions` is the up-to-date array of dice definitions.
 */
export async function syncDiceFromFilesystem() {
    const dirsToScan = [DICES_PATH, getUserDicePath()];
    const allSubDirs = [];

    for (const scanPath of dirsToScan) {
        try {
            const result = await FP.browse("data", scanPath);
            for (const dir of result.dirs || []) {
                allSubDirs.push(dir);
            }
        } catch {
            // Folder doesn't exist yet - skip
        }
    }

    // Read every dice.json found on disk
    /** @type {Map<string, object>}  slug -> definition */
    const fsDefinitions = new Map();

    for (const dir of allSubDirs) {
        let folderResult;
        try {
            folderResult = await FP.browse("data", dir);
        } catch {
            continue;
        }

        const diceJsonPath = (folderResult.files || []).find(
            (f) => f.endsWith("/dice.json") || f.endsWith("\\dice.json"),
        );
        if (!diceJsonPath) continue;

        const def = await readDiceJson(diceJsonPath, dir);
        if (!def) continue;

        // Check for denomination conflicts between FS dice
        const conflicting = [...fsDefinitions.values()].find(
            (d) => d.denomination === def.denomination && d.slug !== def.slug,
        );
        if (conflicting) {
            console.warn(
                `${MODULE_ID} | sync: denomination "${def.denomination}" conflict between ` +
                `"${def.name}" and "${conflicting.name}", skipping ${def.slug}`,
            );
            ui.notifications.warn(
                game.i18n.format("EKD.Import.DenomConflict", {
                    name: def.name,
                    denom: def.denomination,
                    existing: conflicting.name,
                }),
            );
            continue;
        }

        fsDefinitions.set(def.slug, def);
    }

    // Compare with DB cache
    const cachedDefs = game.settings.get(MODULE_ID, "diceDefinitions") || [];
    const cachedMap = new Map(
        cachedDefs.filter((d) => d.slug).map((d) => [d.slug, d]),
    );

    // Detect changes
    let changed = false;

    // 1. Check for additions / modifications
    for (const [slug, fsDef] of fsDefinitions) {
        const cached = cachedMap.get(slug);
        if (!cached) {
            // New dice from filesystem
            if (!fsDef.id) fsDef.id = foundry.utils.randomID();
            console.log(`${MODULE_ID} | sync: new dice "${fsDef.name}" from ${slug}/`);
            changed = true;
        } else {
            // Preserve the DB id
            fsDef.id = cached.id;
            // Check if definition changed
            if (JSON.stringify(cached) !== JSON.stringify(fsDef)) {
                console.log(`${MODULE_ID} | sync: updated dice "${fsDef.name}" from ${slug}/`);
                changed = true;
            }
        }
    }

    // 2. Check for removals (in cache but not on filesystem)
    for (const [slug, cached] of cachedMap) {
        if (!fsDefinitions.has(slug)) {
            console.log(`${MODULE_ID} | sync: dice "${cached.name}" removed (folder ${slug}/ no longer exists)`);
            changed = true;
        }
    }

    // Update DB cache if anything changed
    if (changed) {
        const newDefs = [...fsDefinitions.values()];
        // Ensure every definition has an id
        for (const d of newDefs) {
            if (!d.id) d.id = foundry.utils.randomID();
        }
        await game.settings.set(MODULE_ID, "diceDefinitions", newDefs);
        console.log(
            `${MODULE_ID} | sync: DB cache updated - ${newDefs.length} dice definition(s)`,
        );
    } else {
        console.log(
            `${MODULE_ID} | sync: filesystem and DB cache are in sync (${fsDefinitions.size} dice)`,
        );
    }

    return {
        changed,
        definitions: [...fsDefinitions.values()],
    };
}
