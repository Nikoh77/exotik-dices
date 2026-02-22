/**
 * Exotik Dices Module for Foundry VTT v13+
 *
 * Dynamically registers user-defined custom dice with Dice So Nice
 * integration.  Dice definitions are stored on the filesystem (dice.json
 * per dice folder) with a DB cache for fast synchronous init.
 */

import {
    ExotikDiceConfig,
    markdownToHtml,
    resolveFace,
} from "./ExotikDiceConfig.js";

import { exportDice, syncDiceFromFilesystem } from "./dicePorting.js";

import {
    MODULE_ID,
    FP,
    DICES_PATH,
    DEFAULT_USER_DICES_PATH,
    GEOMETRIES_PATH,
    getUserDicePath,
} from "./constants.js";

/* ---------------------------------------- */
/*  Runtime lookup maps                      */
/* ---------------------------------------- */

/** @type {Map<string, object>}  denomination -> dice definition */
const _diceDefinitions = new Map();

/** Set of dice types we own (e.g. "dh", "dc") — shared with DSN monkey-patch. */
const _ekdDiceTypes = new Set();

/* ---------------------------------------- */
/*  Dynamic Dice Class Factory               */
/* ---------------------------------------- */

/**
 * Create a dice subclass for a given definition.
 * @param {object} def  Dice definition from settings
 * @returns {typeof foundry.dice.terms.Die}
 */
function createDiceClass(def) {
    const { denomination, faces: faceCount, faceMap } = def;

    const DynamicDice = class extends foundry.dice.terms.Die {
        constructor(termData = {}) {
            super({ ...termData, faces: faceCount });
        }

        static DENOMINATION = denomination;

        /** @override */
        getResultLabel(result) {
            const faceDef = resolveFace(faceMap, result.result - 1);
            if (!faceDef?.icon) return String(result.result);
            const title = faceDef.label || String(result.result);
            return `<img src="${faceDef.icon}" title="${title}"/>`;
        }

        /** @override */
        getResultCSS(result) {
            return [
                "ekd-die",
                `d${faceCount}`,
                result.rerolled ? "rerolled" : null,
                result.exploded ? "exploded" : null,
                result.discarded ? "discarded" : null,
            ];
        }
    };

    Object.defineProperty(DynamicDice, "name", {
        value: `ExotikDice_${denomination}`,
    });

    return DynamicDice;
}

/* ---------------------------------------- */
/*  DSN helpers                              */
/* ---------------------------------------- */

/** Map face count -> DSN geometry key */
function getDSNGeometryType(faces) {
    const map = { 4: "d4", 6: "d6", 8: "d8", 10: "d10", 12: "d12", 20: "d20" };
    return map[faces] || "d6";
}

/**
 * Register (or re-register) dice classes and DSN presets on the fly,
 * without requiring a page reload.  Handles additions, modifications,
 * and removals compared to the previous _diceDefinitions state.
 *
 * @param {object[]} definitions  Up-to-date array of dice definitions
 */
function registerDiceOnTheFly(definitions) {
    const oldDenoms = new Set(_diceDefinitions.keys());

    _diceDefinitions.clear();
    for (const def of definitions) {
        _diceDefinitions.set(def.denomination, def);
        const DiceClass = createDiceClass(def);
        CONFIG.Dice.terms[DiceClass.name] = DiceClass;
        CONFIG.Dice.terms[def.denomination] = DiceClass;

        _ekdDiceTypes.add(`d${def.denomination}`);
        oldDenoms.delete(def.denomination);
        console.log(
            `${MODULE_ID} | Registered dice: d${def.denomination} - "${def.name}"`,
        );
    }

    // Clean up dice that were removed from the filesystem
    for (const denom of oldDenoms) {
        delete CONFIG.Dice.terms[`ExotikDice_${denom}`];
        delete CONFIG.Dice.terms[denom];
        _ekdDiceTypes.delete(`d${denom}`);
        console.log(`${MODULE_ID} | Unregistered dice: d${denom}`);
    }

    // Re-register DSN presets if DSN is already active
    if (game.dice3d) applyDSNPresets(game.dice3d);
}

