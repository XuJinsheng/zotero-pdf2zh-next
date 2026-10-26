import { getString } from "../utils/locale";
import { config, version } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import {
    loadLLMApisFromPrefs,
    getSelectedLLMApi,
    saveLLMApisToPrefs,
    createLLMApiFromFormData,
    validateLLMApiName,
    llmApiManager,
    LLMApiData,
    resolveRuntimeSettings,
    emptyLLMApi,
    formatExtraDataForDisplay,
} from "./llmApiManager";
import type {
    DiagnosticMessage,
    ServerErrorResponse,
    ServerHealthResponse,
    ValidateConfigResponse,
} from "./pdf2zhTypes";
import axios from "axios";

export async function registerPrefsScripts(_window: Window) {
    if (!addon.data.prefs) {
        addon.data.prefs = {
            window: _window,
            columns: [],
            rows: [],
        };
    } else {
        addon.data.prefs.window = _window;
    }
    if (!addon.data.llmApis) {
        addon.data.llmApis = {
            cachedKeys: [],
        };
    }
    bindPrefEvents();
    updateVersionUI();
    void refreshServerVersion();
    initTableUI();
}

function bindPrefEvents() {
    const { window } = addon.data.prefs ?? {};
    if (!window) return;
    const doc = window.document;
    if (!doc) return;

    const configMenu = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-selectedLLMApiKey`,
    ) as XUL.MenuList | null;
    configMenu?.addEventListener("command", () =>
        setPref("selectedLLMApiKey", configMenu.value),
    );
    const suffixMenu = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-translationTitleSuffix`,
    ) as XUL.MenuList | null;
    if (suffixMenu) {
        const value = getPref("translationTitleSuffix")?.toString();
        suffixMenu.value =
            value === "provider" || value === "modelname" ? value : "name";
        suffixMenu.addEventListener("command", () =>
            setPref("translationTitleSuffix", suffixMenu.value),
        );
    }

    const sourceLangSelect = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-sourceLangSelect`,
    ) as XUL.MenuList | null;
    const targetLangSelect = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-targetLangSelect`,
    ) as XUL.MenuList | null;
    const outputMonoCheckbox = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-outputMono`,
    ) as XUL.Checkbox | null;
    const outputDualCheckbox = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-outputDual`,
    ) as XUL.Checkbox | null;
    const serverUrlInput = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-new_serverip`,
    );

    const sourceLangPopup = sourceLangSelect?.querySelector("menupopup");
    const targetLangPopup = targetLangSelect?.querySelector("menupopup");
    sourceLangPopup?.replaceChildren();
    targetLangPopup?.replaceChildren();
    for (const [langName, langCode] of Object.entries(lang_map)) {
        const option = doc.createXULElement("menuitem");
        option.setAttribute("value", langCode);
        option.setAttribute("label", langName);
        sourceLangPopup?.appendChild(option.cloneNode(true));
        targetLangPopup?.appendChild(option.cloneNode(true));
    }
    if (sourceLangSelect) {
        sourceLangSelect.value = getPref("sourceLang")?.toString() || "en";
    }
    if (targetLangSelect) {
        targetLangSelect.value = getPref("targetLang")?.toString() || "zh-CN";
    }

    const ensureOutputModes = (fallbackKey: "outputMono" | "outputDual") => {
        if (!outputMonoCheckbox || !outputDualCheckbox) {
            return;
        }
        if (outputMonoCheckbox.checked || outputDualCheckbox.checked) {
            return;
        }

        if (fallbackKey === "outputMono") {
            outputMonoCheckbox.checked = true;
        } else {
            outputDualCheckbox.checked = true;
        }
        setPref(fallbackKey, true);
    };

    outputMonoCheckbox?.addEventListener("command", () => {
        ensureOutputModes("outputDual");
    });
    outputDualCheckbox?.addEventListener("command", () => {
        ensureOutputModes("outputMono");
    });

    doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-checkConnection`,
    )?.addEventListener("click", async () => {
        await checkServerConnection();
    });
    serverUrlInput?.addEventListener("change", () => {
        void refreshServerVersion();
    });

    doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-llmapi-table-container`,
    )?.addEventListener("showing", () => {
        updateLLMApiTableUI();
    });

    const addButton = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-llmapi-add`,
    );
    const removeButton = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-llmapi-remove`,
    );
    const editButton = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-llmapi-edit`,
    );
    addButton?.addEventListener("command", async () => {
        await openLLMApiEditDialog();
    });
    removeButton?.addEventListener("command", () => {
        const selectedKeys = getLLMApiSelection();
        selectedKeys.forEach((key) => {
            if (key) {
                if (getPref("selectedLLMApiKey") === key) {
                    setPref("selectedLLMApiKey", "");
                    ztoolkit.getGlobal("alert")(getString("llm-select-config"));
                }
                llmApiManager.deleteLLMApi(key);
            }
        });
        updateCachedLLMApiKeys();
        saveLLMApisToPrefs();
        updateLLMApiTableUI();
    });
    editButton?.addEventListener("command", async () => {
        const selectedKeys = getLLMApiSelection();
        if (selectedKeys.length === 1) {
            await openLLMApiEditDialog(selectedKeys[0]);
        }
    });
}

