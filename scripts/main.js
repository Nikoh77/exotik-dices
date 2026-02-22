/**
 * Exotik Dices Module for Foundry VTT v13+
 *
 * Dynamically registers user-defined custom dice with Dice So Nice
 * integration.  Dice definitions are stored in module settings and
 * can be managed through Configure Settings → Exotik Dices.
 */

import {
    ExotikDiceConfig,
    promptReload,
    markdownToHtml,
    resolveFace,
} from "./ExotikDiceConfig.js";

import { exportDice, autoImportDice } from "./dicePorting.js";

/* ---------------------------------------- */
/*  Constants                                */
/* ---------------------------------------- */

const MODULE_ID = "exotik-dices";
const ASSETS_PATH = `modules/${MODULE_ID}/assets`;

/** Foundry v13+ deprecates the global FilePicker; use the namespaced class. */
const FP = foundry.applications.apps?.FilePicker ?? FilePicker;

/**
 * Asset folder convention per dice:
 *   assets/dices/<dice_slug>/textures/   → 3D face textures (PNG)
 *   assets/dices/<dice_slug>/bump_maps/  → 3D bump maps (PNG)
 *   assets/dices/<dice_slug>/chat_2d/    → Chat icons (SVG/PNG)
 *   assets/geometries/                   → Shared 3D geometries (GLB)
 */
const DICES_PATH = `${ASSETS_PATH}/dices`;
const USER_DICES_PATH = `${MODULE_ID}/dices`;
const GEOMETRIES_PATH = `${ASSETS_PATH}/geometries`;

/** Default dice shipped with the module ("Come quando fuori piove") */
const DEFAULT_DICE_PATH = `${DICES_PATH}/come_quando_fuori_piove`;
const DEFAULT_DICE = [
    {
        id: "ekd-default-combat",
        slug: "come_quando_fuori_piove",
        name: "Come quando fuori piove",
        denomination: "h",
        faces: 6,
        geometry: "rounded_d6",
        faceMap: [
            {
                refFace: null,
                label: "Cuori",
                texture: `${DEFAULT_DICE_PATH}/textures/heart.png`,
                bump: `${DEFAULT_DICE_PATH}/bump_maps/heart_bump.png`,
                icon: `${DEFAULT_DICE_PATH}/chat_2d/heart.svg`,
            },
            {
                refFace: 0,
                label: "",
                texture: "",
                bump: "",
                icon: "",
            },
            {
                refFace: null,
                label: "Quadri",
                texture: `${DEFAULT_DICE_PATH}/textures/diamond.png`,
                bump: `${DEFAULT_DICE_PATH}/bump_maps/diamond_bump.png`,
                icon: `${DEFAULT_DICE_PATH}/chat_2d/diamond.svg`,
            },
            {
                refFace: null,
                label: "Fiori",
                texture: `${DEFAULT_DICE_PATH}/textures/club.png`,
                bump: `${DEFAULT_DICE_PATH}/bump_maps/club_bump.png`,
                icon: `${DEFAULT_DICE_PATH}/chat_2d/club.svg`,
            },
            {
                refFace: 3,
                label: "",
                texture: "",
                bump: "",
                icon: "",
            },
            {
                refFace: null,
                label: "Picche",
                texture: `${DEFAULT_DICE_PATH}/textures/spade.png`,
                bump: `${DEFAULT_DICE_PATH}/bump_maps/spade_bump.png`,
                icon: `${DEFAULT_DICE_PATH}/chat_2d/spade.svg`,
            },
        ],
    },
];

/* ---------------------------------------- */
/*  Runtime lookup maps                      */
/* ---------------------------------------- */

/** @type {Map<string, object>}  denomination → dice definition */
const _diceDefinitions = new Map();

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

/** Map face count → DSN geometry key */
function getDSNGeometryType(faces) {
    const map = { 4: "d4", 6: "d6", 8: "d8", 10: "d10", 12: "d12", 20: "d20" };
    return map[faces] || "d6";
}

/* ---------------------------------------- */
/*  Settings registration                    */
/* ---------------------------------------- */