/* ---------------------------------------- */
/*  Settings registration                    */
/* ---------------------------------------- */

function registerSettings() {
    // DB cache of dice definitions (populated by filesystem sync).
    // This is NOT the source of truth — the filesystem is.
    game.settings.register(MODULE_ID, "diceDefinitions", {
        name: "EKD.Settings.DiceDefinitions",
        scope: "world",
        config: false,
        type: Array,
        default: [],
    });

    game.settings.register(MODULE_ID, "diceDataPath", {
        name: "EKD.Settings.DiceDataPath",
        hint: "EKD.Settings.DiceDataPathHint",
        scope: "world",
        config: false,
        type: String,
        default: DEFAULT_USER_DICES_PATH,
    });

    game.settings.registerMenu(MODULE_ID, "diceConfig", {
        name: "EKD.Settings.ConfigureDice",
        label: "EKD.Settings.ConfigureLabel",
        hint: "EKD.Settings.ConfigureHint",
        icon: "fas fa-dice",
        type: ExotikDiceConfig,
        restricted: true,
    });
}

/* ---------------------------------------- */
/*  Chat-message summary builder             */
/* ---------------------------------------- */

/**
 * Build an HTML summary string for all Exotik dice results in a set of rolls.
 * Groups identical face icons and shows counts.
 * @param {Roll[]} rolls
 * @returns {string|null}
 */
function buildChatSummary(rolls) {
    /** @type {{ denomination: string, result: number, active: boolean }[]} */
    const allResults = [];

    for (const roll of rolls) {
        for (const term of roll.terms || []) {
            const denom = term.constructor?.DENOMINATION;
            if (denom && _diceDefinitions.has(denom)) {
                for (const r of term.results) {
                    allResults.push({ ...r, denomination: denom });
                }
            }
        }
    }
    if (!allResults.length) return null;

    // Group by icon path (or label if no icon)
    const groups = new Map();
    for (const r of allResults) {
        if (!r.active) continue;
        const def = _diceDefinitions.get(r.denomination);
        const faceDef = resolveFace(def?.faceMap || [], r.result - 1);
        if (!faceDef) continue;
        // Only include faces that have an icon or label defined
        if (!faceDef.icon && !faceDef.label) continue;

        const key = faceDef.icon || faceDef.label;
        if (!groups.has(key)) {
            groups.set(key, {
                label: faceDef.label || "",
                icon: faceDef.icon,
                count: 0,
            });
        }
        groups.get(key).count++;
    }

    const parts = [];
    for (const [, g] of groups) {
        if (g.count <= 0) continue;
        const iconHtml = g.icon
            ? `<img src="${g.icon}" class="ekd-summary-icon" title="${g.label}"/>`
            : `<span>${g.label}</span>`;
        parts.push(
            `<span class="ekd-summary-item">${iconHtml} x${g.count}</span>`,
        );
    }

    return parts.length
        ? `<div class="ekd-dice-summary">${parts.join("")}</div>`
        : null;
}

/* ---------------------------------------- */
/*  Hooks                                    */
/* ---------------------------------------- */

Hooks.once("init", () => {
    registerSettings();

    // Load dice definitions from DB cache (synchronous) and register
    // Die subclasses.  The cache is kept in sync with the filesystem
    // by syncDiceFromFilesystem() which runs in the "ready" hook.
    const definitions = game.settings.get(MODULE_ID, "diceDefinitions") || [];

    for (const def of definitions) {
        _diceDefinitions.set(def.denomination, def);
        const DiceClass = createDiceClass(def);

        // Register by class name (v13 primary key) AND by denomination (compat)
        CONFIG.Dice.terms[DiceClass.name] = DiceClass;
        CONFIG.Dice.terms[def.denomination] = DiceClass;

        console.log(
            `${MODULE_ID} | Registered dice: d${def.denomination} - "${def.name}" (${def.faces} faces, class=${DiceClass.name})`,
        );
    }
});

