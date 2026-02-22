/**
 * Exotik Dices – Import / Export helpers.
 *
 * Export: builds a ZIP in memory (dice.json + asset files) and triggers
 *         a browser download.
 *
 * Import: at startup, scans the dices folder looking for sub-folders that
 *         do NOT have a matching entry in the DB. If a folder contains a
 *         dice.json it is imported automatically and the file is removed
 *         (best-effort deletion, non-blocking).
 */

import { zipSync } from "./vendor/fflate.min.js";

const MODULE_ID = "exotik-dices";
const DICES_PATH = `modules/${MODULE_ID}/assets/dices`;
const USER_DICES_PATH = `${MODULE_ID}/dices`;

/* ──────────────────────────────────────────── */
/*  Export                                       */
/* ──────────────────────────────────────────── */

/**
 * Recursively collect all file paths under a given folder via FilePicker.
 * @param {string} dir  Server-relative path (e.g. "modules/exotik-dices/assets/dices/foo")
 * @returns {Promise<string[]>}
 */
async function collectFiles(dir) {
    const result = await FilePicker.browse("data", dir);
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
 * Any old dice.json on disk is **excluded**; the freshly-generated one
 * is always used.
 *
 * @param {object} diceDef   The dice definition object (from DB)
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
        await FilePicker.browse("data", `${USER_DICES_PATH}/${slug}`);
        basePath = `${USER_DICES_PATH}/${slug}`;
    } catch {
        basePath = `${DICES_PATH}/${slug}`;
    }
    const prefixLen = basePath.length + 1; // strip up to and including the trailing /

    // --- Collect all files from the dice folder ---
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

    // Filter out any dice.json already on disk
    const assetFiles = allFiles.filter(
        (f) => !f.endsWith("/dice.json") && !f.endsWith("\\dice.json"),
    );

    // --- Build the fflate input object ---
    // { "<slug>/dice.json": Uint8Array, "<slug>/textures/foo.png": Uint8Array, ... }
    const zipInput = {};

    // 1. Fresh dice.json from the definition (make paths relative)
    const exportDef = foundry.utils.deepClone(diceDef);
    // Store relative paths so the ZIP is portable
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

    // 2. Asset files (download each into Uint8Array)
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
/*  Import (auto-discovery at startup)           */
/* ──────────────────────────────────────────── */

/**
 * Scan the dices folder for sub-folders that contain a dice.json but
 * are not yet in the DB.  Import those dice definitions automatically.
 *
 * @returns {Promise<number>}  Number of dice imported
 */
export async function autoImportDice() {
    // Scan both module assets and user data folders
    const dirsToScan = [DICES_PATH, USER_DICES_PATH];
    const allSubDirs = [];

    for (const scanPath of dirsToScan) {
        try {
            const result = await FilePicker.browse("data", scanPath);
            for (const dir of result.dirs || []) {
                allSubDirs.push(dir);
            }
        } catch {
            // Folder doesn't exist – skip
        }
    }

    if (allSubDirs.length === 0) return 0;

    const currentDefs = game.settings.get(MODULE_ID, "diceDefinitions") || [];
    const knownSlugs = new Set(currentDefs.map((d) => d.slug).filter(Boolean));
    const knownIds = new Set(currentDefs.map((d) => d.id).filter(Boolean));

    let imported = 0;

    for (const dir of allSubDirs) {
        // dir looks like "exotik-dices/dices/some_slug" or "modules/exotik-dices/assets/dices/some_slug"
        const slug = dir.split("/").pop();
        if (knownSlugs.has(slug)) continue; // already in DB

        // Look for dice.json in this folder
        let folderResult;
        try {
            folderResult = await FilePicker.browse("data", dir);
        } catch {
            continue;
        }

        const diceJsonPath = (folderResult.files || []).find(
            (f) => f.endsWith("/dice.json") || f.endsWith("\\dice.json"),
        );
        if (!diceJsonPath) continue;

        // Read and parse dice.json
        let diceDef;
        try {
            const resp = await fetch(diceJsonPath);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            diceDef = await resp.json();
        } catch (e) {
            console.warn(
                `${MODULE_ID} | autoImport: could not read ${diceJsonPath}`,
                e,
            );
            continue;
        }

        // Validate minimum required fields
        if (!diceDef.name || !diceDef.denomination || !diceDef.faceMap) {
            console.warn(
                `${MODULE_ID} | autoImport: invalid dice.json in ${dir}`,
            );
            continue;
        }

        // Resolve relative paths → full module paths
        const basePath = dir;
        for (const face of diceDef.faceMap || []) {
            for (const key of ["texture", "bump", "icon"]) {
                if (face[key] && !face[key].includes("/")) {
                    // bare filename → impossible, skip
                } else if (face[key] && !face[key].startsWith("modules/")) {
                    face[key] = `${basePath}/${face[key]}`;
                }
            }
        }

        // Ensure unique id
        if (!diceDef.id || knownIds.has(diceDef.id)) {
            diceDef.id = foundry.utils.randomID();
        }
        diceDef.slug = slug;

        // Check denomination conflict
        const denomConflict = currentDefs.find(
            (d) => d.denomination === diceDef.denomination,
        );
        if (denomConflict) {
            console.warn(
                `${MODULE_ID} | autoImport: denomination "${diceDef.denomination}" conflicts with "${denomConflict.name}", skipping ${slug}`,
            );
            ui.notifications.warn(
                game.i18n.format("EKD.Import.DenomConflict", {
                    name: diceDef.name,
                    denom: diceDef.denomination,
                    existing: denomConflict.name,
                }),
            );
            continue;
        }

        // Add to definitions
        currentDefs.push(diceDef);
        knownSlugs.add(slug);
        knownIds.add(diceDef.id);
        imported++;

        console.log(
            `${MODULE_ID} | autoImport: imported "${diceDef.name}" from ${slug}/dice.json`,
        );
    }

    if (imported > 0) {
        await game.settings.set(MODULE_ID, "diceDefinitions", currentDefs);
        ui.notifications.info(
            game.i18n.format("EKD.Import.Success", { count: imported }),
        );
    }

    return imported;
}
