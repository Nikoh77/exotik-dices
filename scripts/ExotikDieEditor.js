/**
 * ExotikDieEditor – FormApplication for creating / editing a single die.
 * Handles dynamic face-count changes, file-pickers for textures, and
 * validation before persisting to module settings.
 */

const MODULE_ID = "exotik-dices";

/** Denominations reserved by Foundry core */
const RESERVED_DENOMS = new Set(["d", "f", "c"]);

/** Supported face counts (matching DSN geometry types) */
const FACE_OPTIONS = [4, 6, 8, 10, 12, 20];

export class ExotikDieEditor extends FormApplication {
    /**
     * @param {object} dieData  – the die definition being edited (or a fresh one)
     * @param {object} options  – FormApplication options + { callback: Function }
     */
    constructor(dieData, options = {}) {
        super(dieData, options);
        /** Working copy that survives re-renders (e.g. face-count changes) */
        this._workingData = foundry.utils.deepClone(dieData);
        /** Called after a successful save so the config list can refresh */
        this._callback = options.callback || (() => {});
    }

    /** @override */
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "ekd-die-editor",
            template: `modules/${MODULE_ID}/templates/die-editor.hbs`,
            width: 620,
            height: "auto",
            classes: ["ekd-editor"],
            closeOnSubmit: true,
            submitOnChange: false,
            resizable: true,
        });
    }

    /** @override */
    get title() {
        return this._workingData.name
            ? game.i18n.format("EKD.Editor.TitleEdit", {
                  name: this._workingData.name,
              })
            : game.i18n.localize("EKD.Editor.TitleNew");
    }

    /** @override */
    getData() {
        const d = this._workingData;
        const faceCount = d.faces || 6;

        // Ensure faceMap has exactly faceCount entries
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

        // Build options with selected flags
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
            die: d,
            faces,
            facesOptions,
            geometryOptions,
            showGeometry: faceCount === 6,
        };
    }

    /** @override */
    activateListeners(html) {
        super.activateListeners(html);

        // Re-render when face count changes
        html.find('[name="faces"]').on(
            "change",
            this._onFacesChange.bind(this),
        );

        // Live image previews when file picker sets a value
        html.find("input.image").on("change", this._onImageChange.bind(this));
    }

    /* ---------------------------------------- */
    /*  Event Handlers                           */
    /* ---------------------------------------- */

    /**
     * When the face-count select changes, capture current form values
     * into _workingData and re-render so the face list updates.
     */
    _onFacesChange(event) {
        this._captureFormData();
        this._workingData.faces = parseInt(event.target.value);

        // Board geometry is only valid for d6
        if (this._workingData.faces !== 6) {
            this._workingData.geometry = "standard";
        }

        this.render();
    }

    /** Update the preview image next to an input when its value changes */
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
        const expanded = foundry.utils.expandObject(formData);

        // --- Validation ---
        if (!expanded.name?.trim()) {
            ui.notifications.error(
                game.i18n.localize("EKD.Validation.NameRequired"),
            );
            throw new Error("Validation failed"); // prevents close
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

        // Check Foundry reserved denominations
        const existingDenoms = Object.keys(CONFIG.Dice.terms);
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

        // Check conflicts with other exotik dice
        const conflict = currentDefs.find(
            (d) => d.denomination === denom && d.id !== this._workingData.id,
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

        // --- Build die definition ---
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

        const dieDef = {
            id: this._workingData.id,
            name: expanded.name.trim(),
            denomination: denom,
            faces: faceCount,
            geometry:
                faceCount === 6 ? expanded.geometry || "standard" : "standard",
            faceMap,
        };

        // --- Save ---
        const idx = currentDefs.findIndex((d) => d.id === dieDef.id);
        if (idx >= 0) {
            currentDefs[idx] = dieDef;
        } else {
            currentDefs.push(dieDef);
        }

        await game.settings.set(MODULE_ID, "diceDefinitions", currentDefs);
        ui.notifications.info(
            game.i18n.format("EKD.Config.DieSaved", { name: dieDef.name }),
        );

        // Prompt reload
        this._promptReload();

        // Let the config list know it should re-render
        this._callback();
    }

    /* ---------------------------------------- */
    /*  Helpers                                  */
    /* ---------------------------------------- */

    /** Capture current form inputs into _workingData (before a re-render) */
    _captureFormData() {
        const formData = this._getSubmitData();
        const exp = foundry.utils.expandObject(formData);
        this._workingData.name = exp.name ?? this._workingData.name;
        this._workingData.denomination =
            exp.denomination ?? this._workingData.denomination;
        this._workingData.geometry = exp.geometry ?? this._workingData.geometry;
        if (exp.faceMap) {
            this._workingData.faceMap = Object.values(exp.faceMap);
        }
    }

    /** Prompt the user to reload the world */
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