Hooks.once("ready", () => {
    // Warn if Dice So Nice is missing
    if (!game.modules.get("dice-so-nice")?.active) {
        ui.notifications.warn(game.i18n.localize("EKD.DSNRequired"));
    }

    // ── Filesystem -> DB sync ──
    // Scans all dice folders for dice.json files and updates the DB cache.
    // When changes are detected, dice classes and DSN presets are
    // registered on the fly — no page reload is ever required.
    syncDiceFromFilesystem().then(({ changed, definitions }) => {
        if (!changed) return;
        registerDiceOnTheFly(definitions);
    }).catch((err) => {
        console.error(`${MODULE_ID} | syncDiceFromFilesystem error:`, err);
    });
});

/* ---------------------------------------- */
/*  Chat Message Rendering                   */
/* ---------------------------------------- */

Hooks.on("renderChatMessageHTML", (message, html) => {
    if (!message.rolls?.length) return;

    const summaryHtml = buildChatSummary(message.rolls);
    if (!summaryHtml) return;

    const totalEl = html.querySelector(".dice-total");
    if (totalEl) {
        totalEl.innerHTML = summaryHtml;
        totalEl.classList.add("ekd-total");
    }
});

/* ---------------------------------------- */
/*  Settings panel - dice list injection     */
/* ---------------------------------------- */

/**
 * Inject the dice list directly into the Game Settings panel
 * so users can see/manage dice without opening a separate window.
 */
