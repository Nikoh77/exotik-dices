/**
 * ExotikDiceConfig – Main configuration window for Exotik Dices.
 * Shows a list of all user-defined dice with Add / Edit / Delete controls.
 * Registered as a settings menu via game.settings.registerMenu().
 */

import { ExotikDieEditor } from "./ExotikDieEditor.js";

const MODULE_ID = "exotik-dices";

export class ExotikDiceConfig extends FormApplication {
    /** @override */
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "ekd-dice-config",
            title: game.i18n.localize("EKD.Config.Title"),
            template: `modules/${MODULE_ID}/templates/dice-config.hbs`,
            width: 580,
            height: "auto",
            closeOnSubmit: false,
            classes: ["ekd-config"],
        });
    }

    /** @override */
    getData() {
        const definitions =
            game.settings.get(MODULE_ID, "diceDefinitions") || [];
        const dice = definitions.map((d) => ({
            ...d,
            geometryLabel:
                d.geometry === "board"
                    ? game.i18n.localize("EKD.Editor.GeometryBoard")
                    : game.i18n.localize("EKD.Editor.GeometryStandard"),
        }));
        return { dice };
    }

    /** @override – no-op, list view doesn't submit data */
    async _updateObject() {}

    /** @override */
    activateListeners(html) {
        super.activateListeners(html);
        html.find(".ekd-add-die").on("click", this._onAddDie.bind(this));
        html.find(".ekd-edit").on("click", this._onEditDie.bind(this));
        html.find(".ekd-delete").on("click", this._onDeleteDie.bind(this));
    }

    /* ---------------------------------------- */
    /*  Event Handlers                           */
    /* ---------------------------------------- */

    /** Open the die editor for a brand-new die */
    _onAddDie(event) {
        event.preventDefault();
        const newDie = {
            id: foundry.utils.randomID(),
            name: "",
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
        new ExotikDieEditor(newDie, {
            callback: () => this.render(),
        }).render(true);
    }

    /** Open the die editor for an existing die */
    _onEditDie(event) {
        event.preventDefault();
        const id = event.currentTarget.dataset.id;
        const definitions =
            game.settings.get(MODULE_ID, "diceDefinitions") || [];
        const die = definitions.find((d) => d.id === id);
        if (!die) return;
        new ExotikDieEditor(foundry.utils.deepClone(die), {
            callback: () => this.render(),
        }).render(true);
    }

    /** Delete a die after confirmation */
    async _onDeleteDie(event) {
        event.preventDefault();
        const id = event.currentTarget.dataset.id;
        const definitions =
            game.settings.get(MODULE_ID, "diceDefinitions") || [];
        const die = definitions.find((d) => d.id === id);
        if (!die) return;

        const confirmMsg = game.i18n.format("EKD.Config.DeleteConfirm", {
            name: die.name,
        });
        const confirmed = await Dialog.confirm({
            title: game.i18n.localize("EKD.Config.Delete"),
            content: `<p>${confirmMsg}</p>`,
        });
        if (!confirmed) return;

        const updated = definitions.filter((d) => d.id !== id);
        await game.settings.set(MODULE_ID, "diceDefinitions", updated);
        this.render();
        this._promptReload();
    }

    /* ---------------------------------------- */
    /*  Helpers                                  */
    /* ---------------------------------------- */

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
