/**
 * ExotikDiceConfig – Unified configuration window for Exotik Dices.
 * Displays either a list of defined dice (with Add/Edit/Delete) or
 * the editor for a single dice, all within the same window.
 * Registered as a settings menu via game.settings.registerMenu().
 */

const MODULE_ID = "exotik-dices";
const DICES_PATH = `modules/${MODULE_ID}/assets/dices`;

/** Denominations reserved by Foundry core */
const RESERVED_DENOMS = new Set(["d", "f", "c"]);

/** Supported face counts */
const FACE_OPTIONS = [4, 6, 8, 10, 12, 20];

/**
 * Convert a dice name to a filesystem-safe slug.
 * e.g. "My Cool Dice!" → "my_cool_dice"
 */
function nameToSlug(name) {
    return (name || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
}

/**
 * Build the conventional asset base path for a dice slug.
 * @param {string} slug
 * @returns {string}  e.g. "modules/exotik-dices/assets/dices/my_dice"
 */
function diceBasePath(slug) {
    return `${DICES_PATH}/${slug}`;
}

/**
 * Create the three asset sub-folders for a dice on the server.
 * Uses Foundry's FilePicker.createDirectory (requires GM permissions).
 * Silently ignores "already exists" errors.
 * @param {string} slug
 */
async function ensureDiceFolders(slug) {
    const base = `assets/dices/${slug}`;
    const dirs = [
        base,
        `${base}/textures`,
        `${base}/bump_maps`,
        `${base}/chat_2d`,
    ];
    for (const dir of dirs) {
        try {
            await FilePicker.createDirectory(
                "data",
                `modules/${MODULE_ID}/${dir}`,
            );
        } catch (e) {
            // Folder already exists – that's fine
            if (
                !e.message?.includes("EEXIST") &&
                !e.message?.includes("already exists")
            ) {
                console.warn(
                    `${MODULE_ID} | Could not create folder ${dir}:`,
                    e.message,
                );
            }
        }
    }
}

export class ExotikDiceConfig extends FormApplication {
    constructor(object = {}, options = {}) {
        super(object, options);
        /** null = list view, object = editing that dice */
        this._editingDice = null;
    }

    /** @override */
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "ekd-dice-config",
            template: `modules/${MODULE_ID}/templates/dice-config.hbs`,
            width: 620,
            height: "auto",
            closeOnSubmit: false,
            submitOnChange: false,
            resizable: true,
            classes: ["ekd-config"],
        });
    }

    /** @override */
    get title() {
        if (this._editingDice) {
            return this._editingDice.name
                ? game.i18n.format("EKD.Editor.TitleEdit", {
                      name: this._editingDice.name,
                  })
                : game.i18n.localize("EKD.Editor.TitleNew");
        }
        return game.i18n.localize("EKD.Config.Title");
    }

    /** @override */
    getData() {
        // ── Editor mode ──
        if (this._editingDice) {
            const d = this._editingDice;
            const faceCount = d.faces || 6;
            const faceMap = d.faceMap || [];
            const faces = [];
            for (let i = 0; i < faceCount; i++) {
                faces.push({
                    number: i + 1,
                    label: faceMap[i]?.label ?? "",
                    texture: faceMap[i]?.texture ?? "",
                    bump: faceMap[i]?.bump ?? "",
                    icon: faceMap[i]?.icon ?? "",
                });
            }

            const facesOptions = FACE_OPTIONS.map((n) => ({
                value: n,
                label: String(n),
                selected: n === faceCount,
            }));

            const geometryOptions = [
                {
                    value: "standard",
                    label: game.i18n.localize("EKD.Editor.GeometryStandard"),
                    selected: d.geometry !== "board",
                },
                {
                    value: "board",
                    label: game.i18n.localize("EKD.Editor.GeometryBoard"),
                    selected: d.geometry === "board",
                },
            ];

            return {
                editing: true,
                dice: d,
                faces,
                facesOptions,
                geometryOptions,
                showGeometry: faceCount === 6,
                slug: d.slug || "",
                assetHint: d.slug
                    ? `${diceBasePath(d.slug)}/textures/,  …/bump_maps/,  …/chat_2d/`
                    : "",
            };
        }

        // ── List mode ──
        const definitions =
            game.settings.get(MODULE_ID, "diceDefinitions") || [];
        const diceList = definitions.map((d) => ({
            ...d,
            geometryLabel:
                d.geometry === "board"
                    ? game.i18n.localize("EKD.Editor.GeometryBoard")
                    : game.i18n.localize("EKD.Editor.GeometryStandard"),
        }));
        return { editing: false, diceList };
    }

    /** @override */
    activateListeners(html) {
        super.activateListeners(html);
        const el = html[0] || html;

        if (this._editingDice) {
            // ── Editor listeners ──
            const facesSelect = el.querySelector('[name="faces"]');
            if (facesSelect) {
                facesSelect.addEventListener("change", (e) =>
                    this._onFacesChange(e),
                );
            }
            const backBtn = el.querySelector(".ekd-back");
            if (backBtn) {
                backBtn.addEventListener("click", (e) => {
                    e.preventDefault();
                    this._editingDice = null;
                    this.render();
                });
            }
            // Live image previews
            el.querySelectorAll("input.image").forEach((input) => {
                input.addEventListener("change", (e) => this._onImageChange(e));
            });
        } else {
            // ── List listeners ──
            el.querySelectorAll(".ekd-add-dice").forEach((btn) => {
                btn.addEventListener("click", (e) => this._onAddDice(e));
            });
            el.querySelectorAll(".ekd-edit").forEach((btn) => {
                btn.addEventListener("click", (e) => this._onEditDice(e));
            });
            el.querySelectorAll(".ekd-delete").forEach((btn) => {
                btn.addEventListener("click", (e) => this._onDeleteDice(e));
            });
        }
    }

    /* ---------------------------------------- */
    /*  Event Handlers – List mode               */
    /* ---------------------------------------- */

    _onAddDice(event) {
        event.preventDefault();
        this._editingDice = {
            id: foundry.utils.randomID(),
            name: "",
            slug: "",
            denomination: "",
            faces: 6,
            geometry: "standard",
            faceMap: Array.from({ length: 6 }, () => ({
                label: "",
                texture: "",
                bump: "",
                icon: "",
            })),
        };
        this.render();
    }

    _onEditDice(event) {
        event.preventDefault();
        const id =
            event.currentTarget.closest("[data-id]")?.dataset.id ||
            event.currentTarget.dataset.id;
        const definitions =
            game.settings.get(MODULE_ID, "diceDefinitions") || [];
        const dice = definitions.find((d) => d.id === id);
        if (!dice) return;
        this._editingDice = foundry.utils.deepClone(dice);
        this.render();
    }

    async _onDeleteDice(event) {
        event.preventDefault();
        const id =
            event.currentTarget.closest("[data-id]")?.dataset.id ||
            event.currentTarget.dataset.id;
        const definitions =
            game.settings.get(MODULE_ID, "diceDefinitions") || [];
        const dice = definitions.find((d) => d.id === id);
        if (!dice) return;

        const confirmed = await Dialog.confirm({
            title: game.i18n.localize("EKD.Config.Delete"),
            content: `<p>${game.i18n.format("EKD.Config.DeleteConfirm", { name: dice.name })}</p>`,
        });
        if (!confirmed) return;

        const updated = definitions.filter((d) => d.id !== id);
        await game.settings.set(MODULE_ID, "diceDefinitions", updated);
        this.render();
        this._promptReload();
    }

    /* ---------------------------------------- */
    /*  Event Handlers – Editor mode             */
    /* ---------------------------------------- */

    _onFacesChange(event) {
        this._captureFormData();
        this._editingDice.faces = parseInt(event.target.value);
        if (this._editingDice.faces !== 6) {
            this._editingDice.geometry = "standard";
        }
        this.render();
    }

    _onImageChange(event) {
        const input = event.currentTarget;
        const preview = input
            .closest(".form-group")
            ?.querySelector(".ekd-face-preview");
        if (!preview) return;
        if (input.value) {
            preview.src = input.value;
            preview.style.display = "";
        } else {
            preview.style.display = "none";
        }
    }

    /* ---------------------------------------- */
    /*  Persistence                              */
    /* ---------------------------------------- */

    /** @override */
    async _updateObject(_event, formData) {
        if (!this._editingDice) return; // list mode, nothing to save

        const expanded = foundry.utils.expandObject(formData);

        // --- Validation ---
        if (!expanded.name?.trim()) {
            ui.notifications.error(
                game.i18n.localize("EKD.Validation.NameRequired"),
            );
            throw new Error("Validation failed");
        }

        const denom = (expanded.denomination ?? "").trim().toLowerCase();
        if (!denom) {
            ui.notifications.error(
                game.i18n.localize("EKD.Validation.DenominationRequired"),
            );
            throw new Error("Validation failed");
        }
        if (denom.length !== 1) {
            ui.notifications.error(
                game.i18n.localize("EKD.Validation.DenominationLength"),
            );
            throw new Error("Validation failed");
        }

        const currentDefs =
            game.settings.get(MODULE_ID, "diceDefinitions") || [];
        const ownDenoms = new Set(currentDefs.map((d) => d.denomination));

        if (RESERVED_DENOMS.has(denom) && !ownDenoms.has(denom)) {
            ui.notifications.error(
                game.i18n.format("EKD.Validation.DenominationReserved", {
                    denom,
                }),
            );
            throw new Error("Validation failed");
        }

        const conflict = currentDefs.find(
            (d) => d.denomination === denom && d.id !== this._editingDice.id,
        );
        if (conflict) {
            ui.notifications.error(
                game.i18n.format("EKD.Validation.DenominationConflict", {
                    denom,
                    name: conflict.name,
                }),
            );
            throw new Error("Validation failed");
        }

        // --- Build dice definition ---
        const faceCount = parseInt(expanded.faces) || 6;
        const faceMap = [];
        const rawMap = expanded.faceMap || {};
        for (let i = 0; i < faceCount; i++) {
            const f = rawMap[i] || {};
            faceMap.push({
                label: (f.label ?? "").trim(),
                texture: (f.texture ?? "").trim(),
                bump: (f.bump ?? "").trim(),
                icon: (f.icon ?? "").trim(),
            });
        }

        const diceDef = {
            id: this._editingDice.id,
            name: expanded.name.trim(),
            slug: nameToSlug(expanded.name),
            denomination: denom,
            faces: faceCount,
            geometry:
                faceCount === 6 ? expanded.geometry || "standard" : "standard",
            faceMap,
        };

        // --- Create asset folders on the server ---
        if (diceDef.slug) {
            await ensureDiceFolders(diceDef.slug);
        }

        // --- Save ---
        const idx = currentDefs.findIndex((d) => d.id === diceDef.id);
        if (idx >= 0) {
            currentDefs[idx] = diceDef;
        } else {
            currentDefs.push(diceDef);
        }

        await game.settings.set(MODULE_ID, "diceDefinitions", currentDefs);
        ui.notifications.info(
            game.i18n.format("EKD.Config.DiceSaved", { name: diceDef.name }),
        );

        // Go back to list
        this._editingDice = null;
        this.render();
        this._promptReload();
    }

    /* ---------------------------------------- */
    /*  Helpers                                  */
    /* ---------------------------------------- */

    _captureFormData() {
        const formData = this._getSubmitData();
        const exp = foundry.utils.expandObject(formData);
        this._editingDice.name = exp.name ?? this._editingDice.name;
        this._editingDice.slug = nameToSlug(this._editingDice.name);
        this._editingDice.denomination =
            exp.denomination ?? this._editingDice.denomination;
        this._editingDice.geometry = exp.geometry ?? this._editingDice.geometry;
        if (exp.faceMap) {
            this._editingDice.faceMap = Object.values(exp.faceMap);
        }
    }

    _promptReload() {
        new Dialog({
            title: game.i18n.localize("EKD.Config.ReloadRequired"),
            content: `<p>${game.i18n.localize("EKD.Config.ReloadRequiredMsg")}</p>`,
            buttons: {
                reload: {
                    icon: '<i class="fas fa-sync"></i>',
                    label: game.i18n.localize("EKD.Config.ReloadNow"),
                    callback: () => window.location.reload(),
                },
                later: {
                    icon: '<i class="fas fa-clock"></i>',
                    label: game.i18n.localize("EKD.Config.ReloadLater"),
                },
            },
            default: "reload",
        }).render(true);
    }
}