export async function initTableUI() {
    if (!addon.data.prefs?.window) return;
    loadLLMApisFromPrefs();
    updateCachedLLMApiKeys();
    updateLLMApiMenu();
    const renderLock = Zotero.Promise.defer();
    addon.data.prefs.tableHelper = new ztoolkit.VirtualizedTable(
        addon.data.prefs.window!,
    )
        .setContainerId(
            `zotero-prefpane-${config.addonRef}-llmapi-table-container`,
        )
        .setProp({
            id: `zotero-prefpane-${config.addonRef}-llmapi-table`,
            columns: [
                {
                    dataKey: "name",
                    label: getString("llm-column-name"),
                    width: 180,
                },
                {
                    dataKey: "service",
                    label: getString("llm-column-provider"),
                    width: 160,
                },
                {
                    dataKey: "model",
                    label: getString("llm-column-model"),
                    width: 220,
                },
                {
                    dataKey: "apiUrl",
                    label: getString("llm-column-url"),
                    width: 170,
                },
                {
                    dataKey: "apiKey",
                    label: getString("llm-column-key"),
                    width: 100,
                },
                {
                    dataKey: "extraData",
                    label: getString("llm-column-extra"),
                    width: 200,
                },
            ],
            showHeader: true,
            multiSelect: true,
            staticColumns: false,
            disableFontSizeScaling: true,
        })
        .setProp(
            "getRowCount",
            () => addon.data.llmApis?.cachedKeys.length || 0,
        )
        .setProp("getRowData", getRowData)
        .setProp("onSelectionChange", () => {
            const selectedKeys = getLLMApiSelection();
            addon.data.prefs?.window?.document
                .querySelectorAll(".llmapi-selection")
                ?.forEach((e) =>
                    setButtonDisabled(
                        e as XULButtonElement,
                        selectedKeys.length === 0,
                    ),
                );
            addon.data.prefs?.window?.document
                .querySelectorAll(".llmapi-selection-single")
                ?.forEach((e) =>
                    setButtonDisabled(
                        e as XULButtonElement,
                        selectedKeys.length !== 1,
                    ),
                );
        })
        .render(-1, () => renderLock.resolve());
    await renderLock.promise;
}

function updateCachedLLMApiKeys() {
    addon.data.llmApis = {
        cachedKeys: llmApiManager.getAllLLMApis().map((entry) => entry.key),
    };
}