function registerSettings() {
    game.settings.register(MODULE_ID, "diceDefinitions", {
        name: "EKD.Settings.DiceDefinitions",
        scope: "world",
        config: false,
        type: Array,
        default: DEFAULT_DICE,
    });

    game.settings.register(MODULE_ID, "schemaVersion", {
        name: "Schema Version",
        scope: "world",
        config: false,
        type: Number,
        default: 0,
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

        const key = faceDef.icon || faceDef.label || String(r.result);
        if (!groups.has(key)) {
            groups.set(key, {
                label: faceDef.label || String(r.result),
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
            `<span class="ekd-summary-item">${iconHtml} ×${g.count}</span>`,
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

    // Load dice definitions and register Die subclasses.
    // In Foundry v13 CONFIG.Dice.terms uses class names as keys (e.g. "Die",
    // "Coin"). Registration by denomination still works for some lookups, but
    // we also register by class name so that DiceTerm.fromParseNode / fromData
    // can find our class when reconstructing rolls from serialised chat data.
    const definitions = game.settings.get(MODULE_ID, "diceDefinitions") || [];

    for (const def of definitions) {
        _diceDefinitions.set(def.denomination, def);
        const DiceClass = createDiceClass(def);

        // Register by class name (v13 primary key) AND by denomination (compat)
        CONFIG.Dice.terms[DiceClass.name] = DiceClass;
        CONFIG.Dice.terms[def.denomination] = DiceClass;

        console.log(
            `${MODULE_ID} | Registered dice: d${def.denomination} – "${def.name}" (${def.faces} faces, class=${DiceClass.name})`,
        );
    }
});

Hooks.once("ready", () => {
    // Warn if Dice So Nice is missing
    if (!game.modules.get("dice-so-nice")?.active) {
        ui.notifications.warn(game.i18n.localize("EKD.DSNRequired"));
    }

    // ── Migrations (versioned) ──
    const CURRENT_SCHEMA = 2;
    const schema = game.settings.get(MODULE_ID, "schemaVersion") || 0;
    const defs = game.settings.get(MODULE_ID, "diceDefinitions") || [];
    let needsMigration = false;

    // v1: geometry "board" → "rounded_d6"
    if (schema < 1) {
        for (const def of defs) {
            if (def.geometry === "board") {
                def.geometry = "rounded_d6";
                needsMigration = true;
            }
        }
    }

    // v2: old combat dice → "Come quando fuori piove" (card suits)
    if (schema < 2) {
        for (let i = 0; i < defs.length; i++) {
            const def = defs[i];
            if (
                def.id === "ekd-default-combat" ||
                def.name === "Combat Dice" ||
                (def.denomination === "h" &&
                    def.faceMap?.[0]?.label === "Skull")
            ) {
                defs[i] = foundry.utils.deepClone(DEFAULT_DICE[0]);
                needsMigration = true;
                console.log(
                    `${MODULE_ID} | Migrated default dice to "Come quando fuori piove"`,
                );
            }
        }
    }

    if (needsMigration || schema < CURRENT_SCHEMA) {
        if (needsMigration) {
            game.settings.set(MODULE_ID, "diceDefinitions", defs);
        }
        game.settings.set(MODULE_ID, "schemaVersion", CURRENT_SCHEMA);
        console.log(`${MODULE_ID} | Schema updated to v${CURRENT_SCHEMA}`);
    }

    // ── Auto-import dice from filesystem ──
    autoImportDice().then((count) => {
        if (count > 0) promptReload();
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
/*  Dice So Nice Integration                 */
/* ---------------------------------------- */

/* ---------------------------------------- */
/*  Settings panel – dice list injection     */
/* ---------------------------------------- */

/**
 * Inject the dice list directly into the Game Settings panel
 * so users can see/manage dice without opening a separate window.
 * The Configure button is kept as a fallback.
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
        root = app.element instanceof HTMLElement
            ? app.element
            : app.element?.[0];
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
    const definitions =
        game.settings.get(MODULE_ID, "diceDefinitions") || [];
    const t = {
        hint: game.i18n.localize("EKD.Config.Hint"),
        hintNote: game.i18n.localize("EKD.Config.HintNote"),
        addDice: game.i18n.localize("EKD.Config.AddDice"),
        refresh: game.i18n.localize("EKD.Config.Refresh"),
        edit: game.i18n.localize("EKD.Config.Edit"),
        del: game.i18n.localize("EKD.Config.Delete"),
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
    listHtml += `<p class="notes ekd-hint-main">${t.hint}</p>`;
    listHtml += `<p class="notes ekd-hint-note">${t.hintNote}</p>`;
    listHtml += `<div class="ekd-settings-buttons">
            <button type="button" class="ekd-settings-add">
                <i class="fas fa-plus"></i> ${t.addDice}
            </button>
            <button type="button" class="ekd-settings-refresh">
                <i class="fas fa-sync-alt"></i> ${t.refresh}
            </button>
        </div>`;
    if (definitions.length) {
        listHtml += `<ul class="ekd-settings-list">`;
        for (const d of definitions) {
            const isDefault = d.id === "ekd-default-combat";
            const editBtn = isDefault
                ? ""
                : `<a class="ekd-settings-edit" title="${t.edit}"><i class="fas fa-edit"></i></a>`;
            const deleteBtn = isDefault
                ? ""
                : `<a class="ekd-settings-delete" title="${t.del}"><i class="fas fa-trash"></i></a>`;
            listHtml += `
                <li class="ekd-settings-entry flexrow" data-id="${d.id}">
                    <span class="ekd-settings-name flex2">${d.name}</span>
                    <span class="ekd-settings-denom flex0">d${d.denomination}</span>
                    <span class="ekd-settings-faces flex0">${d.faces} ${t.faces}</span>
                    <span class="ekd-settings-controls flex0">
                        <a class="ekd-settings-export" title="${t.exp}"><i class="fas fa-file-export"></i></a>
                        ${editBtn}
                        ${deleteBtn}
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
            if (dice.id === "ekd-default-combat") {
                ui.notifications.warn(
                    game.i18n.localize("EKD.Config.DefaultProtected"),
                );
                return;
            }
            ExotikDiceConfig.editDice(dice, app);
        }

        if (target.closest(".ekd-settings-export")) {
            event.preventDefault();
            const id = target.closest("[data-id]")?.dataset.id;
            const dice = definitions.find((d) => d.id === id);
            if (dice) exportDice(dice);
        }

        if (target.closest(".ekd-settings-delete")) {
            event.preventDefault();
            const id = target.closest("[data-id]")?.dataset.id;
            const dice = definitions.find((d) => d.id === id);
            if (!dice) return;
            if (dice.id === "ekd-default-combat") {
                ui.notifications.warn(game.i18n.localize("EKD.Config.DefaultProtected"));
                return;
            }
            Dialog.confirm({
                title: game.i18n.localize("EKD.Config.Delete"),
                content: `<p>${game.i18n.format("EKD.Config.DeleteConfirm", { name: dice.name })}</p>`,
            }).then(async (confirmed) => {
                if (!confirmed) return;
                const updated = (
                    game.settings.get(MODULE_ID, "diceDefinitions") || []
                ).filter((d) => d.id !== id);
                await game.settings.set(
                    MODULE_ID,
                    "diceDefinitions",
                    updated,
                );
                // Try to remove the dice asset folder
                if (dice.slug) {
                    const possiblePaths = [
                        `${USER_DICES_PATH}/${dice.slug}`,
                        `${DICES_PATH}/${dice.slug}`,
                    ];
                    for (const folderPath of possiblePaths) {
                        try {
                            await FP.browse("data", folderPath).then(
                                async (result) => {
                                    for (const file of result.files || []) {
                                        try {
                                            await fetch(
                                                window.location.origin +
                                                    "/api/files",
                                                {
                                                    method: "DELETE",
                                                    headers: {
                                                        "Content-Type":
                                                            "application/json",
                                                    },
                                                    body: JSON.stringify({
                                                        path: file,
                                                        source: "data",
                                                    }),
                                                },
                                            );
                                        } catch {}
                                    }
                                    for (const dir of result.dirs || []) {
                                        try {
                                            const sub = await FP.browse(
                                                "data",
                                                dir,
                                            );
                                            for (const f of sub.files || []) {
                                                try {
                                                    await fetch(
                                                        window.location.origin +
                                                            "/api/files",
                                                        {
                                                            method: "DELETE",
                                                            headers: {
                                                                "Content-Type":
                                                                    "application/json",
                                                            },
                                                            body: JSON.stringify(
                                                                {
                                                                    path: f,
                                                                    source: "data",
                                                                },
                                                            ),
                                                        },
                                                    );
                                                } catch {}
                                            }
                                        } catch {}
                                    }
                                },
                            );
                            console.log(
                                `${MODULE_ID} | Deleted asset folder: ${folderPath}`,
                            );
                        } catch {
                            // folder not found in this location, try next
                        }
                    }
                }
                app.render(true);
                promptReload();
            });
        }

        if (target.closest(".ekd-settings-add")) {
            event.preventDefault();
            ExotikDiceConfig.editDice(null, app);
        }

        if (target.closest(".ekd-settings-refresh")) {
            event.preventDefault();
            autoImportDice().then((count) => {
                app.render(true);
                if (count > 0) promptReload();
            });
        }

        if (target.closest(".ekd-settings-help")) {
            event.preventDefault();
            fetch(`modules/${MODULE_ID}/README.md`)
                .then((r) => r.text())
                .then((md) => {
                    new Dialog({
                        title: "Exotik Dices – README",
                        content: `<div class="ekd-readme" style="max-height:500px;overflow:auto;padding:4px 8px;">${markdownToHtml(md)}</div>`,
                        buttons: { ok: { label: "OK" } },
                        default: "ok",
                    }).render(true);
                })
                .catch(() => {
                    ui.notifications.warn("README.md not found.");
                });
        }
    });
});

Hooks.once("diceSoNiceReady", async (dice3d) => {
    console.log(`${MODULE_ID} | diceSoNiceReady fired`);

    // Register system without making it selectable in DSN's appearance dropdown.
    // Our custom dice presets work regardless — they are tied to unique denominations.
    dice3d.addSystem({ id: "ekd", name: "Exotik Dices" }, false);

    const definitions = game.settings.get(MODULE_ID, "diceDefinitions") || [];
    const factory = dice3d.DiceFactory;

    // Register DSN presets (resolving face references).
    // We create DicePreset objects manually instead of using dice3d.addDicePreset()
    // because that method crashes on custom denominations not registered in
    // CONFIG.Dice.terms (it tries CONFIG.Dice.terms[denominator].name).
    for (const def of definitions) {
        const labels = def.faceMap.map((_, i) => {
            const r = resolveFace(def.faceMap, i);
            return r?.texture || "";
        });
        const bumpMaps = def.faceMap.map((_, i) => {
            const r = resolveFace(def.faceMap, i);
            return r?.bump || "";
        });
        const dsnGeo = getDSNGeometryType(def.faces);
        const diceType = `d${def.denomination}`;

        try {
            // Get the standard model for this geometric shape
            const standardModel = factory.systems
                .get("standard")
                .dice.get(dsnGeo);
            if (!standardModel) {
                console.warn(
                    `${MODULE_ID} | No standard model for ${dsnGeo}, skipping ${diceType}`,
                );
                continue;
            }

            const DicePreset = standardModel.constructor;
            const preset = new DicePreset(diceType, standardModel.shape);
            preset.term = "Die";
            preset.setLabels(labels);
            if (bumpMaps.some((b) => b)) preset.setBumpMaps(bumpMaps);
            preset.values = standardModel.values;
            preset.valueMap = standardModel.valueMap;
            preset.mass = standardModel.mass;
            preset.scale = standardModel.scale;
            preset.inertia = standardModel.inertia;
            preset.system = "ekd";

            factory.register(preset);

            console.log(
                `${MODULE_ID} | DSN preset registered: ${diceType} as ${dsnGeo}`,
            );
        } catch (err) {
            console.warn(
                `${MODULE_ID} | Failed to register DSN preset for ${diceType}:`,
                err,
            );
        }
    }

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
    if (!customGeoUsers.length) return;

    // Load each unique GLB file
    const loadedGeometries = new Map();
    const uniqueGeos = [...new Set(customGeoUsers.map((d) => d.geometry))];
    const loadPromises = uniqueGeos.map(
        (geoName) =>
            new Promise((resolve) => {
                const glbPath = customGeoFiles.get(geoName);
                dice3d.DiceFactory.loaderGLTF.load(glbPath, (gltf) => {
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

    if (!loadedGeometries.size) return;

    // Build denomination → geometry map
    const denomToGeo = new Map();
    for (const def of customGeoUsers) {
        const geo = loadedGeometries.get(def.geometry);
        if (geo) denomToGeo.set(`d${def.denomination}`, geo);
    }

    // Monkey-patch DiceFactory.create for geometry swap
    const origCreate = dice3d.DiceFactory.create.bind(dice3d.DiceFactory);
    dice3d.DiceFactory.create = async function (t, i, r) {
        const mesh = await origCreate(t, i, r);
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
        `${MODULE_ID} | Geometry swap installed for: ${[...denomToGeo.keys()].join(", ")}`,
    );
});