Hooks.on("renderSettingsConfig", (app, ...renderArgs) => {
    // Support both AppV1 (jQuery) and AppV2 (HTMLElement) parameter styles
    let root;
    if (renderArgs[0] instanceof HTMLElement) {
        root = renderArgs[0];
    } else if (renderArgs[0]?.[0] instanceof HTMLElement) {
        root = renderArgs[0][0];
    }
    if (!root) {
        root =
            app.element instanceof HTMLElement ? app.element : app.element?.[0];
    }
    if (!root) return;

    // Find our module's category section (try several v13 selectors)
    let section =
        root.querySelector(`[data-category-id="${MODULE_ID}"]`) ||
        root.querySelector(`[data-category="${MODULE_ID}"]`);

    // Fallback: search headings for our module title
    if (!section) {
        for (const el of root.querySelectorAll(
            "h2, h3, h4, .category-title, label, .module-header",
        )) {
            if (el.textContent?.includes("Exotik Dices")) {
                section =
                    el.closest("section") ||
                    el.closest(".category") ||
                    el.closest("[data-category-id]") ||
                    el.closest("[data-category]");
                break;
            }
        }
    }
    if (!section) return;

    // Already injected? (idempotency for re-renders)
    if (section.querySelector(".ekd-settings-dice")) return;

    // Find the submenu form-group to replace
    const submenu =
        section.querySelector(".submenu") ||
        section.querySelector(`[data-setting-id="${MODULE_ID}.diceConfig"]`) ||
        section.querySelector(".form-group");
    if (!submenu) return;

    // Build injected HTML
    const definitions = game.settings.get(MODULE_ID, "diceDefinitions") || [];
    const t = {
        hint: game.i18n.localize("EKD.Config.Hint"),
        hintNote: game.i18n.localize("EKD.Config.HintNote"),
        addDice: game.i18n.localize("EKD.Config.AddDice"),
        refresh: game.i18n.localize("EKD.Config.Refresh"),
        edit: game.i18n.localize("EKD.Config.Edit"),
        exp: game.i18n.localize("EKD.Config.Export"),
        faces: game.i18n.localize("EKD.Config.FacesLabel"),
        noDice: game.i18n.localize("EKD.Config.NoDice"),
        readme: game.i18n.localize("EKD.Config.README"),
    };

    // Language display + Instructions button
    const langNames = { en: "English", it: "Italiano" };
    const curLang = game.i18n.lang || "en";
    const langDisplay = langNames[curLang] || curLang;

    let listHtml = `<div class="ekd-settings-dice">`;
    listHtml += `<div class="ekd-settings-header">`;
    listHtml += `<span class="ekd-settings-lang"><i class="fas fa-globe"></i> ${langDisplay}</span>`;
    listHtml += `<button type="button" class="ekd-settings-help"><i class="fas fa-book-open"></i> ${t.readme}</button>`;
    listHtml += `</div>`;
    listHtml += `<div class="ekd-folder-hints">`;
    listHtml += `<p class="notes ekd-hint-main">${t.hint}</p>`;
    listHtml += `<p class="notes ekd-hint-note">${t.hintNote}</p>`;
    listHtml += `</div>`;

    // Dice data path with browse button
    const currentPath = getUserDicePath();
    listHtml += `<div class="form-group ekd-path-group">
            <label>${game.i18n.localize("EKD.Settings.DiceDataPath")}</label>
            <div class="form-fields">
                <input type="text" class="ekd-path-input" value="${currentPath}" />
                <button type="button" class="ekd-path-browse file-picker" title="Browse">
                    <i class="fas fa-folder-open"></i>
                </button>
            </div>
            <p class="notes">${game.i18n.localize("EKD.Settings.DiceDataPathHint")}</p>
        </div>`;
    listHtml += `<div class="ekd-settings-buttons">
            <button type="button" class="ekd-settings-add">
                <i class="fas fa-plus"></i> ${t.addDice}
            </button>
            <button type="button" class="ekd-settings-refresh">
                <i class="fas fa-sync-alt"></i> ${t.refresh}
            </button>
        </div>`;
    if (definitions.length) {
        // Folder management instructions
        listHtml += `<div class="ekd-folder-hints">`;
        listHtml += `<p class="notes">${game.i18n.format("EKD.Config.FolderAddHint", { path: currentPath })}</p>`;
        listHtml += `<p class="notes">${game.i18n.format("EKD.Config.FolderRemoveHint", { path: currentPath })}</p>`;
        listHtml += `</div>`;
        listHtml += `<ul class="ekd-settings-list">`;
        for (const d of definitions) {
            // Dice shipped with the module (under modules/ path) are read-only
            const isModuleDice = d.slug && d.faceMap?.[0]?.texture?.startsWith?.(`modules/${MODULE_ID}/`);
            const editBtn = isModuleDice
                ? ""
                : `<a class="ekd-settings-edit" title="${t.edit}"><i class="fas fa-edit"></i></a>`;
            listHtml += `
                <li class="ekd-settings-entry flexrow" data-id="${d.id}">
                    <span class="ekd-settings-name flex2">${d.name}</span>
                    <span class="ekd-settings-denom flex0">d${d.denomination}</span>
                    <span class="ekd-settings-faces flex0">${d.faces} ${t.faces}</span>
                    <span class="ekd-settings-controls flex0">
                        <a class="ekd-settings-export" title="${t.exp}"><i class="fas fa-file-export"></i></a>
                        ${editBtn}
                    </span>
                </li>`;
        }
        listHtml += `</ul>`;
    } else {
        listHtml += `<p class="ekd-no-dice">${t.noDice}</p>`;
    }
    listHtml += `</div>`;

    // Replace the submenu form-group
    submenu.outerHTML = listHtml;

    // Attach event listeners to the injected content
    const injected = section.querySelector(".ekd-settings-dice");
    if (!injected) return;

    injected.addEventListener("click", (event) => {
        const target = event.target;

        if (target.closest(".ekd-settings-edit")) {
            event.preventDefault();
            const id = target.closest("[data-id]")?.dataset.id;
            const dice = definitions.find((d) => d.id === id);
            if (!dice) return;
            ExotikDiceConfig.editDice(dice, app);
        }

        if (target.closest(".ekd-settings-export")) {
            event.preventDefault();
            const id = target.closest("[data-id]")?.dataset.id;
            const dice = definitions.find((d) => d.id === id);
            if (dice) exportDice(dice);
        }

        if (target.closest(".ekd-settings-add")) {
            event.preventDefault();
            ExotikDiceConfig.editDice(null, app);
        }

        if (target.closest(".ekd-settings-refresh")) {
            event.preventDefault();
            syncDiceFromFilesystem().then(({ changed, definitions }) => {
                if (changed) {
                    registerDiceOnTheFly(definitions);
                    ui.notifications.info(
                        game.i18n.localize("EKD.Import.Synced"),
                    );
                } else {
                    ui.notifications.info(
                        game.i18n.localize("EKD.Import.NoneFound"),
                    );
                }
                app.render(true);
            }).catch((err) => {
                console.error(`${MODULE_ID} | sync error:`, err);
                ui.notifications.error("Sync failed - see console.");
            });
        }

        if (target.closest(".ekd-settings-help")) {
            event.preventDefault();
            fetch(`modules/${MODULE_ID}/README.md`)
                .then((r) => r.text())
                .then((md) => {
                    new Dialog({
                        title: "Exotik Dices - README",
                        content: `<div class="ekd-readme" style="max-height:500px;overflow:auto;padding:4px 8px;">${markdownToHtml(md)}</div>`,
                        buttons: { ok: { label: "OK" } },
                        default: "ok",
                    }).render(true);
                })
                .catch(() => {
                    ui.notifications.warn("README.md not found.");
                });
        }

        if (target.closest(".ekd-path-browse")) {
            event.preventDefault();
            const pathInput = injected.querySelector(".ekd-path-input");
            const current = pathInput?.value || getUserDicePath();
            new FP({
                type: "folder",
                current,
                callback: async (path) => {
                    if (pathInput) pathInput.value = path;
                    await game.settings.set(MODULE_ID, "diceDataPath", path);
                    ui.notifications.info(
                        game.i18n.format("EKD.Settings.DiceDataPathSaved", {
                            path,
                        }),
                    );
                },
            }).render(true);
        }
    });

    // Save path on blur/enter
    const pathInput = injected.querySelector(".ekd-path-input");
    if (pathInput) {
        const savePath = async () => {
            const newPath = pathInput.value.trim();
            if (newPath && newPath !== getUserDicePath()) {
                await game.settings.set(MODULE_ID, "diceDataPath", newPath);
                ui.notifications.info(
                    game.i18n.format("EKD.Settings.DiceDataPathSaved", {
                        path: newPath,
                    }),
                );
            }
        };
        pathInput.addEventListener("change", savePath);
    }
});

