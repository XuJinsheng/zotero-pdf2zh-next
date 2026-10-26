import { getString } from "../utils/locale";

export class PDF2zhBasicFactory {
    static registerPrefs() {
        Zotero.PreferencePanes.register({
            pluginID: addon.data.config.addonID,
            src: rootURI + "content/preferences.xhtml",
            defaultXUL: true,
            label: getString("prefs-title"),
            image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`,
        });
    }
}

export class PDF2zhUIFactory {
    static registerRightClickMenuItem(win: Window) {
        const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.svg`;
        const menuPrefix = `zotero-itemmenu-${addon.data.config.addonRef}`;
        const items = [
            ["translate-pdf", "prefs-menu-translate", "translatePDF"],
            ["task-manager", "prefs-menu-tasks", "openTaskManager"],
        ];
        const pdf2zhMenu = ztoolkit.UI.createElement(win.document, "menu", {
            id: menuPrefix,
            attributes: {
                class: "menu-iconic",
                image: menuIcon,
                label: "zotero-pdf2zh-next",
            },
            children: [
                {
                    tag: "menupopup",
                    children: items.map(([id, label, command]) => ({
                        tag: "menuitem",
                        id: `${menuPrefix}-${id}`,
                        attributes: {
                            class: "menuitem-iconic",
                            image: menuIcon,
                            label: `zotero-pdf2zh-next: ${getString(label)}`,
                        },
                        listeners: [
                            {
                                type: "command",
                                listener: () =>
                                    addon.hooks.onDialogEvents(command),
                            },
                        ],
                    })),
                },
            ],
        });
        win.document.getElementById("zotero-itemmenu")?.appendChild(pdf2zhMenu);
    }
}