async function openLLMApiEditDialog(key?: string): Promise<boolean> {
    const windowArgs: {
        _initPromise: ReturnType<typeof Zotero.Promise.defer>;
        data: LLMApiData;
        isEdit: boolean;
        existingNames: string[];
        getString: typeof getString;
        result?: { success: boolean; data: Omit<LLMApiData, "key"> };
    } = {
        _initPromise: Zotero.Promise.defer(),
        data: (key && llmApiManager.getLLMApi(key)) || emptyLLMApi,
        isEdit: !!key,
        getString,
        existingNames: llmApiManager
            .getAllLLMApis()
            .filter((entry) => entry.key !== key)
            .map((entry) => entry.name),
    };

    const dialogWindow = Zotero.getMainWindow().openDialog(
        `chrome://${config.addonRef}/content/llmApiEditor.xhtml`,
        `${config.addonRef}-llmApiEditor`,
        `chrome,centerscreen,resizable,status,dialog=no`,
        windowArgs,
    );
    if (!dialogWindow) {
        return false;
    }
    await windowArgs._initPromise.promise;

    const result = await new Promise<typeof windowArgs.result>((resolve) => {
        const checkClosed = () => {
            if (dialogWindow.closed) {
                resolve(windowArgs.result);
            } else {
                setTimeout(checkClosed, 100);
            }
        };
        checkClosed();
    });

    if (!result || !result.success) {
        return false;
    }

    const userData = result.data;
    const error = validateLLMApiName(
        userData.name || "",
        llmApiManager.getAllLLMApis(),
        key,
    );
    if (error) {
        ztoolkit.getGlobal("alert")(getString(error));
        return false;
    }
    const wasEmpty = llmApiManager.getAllLLMApis().length === 0;
    const newLLMApi = createLLMApiFromFormData({ ...userData, key });
    const savedKey = llmApiManager.updateLLMApi(newLLMApi);
    updateCachedLLMApiKeys();
    if (wasEmpty) setPref("selectedLLMApiKey", savedKey);
    saveLLMApisToPrefs();
    updateLLMApiTableUI();
    return true;
}

function updateLLMApiMenu() {
    const doc = addon.data.prefs?.window?.document;
    const menu = doc?.getElementById(
        `zotero-prefpane-${config.addonRef}-selectedLLMApiKey`,
    ) as XUL.MenuList | null;
    const popup = menu?.querySelector("menupopup");
    if (!doc || !menu || !popup) return;
    popup.replaceChildren();
    const placeholder = doc.createXULElement("menuitem");
    placeholder.setAttribute("value", "");
    placeholder.setAttribute("label", getString("llm-select-config"));
    popup.appendChild(placeholder);
    for (const entry of llmApiManager.getAllLLMApis()) {
        const item = doc.createXULElement("menuitem");
        item.setAttribute("value", entry.key);
        item.setAttribute(
            "label",
            entry.model ? `${entry.name} / ${entry.model}` : entry.name,
        );
        popup.appendChild(item);
    }
    menu.value = getPref("selectedLLMApiKey")?.toString() || "";
}

function updateLLMApiTableUI() {
    updateLLMApiMenu();
    setTimeout(() => addon.data.prefs?.tableHelper?.treeInstance.invalidate());
}

function updateVersionUI() {
    const doc = addon.data.prefs?.window?.document;
    if (!doc) {
        return;
    }
    setText(doc, "pluginVersion", version);
    setServerVersionState(doc, {
        version: "—",
        status: "未检查",
        state: "unknown",
    });
}

async function refreshServerVersion() {
    const doc = addon.data.prefs?.window?.document;
    if (!doc) {
        return;
    }

    const serverUrl = getPref("new_serverip")?.toString() || "";
    if (!serverUrl) {
        setServerVersionState(doc, {
            version: "—",
            status: "未配置",
            state: "unknown",
        });
        return;
    }

    setServerVersionState(doc, {
        version: "…",
        status: "检查中",
        state: "unknown",
    });

    try {
        const response = await axios.get<ServerHealthResponse>(
            `${serverUrl}/health`,
            {
                timeout: 4000,
                headers: { "Content-Type": "application/json" },
            },
        );
        setServerVersionState(doc, {
            version: response.data?.version || "未知",
            status:
                response.data?.status === "ok"
                    ? "已连接"
                    : response.data?.status === "degraded"
                      ? "已连接，有警告"
                      : "状态未知",
            state:
                response.data?.status === "ok" ||
                response.data?.status === "degraded"
                    ? "ok"
                    : "unknown",
        });
    } catch {
        setServerVersionState(doc, {
            version: "—",
            status: "无法连接",
            state: "error",
        });
    }
}

function setServerVersionState(
    doc: Document,
    state: {
        version: string;
        status: string;
        state: "unknown" | "ok" | "error";
    },
) {
    setText(doc, "serverVersion", state.version);
    setText(doc, "serverStatus", state.status);
    const card = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-serverVersionCard`,
    );
    card?.setAttribute("data-state", state.state);
}

function setText(doc: Document, idSuffix: string, value: string) {
    const element = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-${idSuffix}`,
    );
    if (element) {
        element.textContent = value;
    }
}