/* ---------------------------------------- */
/*  Dice So Nice Integration                 */
/* ---------------------------------------- */

// When the editor saves a dice, re-register from the updated DB cache.
Hooks.on("ekdDiceChanged", () => {
    const definitions = game.settings.get(MODULE_ID, "diceDefinitions") || [];
    registerDiceOnTheFly(definitions);
});

/* ---------------------------------------- */
/*  DSN preset helper                        */
/* ---------------------------------------- */

/**
 * (Re-)register all known Exotik dice presets into DSN.
 * Safe to call multiple times — each call replaces any stale preset
 * data that DSN may have written back during its own update cycle.
 *
 * @param {object} dice3d  The DSN Dice3D instance
 */
function applyDSNPresets(dice3d) {
    for (const def of _diceDefinitions.values()) {
        const diceType = `d${def.denomination}`;
        const labels = def.faceMap.map((_, i) => resolveFace(def.faceMap, i)?.texture || "");
        const bumpMaps = def.faceMap.map((_, i) => resolveFace(def.faceMap, i)?.bump || "");
        const presetData = { type: diceType, labels, system: "ekd" };
        if (bumpMaps.some((b) => b)) presetData.bumpMaps = bumpMaps;
        try {
            dice3d.addDicePreset(presetData, getDSNGeometryType(def.faces));
        } catch (err) {
            console.warn(`${MODULE_ID} | DSN preset re-register error for ${diceType}:`, err);
        }
    }
    console.log(`${MODULE_ID} | DSN presets applied (${_diceDefinitions.size} dice)`);
}

