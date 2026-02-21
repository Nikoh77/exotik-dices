/**
 * Exotik Dices Module for Foundry VTT v13+
 *
 * Dynamically registers user-defined custom dice with Dice So Nice
 * integration.  Dice definitions are stored in module settings and
 * can be managed through Configure Settings → Exotik Dices.
 */

import { ExotikDiceConfig } from "./ExotikDiceConfig.js";

/* ---------------------------------------- */
/*  Constants                                */
/* ---------------------------------------- */

const MODULE_ID = "exotik-dices";
const ASSETS_PATH = `modules/${MODULE_ID}/assets`;

/**
 * Asset folder convention per dice:
 *   assets/dices/<dice_slug>/textures/   → 3D face textures (PNG)
 *   assets/dices/<dice_slug>/bump_maps/  → 3D bump maps (PNG)
 *   assets/dices/<dice_slug>/chat_2d/    → Chat icons (SVG/PNG)
 *   assets/geometries/                   → Shared 3D geometries (GLB)
 */
const DICES_PATH = `${ASSETS_PATH}/dices`;
const GEOMETRIES_PATH = `${ASSETS_PATH}/geometries`;

/** Default dice shipped with the module (Combat Dice) */
const COMBAT_PATH = `${DICES_PATH}/combat_dice`;
const DEFAULT_DICE = [
    {
        id: "ekd-default-combat",
        name: "Combat Dice",
        denomination: "h",
        faces: 6,
        geometry: "board",
        faceMap: [
            {
                label: "Skull",
                texture: `${COMBAT_PATH}/textures/skull.png`,
                bump: `${COMBAT_PATH}/bump_maps/skull_bump.png`,
                icon: `${COMBAT_PATH}/chat_2d/skull.svg`,
            },
            {
                label: "Skull",
                texture: `${COMBAT_PATH}/textures/skull.png`,
                bump: `${COMBAT_PATH}/bump_maps/skull_bump.png`,
                icon: `${COMBAT_PATH}/chat_2d/skull.svg`,
            },
            {
                label: "Skull",
                texture: `${COMBAT_PATH}/textures/skull.png`,
                bump: `${COMBAT_PATH}/bump_maps/skull_bump.png`,
                icon: `${COMBAT_PATH}/chat_2d/skull.svg`,
            },
            {
                label: "White Shield",
                texture: `${COMBAT_PATH}/textures/shield_white.png`,
                bump: `${COMBAT_PATH}/bump_maps/shield_white_bump.png`,
                icon: `${COMBAT_PATH}/chat_2d/shield_white.svg`,
            },
            {
                label: "White Shield",
                texture: `${COMBAT_PATH}/textures/shield_white.png`,
                bump: `${COMBAT_PATH}/bump_maps/shield_white_bump.png`,
                icon: `${COMBAT_PATH}/chat_2d/shield_white.svg`,
            },
            {
                label: "Black Shield",
                texture: `${COMBAT_PATH}/textures/shield_black.png`,
                bump: `${COMBAT_PATH}/bump_maps/shield_black_bump.png`,
                icon: `${COMBAT_PATH}/chat_2d/shield_black.svg`,
            },
        ],
    },
];

/* ---------------------------------------- */
/*  Runtime lookup maps                      */
/* ---------------------------------------- */

/** @type {Map<string, object>}  denomination → dice definition */
const _diceDefinitions = new Map();

/** @type {Map<string, typeof foundry.dice.terms.Die>}  denomination → dice subclass */
const _diceClasses = new Map();

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
            const faceDef = faceMap[result.result - 1];
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
        const faceDef = def?.faceMap?.[r.result - 1];
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

    // Load dice definitions and register Die subclasses
    const definitions = game.settings.get(MODULE_ID, "diceDefinitions") || [];

    for (const def of definitions) {
        _diceDefinitions.set(def.denomination, def);
        const DiceClass = createDiceClass(def);
        _diceClasses.set(def.denomination, DiceClass);
        CONFIG.Dice.terms[def.denomination] = DiceClass;
        console.log(
            `${MODULE_ID} | Registered dice: d${def.denomination} – "${def.name}" (${def.faces} faces)`,
        );
    }
});

Hooks.once("ready", () => {
    // Warn if Dice So Nice is missing
    if (!game.modules.get("dice-so-nice")?.active) {
        ui.notifications.warn(game.i18n.localize("EKD.DSNRequired"));
    }
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

Hooks.once("diceSoNiceReady", (dice3d) => {
    console.log(`${MODULE_ID} | diceSoNiceReady fired`);

    dice3d.addSystem({ id: "ekd", name: "Exotik Dices" }, "preferred");

    const definitions = game.settings.get(MODULE_ID, "diceDefinitions") || [];

    for (const def of definitions) {
        const labels = def.faceMap.map((f) => f.texture || "");
        const bumpMaps = def.faceMap.map((f) => f.bump || "");
        const dsnGeo = getDSNGeometryType(def.faces);

        dice3d.addDicePreset(
            {
                type: `d${def.denomination}`,
                labels,
                bumpMaps,
                system: "ekd",
            },
            dsnGeo,
        );

        console.log(
            `${MODULE_ID} | DSN preset registered: d${def.denomination} as ${dsnGeo}`,
        );
    }

    // ── Board-game-classic geometry swap (rounded d6 GLB) ──
    const boardDice = definitions.filter(
        (d) => d.geometry === "board" && d.faces === 6,
    );
    if (!boardDice.length) return;

    const glbPath = `${GEOMETRIES_PATH}/rounded_d6.glb`;
    dice3d.DiceFactory.loaderGLTF.load(glbPath, (gltf) => {
        let casinoGeometry = null;
        gltf.scene.traverse((child) => {
            if (child.isMesh && !casinoGeometry) {
                casinoGeometry = child.geometry;
            }
        });

        if (!casinoGeometry) {
            console.error(`${MODULE_ID} | Failed to extract geometry from GLB`);
            return;
        }

        console.log(
            `${MODULE_ID} | Casino geometry loaded: ${casinoGeometry.attributes.position.count} vertices`,
        );

        const boardDenoms = new Set(boardDice.map((d) => `d${d.denomination}`));
        const origCreate = dice3d.DiceFactory.create.bind(dice3d.DiceFactory);

        dice3d.DiceFactory.create = async function (t, i, r) {
            const mesh = await origCreate(t, i, r);
            if (boardDenoms.has(i) && mesh) {
                const baseScale = t.type === "board" ? this.baseScale : 60;
                const s = baseScale / 100;
                const geo = casinoGeometry.clone();
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
            `${MODULE_ID} | Geometry swap hook installed for: ${[...boardDenoms].join(", ")}`,
        );
    });
});