function setConnectionResult(doc: Document | undefined, value: string) {
    const element = doc?.getElementById(
        `zotero-prefpane-${config.addonRef}-connectionResult`,
    );
    if (!element) {
        return;
    }
    element.textContent = value;
    if (value) {
        element.removeAttribute("hidden");
    } else {
        element.setAttribute("hidden", "hidden");
    }
}

function setButtonDisabled(button: XUL.Button, disabled: boolean) {
    if (button) {
        button.disabled = disabled;
    }
}

function getRowData(index: number) {
    const keys = addon.data.llmApis?.cachedKeys || [];
    let llmApi = emptyLLMApi;
    if (keys.length > index) {
        const key = keys[index];
        llmApi = llmApiManager.getLLMApi(key) || emptyLLMApi;
    }
    return {
        key: llmApi.key || "",
        service: llmApi.service || "",
        model: llmApi.model || "",
        apiUrl: llmApi.apiUrl || "",
        apiKey: llmApi.apiKey || "",
        extraData: formatExtraDataForDisplay(llmApi.extraData),
        name: llmApi.name || "",
    };
}

function getLLMApiSelection() {
    const indices =
        addon.data.prefs?.tableHelper?.treeInstance?.selection.selected;
    if (!indices) {
        return [];
    }
    const keys = addon.data.llmApis?.cachedKeys || [];
    return Array.from(indices).map((i) => keys[i]) || [];
}