Hooks.once("diceSoNiceReady", async (dice3d) => {
    console.log(`${MODULE_ID} | diceSoNiceReady fired`);

    // Register "Exotik Dices" as a selectable system in DSN dropdown.
    dice3d.addSystem({ id: "ekd", name: "Exotik Dices" }, false);

    const definitions = game.settings.get(MODULE_ID, "diceDefinitions") || [];
    const factory = dice3d.DiceFactory;

    // ── Register DSN presets via official API ──
    // Populate _ekdDiceTypes first, then apply presets.
    for (const def of definitions) {
        _ekdDiceTypes.add(`d${def.denomination}`);
    }
    applyDSNPresets(dice3d);

    // ── Intercept game.dice3d.update ──
    // DSN's settings-save flow calls game.dice3d.update(h) at the end of
    // _updateObject.  During that cycle DSN may re-process CONFIG.Dice.terms
    // and overwrite our presets with the internalAdd variants (which carry
    // HTML <img> strings as labels rather than plain texture URLs).
    // Re-applying our presets immediately after DSN's update restores the
    // correct state without a page reload.
    const _origUpdate = dice3d.update.bind(dice3d);
    dice3d.update = async function dsnUpdateWrapper(config) {
        await _origUpdate(config);
        applyDSNPresets(dice3d);
    };

    // ── Dynamic geometry swap ──
    // Scan geometries folder for .glb files
    let customGeoFiles;
    try {
        const result = await FP.browse("data", GEOMETRIES_PATH);
        customGeoFiles = new Map();
        for (const fp of result.files || []) {
            if (!fp.endsWith(".glb")) continue;
            const name = fp.split("/").pop().replace(".glb", "");
            customGeoFiles.set(name, fp);
        }
    } catch (e) {
        console.warn(`${MODULE_ID} | Could not scan geometries:`, e);
        customGeoFiles = new Map();
    }

    // Find dice that use custom geometries
    const customGeoUsers = definitions.filter(
        (d) => d.geometry !== "standard" && customGeoFiles.has(d.geometry),
    );

    // Load each unique GLB file
    const loadedGeometries = new Map();
    if (customGeoUsers.length) {
        const uniqueGeos = [...new Set(customGeoUsers.map((d) => d.geometry))];
        const loadPromises = uniqueGeos.map(
            (geoName) =>
                new Promise((resolve) => {
                    const glbPath = customGeoFiles.get(geoName);
                    factory.loaderGLTF.load(glbPath, (gltf) => {
                        let geometry = null;
                        gltf.scene.traverse((child) => {
                            if (child.isMesh && !geometry)
                                geometry = child.geometry;
                        });
                        if (geometry) {
                            loadedGeometries.set(geoName, geometry);
                            console.log(
                                `${MODULE_ID} | Geometry "${geoName}" loaded: ${geometry.attributes.position.count} vertices`,
                            );
                        }
                        resolve();
                    });
                }),
        );
        await Promise.all(loadPromises);
    }

    // Build denomination -> geometry map
    const denomToGeo = new Map();
    for (const def of customGeoUsers) {
        const geo = loadedGeometries.get(def.geometry);
        if (geo) denomToGeo.set(`d${def.denomination}`, geo);
    }

    // ── Monkey-patch DiceFactory.create ──
    // Only needed for geometry swap now. addDicePreset() handles the
    // system registration, so we no longer need to force system override.
    // However, we still force system="ekd" at render time to ensure our
    // textures are always used regardless of user's selected DSN system.
    if (_ekdDiceTypes.size > 0 || denomToGeo.size > 0) {
        const origCreate = factory.create.bind(factory);
        factory.create = async function (t, i, r) {
            // Force our dice to resolve from the "ekd" system
            if (_ekdDiceTypes.has(i) && r) {
                r = Object.assign({}, r, { system: "ekd" });
            }

            const mesh = await origCreate(t, i, r);

            // Geometry swap for custom GLB models
            const customGeo = denomToGeo.get(i);
            if (customGeo && mesh) {
                const baseScale = t.type === "board" ? this.baseScale : 60;
                const s = baseScale / 100;
                const geo = customGeo.clone();
                geo.scale(s, s, s);
                if (mesh.isMesh) {
                    mesh.geometry = geo;
                } else {
                    mesh.traverse((child) => {
                        if (child.isMesh) child.geometry = geo;
                    });
                }
            }
            return mesh;
        };

        console.log(
            `${MODULE_ID} | DiceFactory.create patched` +
            (_ekdDiceTypes.size ? ` - system override: [${[..._ekdDiceTypes].join(", ")}]` : "") +
            (denomToGeo.size ? ` - geometry swap: [${[...denomToGeo.keys()].join(", ")}]` : ""),
        );
    }
});
