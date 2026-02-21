/**
 * Exotik Dices Module for Foundry VTT v13+
 * Registers a custom ExotikDice (denomination "h") and integrates with
 * Dice So Nice for 3D rendering.
 *
 * Face mapping:  1-3 = Skull,  4-5 = White Shield,  6 = Black Shield
 */

/* ---------------------------------------- */
/*  Constants                                */
/* ---------------------------------------- */

const MODULE_ID = "exotik-dices";
const FACE_PATH = `modules/${MODULE_ID}/assets/faces`;

/** Symbol definitions keyed by face range */
const SYMBOLS = Object.freeze({
    skull: {
        min: 1,
        max: 3,
        svg: "skull.svg",
        png: "skull.png",
        bump: "skull_bump.png",
        i18n: "EKD.Skull",
    },
    shield_white: {
        min: 4,
        max: 5,
        svg: "shield_white.svg",
        png: "shield_white.png",
        bump: "shield_white_bump.png",
        i18n: "EKD.WhiteShield",
    },
    shield_black: {
        min: 6,
        max: 6,
        svg: "shield_black.svg",
        png: "shield_black.png",
        bump: "shield_black_bump.png",
        i18n: "EKD.BlackShield",
    },
});

/* ---------------------------------------- */
/*  ExotikDie                                */
/* ---------------------------------------- */

class ExotikDie extends foundry.dice.terms.Die {
    constructor(termData = {}) {
        super({ ...termData, faces: 6 });
    }

    /** @override */
    static DENOMINATION = "h";

    /**
     * Map a face value (1-6) to its Exotik symbol key.
     * @param {number} value
     * @returns {string} "skull" | "shield_white" | "shield_black"
     */
    static getSymbol(value) {
        for (const [key, def] of Object.entries(SYMBOLS)) {
            if (value >= def.min && value <= def.max) return key;
        }
        return "skull"; // fallback
    }

    /**
     * Count symbol occurrences from an array of DiceTermResults.
     * @param {DiceTermResult[]} results
     * @returns {{ skull: number, shield_white: number, shield_black: number }}
     */
    static countSymbols(results) {
        const counts = { skull: 0, shield_white: 0, shield_black: 0 };
        for (const r of results) {
            if (!r.active) continue;
            counts[ExotikDie.getSymbol(r.result)]++;
        }
        return counts;
    }

    /** @override */
    getResultLabel(result) {
        const key = ExotikDie.getSymbol(result.result);
        const def = SYMBOLS[key];
        const title = game.i18n?.localize(def.i18n) ?? key;
        return `<img src="${FACE_PATH}/${def.svg}" title="${title}"/>`;
    }

    /** @override */
    getResultCSS(result) {
        return [
            "ekd-die",
            "d6",
            result.rerolled ? "rerolled" : null,
            result.exploded ? "exploded" : null,
            result.discarded ? "discarded" : null,
        ];
    }
}

/* ---------------------------------------- */
/*  Registration                             */
/* ---------------------------------------- */

Hooks.once("init", () => {
    CONFIG.Dice.terms["h"] = ExotikDie;
    console.log(`${MODULE_ID} | Registered ExotikDie (dh)`);
});

/* ---------------------------------------- */
/*  Chat Message Rendering                   */
/* ---------------------------------------- */

/**
 * Replace the numeric total with a symbol summary for any roll that
 * contains Exotik Dices.  Handles multiple rolls per message.
 * Uses renderChatMessageHTML (v13+) which passes a native HTMLElement.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
    if (!message.rolls?.length) return;

    // Gather Exotik Dices results across ALL rolls in the message
    const allResults = [];
    for (const roll of message.rolls) {
        const hqTerms = roll.terms?.filter((t) => t instanceof ExotikDie);
        if (hqTerms?.length)
            allResults.push(...hqTerms.flatMap((t) => t.results));
    }
    if (!allResults.length) return;

    const counts = ExotikDie.countSymbols(allResults);

    // Build the summary HTML with localized labels
    const parts = [];
    for (const [key, def] of Object.entries(SYMBOLS)) {
        if (counts[key] > 0) {
            const title = game.i18n.localize(def.i18n);
            parts.push(
                `<span class="ekd-summary-item">` +
                    `<img src="${FACE_PATH}/${def.svg}" class="ekd-summary-icon" title="${title}"/> ×${counts[key]}` +
                    `</span>`,
            );
        }
    }

    const totalEl = html.querySelector(".dice-total");
    if (totalEl) {
        totalEl.innerHTML = `<div class="ekd-dice-summary">${parts.join("")}</div>`;
        totalEl.classList.add("ekd-total");
    }
});

/* ---------------------------------------- */
/*  Dice So Nice Integration                 */
/* ---------------------------------------- */

Hooks.once("diceSoNiceReady", (dice3d) => {
    console.log(`${MODULE_ID} | diceSoNiceReady fired`);

    dice3d.addSystem({ id: "ekd", name: "Exotik Dices" }, "preferred");
    console.log(`${MODULE_ID} | System "ekd" added`);

    // Build label and bumpMap arrays from SYMBOLS definition (ordered by face)
    // PNGs have transparent backgrounds so DSN's die colour shows through
    const labels = [];
    const bumpMaps = [];
    for (let face = 1; face <= 6; face++) {
        const key = ExotikDie.getSymbol(face);
        const def = SYMBOLS[key];
        labels.push(`${FACE_PATH}/${def.png}`);
        bumpMaps.push(`${FACE_PATH}/${def.bump}`);
    }

    console.log(`${MODULE_ID} | Labels:`, labels);

    // Register preset WITHOUT modelFile — DSN will create the standard d6
    // geometry with its full material pipeline (user colors, labels, bumps).
    dice3d.addDicePreset(
        {
            type: "dh",
            labels,
            bumpMaps,
            system: "ekd",
        },
        "d6",
    );
    console.log(`${MODULE_ID} | Dice So Nice preset registered`);

    // Load casino-style geometry from GLB (no textures, just shape + UVs)
    // and monkey-patch DiceFactory.create() to swap geometry for "dh" dice.
    const glbPath = `modules/${MODULE_ID}/assets/rounded_d6.glb`;
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
            `${MODULE_ID} | Casino geometry loaded:`,
            casinoGeometry.attributes.position.count,
            "vertices",
        );

        // Monkey-patch create() to swap geometry for "dh" dice
        const origCreate = dice3d.DiceFactory.create.bind(dice3d.DiceFactory);
        dice3d.DiceFactory.create = async function (t, i, r) {
            const mesh = await origCreate(t, i, r);
            if (i === "dh" && mesh) {
                const baseScale = t.type === "board" ? this.baseScale : 60;
                const s = baseScale / 100;
                const geo = casinoGeometry.clone();
                geo.scale(s, s, s);
                if (mesh.isMesh) {
                    mesh.geometry = geo;
                } else {
                    // Group — swap geometry on first child mesh
                    mesh.traverse((child) => {
                        if (child.isMesh) child.geometry = geo;
                    });
                }
            }
            return mesh;
        };
        console.log(`${MODULE_ID} | Geometry swap hook installed`);
    });
});