function formatBytes(bytes?: number): string {
    if (typeof bytes !== "number" || !Number.isFinite(bytes)) {
        return "未知";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const precision = unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatDiagnostics(diagnostics?: DiagnosticMessage[]): string {
    if (!diagnostics?.length) {
        return "";
    }
    const lines = ["诊断信息:"];
    diagnostics.forEach((diagnostic) => {
        lines.push(
            `- [${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}`,
        );
        if (diagnostic.suggestion) {
            lines.push(`  建议: ${diagnostic.suggestion}`);
        }
    });
    return lines.join("\n");
}

function getDiagnosticSummary(diagnostics?: DiagnosticMessage[]): string {
    if (!diagnostics?.length) {
        return "";
    }
    return diagnostics
        .map((diagnostic) => `${diagnostic.severity}:${diagnostic.code}`)
        .join(", ");
}

function hasCheckIssues(validateData: ValidateConfigResponse): boolean {
    return (
        validateData.liveTest?.ok === false ||
        validateData.diagnostics?.some(
            (diagnostic) =>
                diagnostic.severity === "warning" ||
                diagnostic.severity === "error",
        ) === true
    );
}

function formatHealthDetails(healthData: ServerHealthResponse): string[] {
    const workspace = healthData.workspace;
    const tasks = healthData.tasks;
    return [
        `服务端状态: ${healthData.status || "未知"}`,
        `服务端版本: ${healthData.version || "未知"}`,
        `Python: ${healthData.pythonVersion || "未知"}`,
        `pdf2zh_next: ${healthData.pdf2zhVersion || "未知"}`,
        `BabelDOC: ${healthData.babeldocVersion || "未知"}`,
        `Workspace: ${workspace?.path || "未知"}`,
        `Workspace可写: ${
            typeof workspace?.writable === "boolean"
                ? workspace.writable
                    ? "是"
                    : "否"
                : "未知"
        }`,
        `Workspace剩余空间: ${formatBytes(workspace?.freeBytes)}`,
        `任务统计: total=${tasks?.total ?? "未知"}, active=${
            tasks?.active ?? "未知"
        }, failed=${tasks?.failed ?? "未知"}, completed=${
            tasks?.completed ?? "未知"
        }`,
    ];
}

function formatLiveTest(validateData: ValidateConfigResponse): string {
    const liveTest = validateData.liveTest;
    if (!liveTest?.enabled) {
        return "Live API测试: 未启用";
    }
    const state =
        typeof liveTest.ok === "boolean"
            ? liveTest.ok
                ? "通过"
                : "未通过"
            : "未返回结果";
    return `Live API测试: ${state}${
        liveTest.message ? ` (${liveTest.message})` : ""
    }`;
}

function formatCheckReport(
    serverUrl: string,
    healthData: ServerHealthResponse,
    validateData: ValidateConfigResponse,
    service: string,
): string {
    const lines = [
        hasCheckIssues(validateData)
            ? "检查完成，存在需要关注的问题"
            : "检查通过",
        `Server地址: ${serverUrl}`,
        ...formatHealthDetails(healthData),
        `翻译服务: ${validateData.service || service}`,
        `模型: ${validateData.model || "未返回"}`,
        formatLiveTest(validateData),
    ];
    const diagnostics = formatDiagnostics(validateData.diagnostics);
    if (diagnostics) {
        lines.push("", diagnostics);
    }
    return lines.join("\n");
}

function getServerErrorData(data: unknown): ServerErrorResponse {
    if (!data || typeof data !== "object") {
        return {};
    }
    return data as ServerErrorResponse;
}

const lang_map = {
    English: "en",
    "Simplified Chinese": "zh-CN",
    "Traditional Chinese - Hong Kong": "zh-HK",
    "Traditional Chinese - Taiwan": "zh-TW",
    Japanese: "ja",
    Korean: "ko",
    Polish: "pl",
    Russian: "ru",
    Spanish: "es",
    Portuguese: "pt",
    "Brazilian Portuguese": "pt-BR",
    French: "fr",
    Malay: "ms",
    Indonesian: "id",
    Turkmen: "tk",
    "Filipino (Tagalog)": "tl",
    Vietnamese: "vi",
    "Kazakh (Latin)": "kk",
    German: "de",
    Dutch: "nl",
    Irish: "ga",
    Italian: "it",
    Greek: "el",
    Swedish: "sv",
    Danish: "da",
    Norwegian: "no",
    Icelandic: "is",
    Finnish: "fi",
    Ukrainian: "uk",
    Czech: "cs",
    Romanian: "ro",
    Hungarian: "hu",
    Slovak: "sk",
    Croatian: "hr",
    Estonian: "et",
    Latvian: "lv",
    Lithuanian: "lt",
    Belarusian: "be",
    Macedonian: "mk",
    Albanian: "sq",
    "Serbian (Cyrillic)": "sr",
    Slovenian: "sl",
    Catalan: "ca",
    Bulgarian: "bg",
    Maltese: "mt",
    Swahili: "sw",
    Amharic: "am",
    Oromo: "om",
    Tigrinya: "ti",
    "Haitian Creole": "ht",
    Latin: "la",
    Lao: "lo",
    Malayalam: "ml",
    Gujarati: "gu",
    Thai: "th",
    Burmese: "my",
    Tamil: "ta",
    Telugu: "te",
    Oriya: "or",
    Armenian: "hy",
    "Mongolian (Cyrillic)": "mn",
    Georgian: "ka",
    Khmer: "km",
    Bosnian: "bs",
    Luxembourgish: "lb",
    Romansh: "rm",
    Turkish: "tr",
    Sinhala: "si",
    Uzbek: "uz",
    Kyrgyz: "ky",
    Tajik: "tg",
    Abkhazian: "ab",
    Afar: "aa",
    Afrikaans: "af",
    Akan: "ak",
    Aragonese: "an",
    Avaric: "av",
    Ewe: "ee",
    Aymara: "ay",
    Ojibwa: "oj",
    Occitan: "oc",
    Ossetian: "os",
    Pali: "pi",
    Bashkir: "ba",
    Basque: "eu",
    Breton: "br",
    Chamorro: "ch",
    Chechen: "ce",
    Chuvash: "cv",
    Tswana: "tn",
    "Ndebele, South": "nr",
    Ndonga: "ng",
    Faroese: "fo",
    Fijian: "fj",
    "Frisian, Western": "fy",
    Ganda: "lg",
    Kongo: "kg",
    Kalaallisut: "kl",
    "Church Slavic": "cu",
    Guarani: "gn",
    Interlingua: "ia",
    Herero: "hz",
    Kikuyu: "ki",
    Rundi: "rn",
    Kinyarwanda: "rw",
    Galician: "gl",
    Kanuri: "kr",
    Cornish: "kw",
    Komi: "kv",
    Xhosa: "xh",
    Corsican: "co",
    Cree: "cr",
    Quechua: "qu",
    "Kurdish (Latin)": "ku",
    Kuanyama: "kj",
    Limburgan: "li",
    Lingala: "ln",
    Manx: "gv",
    Malagasy: "mg",
    Marshallese: "mh",
    Maori: "mi",
    Navajo: "nv",
    Nauru: "na",
    Nyanja: "ny",
    "Norwegian Nynorsk": "nn",
    Sardinian: "sc",
    "Northern Sami": "se",
    Samoan: "sm",
    Sango: "sg",
    Shona: "sn",
    Esperanto: "eo",
    "Scottish Gaelic": "gd",
    Somali: "so",
    "Southern Sotho": "st",
    Tatar: "tt",
    Tahitian: "ty",
    Tongan: "to",
    Twi: "tw",
    Walloon: "wa",
    Welsh: "cy",
    Venda: "ve",
    Volapük: "vo",
    Interlingue: "ie",
    "Hiri Motu": "ho",
    Igbo: "ig",
    Ido: "io",
    Inuktitut: "iu",
    Inupiaq: "ik",
    "Sichuan Yi": "ii",
    Yoruba: "yo",
    Zhuang: "za",
    Tsonga: "ts",
    Zulu: "zu",
};

async function checkServerConnection() {
    const serverUrl = getPref("new_serverip")?.toString() || "";
    if (!serverUrl) {
        ztoolkit.getGlobal("alert")("请先设置Server地址");
        return;
    }
    const doc = addon.data.prefs?.window?.document;
    const checkButton = doc?.getElementById(
        `zotero-prefpane-${config.addonRef}-checkConnection`,
    ) as XUL.Button | null;
    const liveApiTestCheckbox = doc?.getElementById(
        `zotero-prefpane-${config.addonRef}-liveApiTest`,
    ) as HTMLInputElement | null;
    const liveTest = Boolean(liveApiTestCheckbox?.checked);
    if (checkButton) {
        checkButton.disabled = true;
    }

    const progressWindow = new ztoolkit.ProgressWindow("Server连接检查", {
        closeOnClick: false,
        closeTime: -1,
    }).createLine({
        text: "正在检查Server连接...",
        type: "default",
        progress: 20,
    });
    progressWindow.show();

    try {
        const healthResponse = await axios.get<ServerHealthResponse>(
            `${serverUrl}/health`,
            {
                timeout: 10000,
                headers: { "Content-Type": "application/json" },
            },
        );

        if (healthResponse.status !== 200 || !healthResponse.data) {
            throw new Error(`Server返回错误状态: ${healthResponse.status}`);
        }
        if (doc) {
            setServerVersionState(doc, {
                version: healthResponse.data.version || "未知",
                status: "已连接",
                state: "ok",
            });
        }

        progressWindow.changeLine({
            text: liveTest
                ? "Server已连接，正在检查当前LLM配置与API..."
                : "Server已连接，正在检查当前LLM配置...",
            type: "default",
            progress: 60,
        });

        const llmApi = getSelectedLLMApi();
        if (!llmApi) {
            const message = getString("llm-server-connected-select");
            setConnectionResult(doc, message);
            progressWindow.changeLine({
                text: message,
                type: "default",
                progress: 100,
            });
            progressWindow.close();
            ztoolkit.getGlobal("alert")(message);
            return;
        }
        const service = llmApi.service;
        const validateResponse = await axios.post<ValidateConfigResponse>(
            `${serverUrl}/validate-config`,
            {
                service,
                sourceLang: getPref("sourceLang")?.toString() || "en",
                targetLang: getPref("targetLang")?.toString() || "zh-CN",
                ...resolveRuntimeSettings(
                    {
                        qps: getPref("qps")?.toString() || "10",
                        retryCount: getPref("retryCount")?.toString() ?? "-1",
                        retryInterval:
                            getPref("retryInterval")?.toString() ?? "2",
                        poolSize: getPref("poolSize")?.toString() || "0",
                    },
                    llmApi?.runtime,
                ),
                ocr: getPref("ocr")?.toString() || "false",
                autoOcr: getPref("autoOcr")?.toString() || "true",
                translateTableText:
                    getPref("translateTableText")?.toString() || "true",
                skipTextChecks:
                    getPref("skipTextChecks")?.toString() || "false",
                noWatermark: getPref("noWatermark")?.toString() || "true",
                disableTermExtraction:
                    getPref("disableTermExtraction")?.toString() || "false",
                fontFamily: getPref("fontFamily")?.toString() || "auto",
                liveTest,
                llm_api: llmApi
                    ? {
                          service,
                          model: llmApi.model,
                          apiKey: llmApi.apiKey,
                          apiUrl: llmApi.apiUrl,
                          extraData: llmApi.extraData || {},
                      }
                    : {},
            },
            {
                timeout: liveTest ? 25000 : 10000,
                headers: { "Content-Type": "application/json" },
            },
        );

        if (validateResponse.status !== 200 || !validateResponse.data) {
            throw new Error(`配置检查失败: ${validateResponse.status}`);
        }

        const healthData = healthResponse.data;
        const validateData = validateResponse.data;
        if (validateData.status === "error") {
            const diagnostics = formatDiagnostics(validateData.diagnostics);
            throw new Error(
                [validateData.message || "配置检查失败", diagnostics]
                    .filter(Boolean)
                    .join("\n\n"),
            );
        }
        const report = formatCheckReport(
            serverUrl,
            healthData,
            validateData,
            service,
        );
        setConnectionResult(doc, report);
        const hasIssues = hasCheckIssues(validateData);
        progressWindow.changeLine({
            text: hasIssues
                ? `⚠ 检查完成，存在诊断信息：${
                      getDiagnosticSummary(validateData.diagnostics) ||
                      "Live API测试未通过"
                  }`
                : `✓ 检查通过：${validateData.service || service}${validateData.model ? ` / ${validateData.model}` : ""}`,
            type: hasIssues ? "default" : "success",
            progress: 100,
        });

        setTimeout(() => {
            progressWindow.close();
            ztoolkit.getGlobal("alert")(
                `${hasIssues ? "⚠ 检查完成，存在需要关注的问题" : "✓ 检查通过！"}\n\n${report}`,
            );
        }, 1000);
    } catch (error) {
        let errorMsg = "未知错误";
        let troubleshooting = "";
        let diagnostics: DiagnosticMessage[] | undefined;

        if (axios.isAxiosError(error)) {
            if (
                error.code === "ECONNABORTED" ||
                error.message.includes("timeout")
            ) {
                errorMsg = "请求超时";
                troubleshooting =
                    "请确认Server已启动、网络可达，并检查是否有防火墙拦截。";
            } else if (error.response) {
                const responseData = getServerErrorData(error.response.data);
                diagnostics = responseData.diagnostics;
                const responseMessage =
                    typeof responseData.message === "string"
                        ? responseData.message
                        : "";
                errorMsg = responseMessage
                    ? responseMessage
                    : `Server返回错误: ${error.response.status}`;
                troubleshooting =
                    "请检查Server地址、当前服务对应的LLM配置，以及Server日志。";
            } else if (error.request) {
                errorMsg = "无法连接到Server";
                troubleshooting =
                    "请确认Server已运行，并检查地址格式，例如: http://localhost:8890";
            } else {
                errorMsg = error.message;
            }
        } else if (error instanceof Error) {
            errorMsg = error.message;
        }

        const diagnosticText = formatDiagnostics(diagnostics);
        const diagnosticSummary = getDiagnosticSummary(diagnostics);
        progressWindow.changeLine({
            text: `✗ 连接失败: ${errorMsg}${
                diagnosticSummary ? `；诊断: ${diagnosticSummary}` : ""
            }`,
            type: "error",
            progress: 100,
        });
        if (doc) {
            setServerVersionState(doc, {
                version: "—",
                status: "无法连接",
                state: "error",
            });
            setConnectionResult(
                doc,
                [
                    "检查失败",
                    `Server地址: ${serverUrl}`,
                    `错误信息: ${errorMsg}`,
                    diagnosticText,
                    troubleshooting,
                ]
                    .filter(Boolean)
                    .join("\n\n"),
            );
        }

        setTimeout(() => {
            progressWindow.close();
            ztoolkit.getGlobal("alert")(
                [
                    "✗ 连接失败",
                    `错误信息: ${errorMsg}`,
                    diagnosticText,
                    troubleshooting,
                ]
                    .filter(Boolean)
                    .join("\n\n"),
            );
        }, 1500);
    } finally {
        if (checkButton) {
            checkButton.disabled = false;
        }
    }
}
