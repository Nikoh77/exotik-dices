/**
 * Exotik Dices – Filesystem sync & Export helpers.
 *
 * The filesystem is the **single source of truth** for dice definitions.
 * Each dice lives in its own folder and contains a `dice.json` file.
 *
 * On startup (`syncDiceFromFilesystem`) the module scans all dice folders,
 * reads every `dice.json`, and compares the result with the DB cache
 * (`diceDefinitions` setting).  If anything changed the cache is updated
 * and dice classes are registered on the fly via `registerDiceOnTheFly()`.
 *
 * Export builds a portable ZIP of the dice folder (dice.json + assets).
 *
 * `writeDiceJson` uploads a fresh dice.json into a dice folder via
 * FilePicker.upload so the editor can persist changes.
 */

import { zipSync, unzipSync } from "./vendor/fflate.min.js";
import { MODULE_ID, FP, DICES_PATH, getUserDicePath } from "./constants.js";

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
/*  Import                                       */
/* ──────────────────────────────────────────── */

/**
 * Validate a ZIP's contents for a valid dice import.
 *
 * Checks:
 *   1. A dice.json exists (at root or inside one subfolder)
 *   2. dice.json parses as valid JSON
 *   3. Required fields present: name, denomination, faceMap
 *   4. All referenced asset files (texture, bump, icon) exist in the ZIP
 *
 * @param {Object<string, Uint8Array>} entries  fflate unzipSync result
 * @returns {{ ok: boolean, error?: string, slug?: string, def?: object, prefix?: string }}
 */
function validateZipContents(entries) {
    const paths = Object.keys(entries);

    // Find dice.json – may be at root or inside a single subfolder
    const jsonKey = paths.find((p) => {
        const parts = p.split("/").filter(Boolean);
        const name = parts[parts.length - 1];
        return name === "dice.json" && parts.length <= 2;
    });

    if (!jsonKey) {
        return { ok: false, error: game.i18n.localize("EKD.Import.NoDiceJson") };
    }

    // Parse JSON
    let def;
    try {
        const text = new TextDecoder().decode(entries[jsonKey]);
        def = JSON.parse(text);
    } catch {
        return { ok: false, error: game.i18n.localize("EKD.Import.InvalidJson") };
    }

    // Required fields
    if (!def.name || !def.denomination || !Array.isArray(def.faceMap)) {
        return { ok: false, error: game.i18n.localize("EKD.Import.MissingFields") };
    }

    // Determine prefix (e.g. "my_dice/" if json was at "my_dice/dice.json")
    const prefix = jsonKey.includes("/")
        ? jsonKey.slice(0, jsonKey.lastIndexOf("/") + 1)
        : "";

    // Determine slug from the folder or dice def
    const slug = prefix
        ? prefix.split("/").filter(Boolean)[0]
        : def.slug || def.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

    // Verify all referenced assets exist in the ZIP
    for (const face of def.faceMap) {
        for (const key of ["texture", "bump", "icon"]) {
            const val = face[key];
            if (!val) continue;
            // The asset path in dice.json is relative to the dice folder
            const expectedKey = prefix + val;
            if (!entries[expectedKey]) {
                return {
                    ok: false,
                    error: game.i18n.format("EKD.Import.MissingAsset", { path: val }),
                };
            }
        }
    }

    return { ok: true, slug, def, prefix };
}

/**
 * Import a dice from a ZIP file selected by the user.
 *
 * Opens a native file dialog, validates the ZIP, and extracts
 * its contents to the user's dice data path.
 *
 * @param {Function} onComplete  Called after successful import with
 *                               no arguments – the caller should
 *                               trigger sync + re-render.
 */
export async function importDice(onComplete) {
    // Create a hidden file input to trigger the OS file dialog
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip";
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("change", async () => {
        const file = input.files?.[0];
        document.body.removeChild(input);
        if (!file) return;

        // Read the file as ArrayBuffer
        let buffer;
        try {
            buffer = await file.arrayBuffer();
        } catch {
            ui.notifications.error(game.i18n.localize("EKD.Import.InvalidZip"));
            return;
        }

        // Decompress
        let entries;
        try {
            entries = unzipSync(new Uint8Array(buffer));
        } catch {
            ui.notifications.error(game.i18n.localize("EKD.Import.InvalidZip"));
            return;
        }

        // Validate
        const result = validateZipContents(entries);
        if (!result.ok) {
            ui.notifications.error(result.error);
            return;
        }

        const { slug, def, prefix } = result;
        const userPath = getUserDicePath();
        const destFolder = `${userPath}/${slug}`;

        // Check denomination conflict with existing dice
        const existing = game.settings.get(MODULE_ID, "diceDefinitions") || [];
        const conflict = existing.find(
            (d) => d.denomination === def.denomination && d.slug !== slug,
        );
        if (conflict) {
            ui.notifications.error(
                game.i18n.format("EKD.Import.DenomConflict", {
                    name: def.name,
                    denom: def.denomination,
                    existing: conflict.name,
                }),
            );
            return;
        }

        // Upload every file from the ZIP to the destination folder
        try {
            const zipPaths = Object.keys(entries);
            for (const zipPath of zipPaths) {
                const data = entries[zipPath];
                // Skip directory entries (zero-length entries whose path ends with /)
                if (zipPath.endsWith("/") || data.length === 0) continue;

                // Compute relative path from the prefix and rebuild under slug
                let relPath;
                if (prefix && zipPath.startsWith(prefix)) {
                    relPath = zipPath.slice(prefix.length);
                } else {
                    relPath = zipPath;
                }

                // Determine the upload folder and filename
                const lastSlash = relPath.lastIndexOf("/");
                const fileName = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;
                const subFolder = lastSlash >= 0 ? relPath.slice(0, lastSlash) : "";
                const uploadDir = subFolder
                    ? `${destFolder}/${subFolder}`
                    : destFolder;

                // Build a File object from the Uint8Array
                const blob = new Blob([data]);
                const uploadFile = new File([blob], fileName);

                await FP.upload("data", uploadDir, uploadFile, {});
            }
        } catch (err) {
            console.error(`${MODULE_ID} | importDice upload error:`, err);
            ui.notifications.error(game.i18n.localize("EKD.Import.UploadFailed"));
            return;
        }

        ui.notifications.info(
            game.i18n.format("EKD.Import.Success", { name: def.name }),
        );

        if (typeof onComplete === "function") onComplete();
    });

    // Trigger the file dialog
    input.click();
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
 *   `changed` is true when the DB was updated.
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
