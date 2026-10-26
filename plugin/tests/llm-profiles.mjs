import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { URL } from "node:url";
import ts from "typescript";

function load(file, mocks = {}, globals = {}, extra = "") {
    const source = fs.readFileSync(
        new URL(`../src/modules/${file}.ts`, import.meta.url),
        "utf8",
    );
    const exports = {};
    vm.runInNewContext(
        ts.transpileModule(source + extra, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
            },
        }).outputText,
        {
            exports,
            require: (name) =>
                name === "../utils/locale"
                    ? { getString: (key) => key }
                    : mocks[name] || {},
            ...globals,
        },
    );
    return exports;
}
const profile = (key, overrides = {}) => ({
    key,
    name: key,
    service: "openai",
    model: "same-model",
    apiKey: key,
    apiUrl: `https://${key}.example`,
    extraData: { openai_stream: true },
    ...overrides,
});

function loadManager(prefs, globals = {}) {
    return load(
        "llmApiManager",
        {
            "../utils/prefs": {
                getPref: (key) => prefs[key],
                setPref: (key, value) => (prefs[key] = value),
            },
        },
        { ztoolkit: { log() {} }, ...globals },
    );
}

function setup(entries, overrides = {}) {
    const prefs = {
        llmApis: JSON.stringify(entries),
        service: "openai",
        ...overrides,
    };
    const manager = loadManager(prefs);
    const helper = load("pdf2zhHelper", {
        "./llmApiManager": manager,
        "../utils/prefs": { getPref: (key) => prefs[key] },
    });
    return { prefs, manager, ...helper };
}

test("migration restores active legacy profile, generates unique names, and is idempotent", () => {
    const original = [
        profile("a", { name: undefined }),
        profile("b", { name: undefined, activate: true }),
        profile("c", { name: "openai / same-model" }),
    ];
    const env = setup(original);
    assert.equal(env.manager.getSelectedLLMApi().key, "b");
    const migrated = JSON.parse(env.prefs.llmApis);
    assert.deepEqual(
        migrated.map((entry) => entry.name),
        [
            "openai / same-model (2)",
            "openai / same-model (3)",
            "openai / same-model",
        ],
    );
    assert.ok(migrated.every((entry) => !("activate" in entry)));
    assert.deepEqual(
        migrated.map((entry) => entry.apiKey),
        ["a", "b", "c"],
    );
    const saved = env.prefs.llmApis;
    env.prefs.selectedLLMApiKey = "a";
    env.manager.loadLLMApisFromPrefs();
    assert.equal(env.prefs.llmApis, saved);
    assert.equal(env.manager.getSelectedLLMApi().key, "a");
});

test("migration falls back to first matching provider, without choosing an unrelated provider", () => {
    const env = setup([profile("a"), profile("b")]);
    assert.equal(env.manager.getSelectedLLMApi().key, "a");
    assert.equal(
        setup([profile("a")], {
            service: "deepseek",
        }).manager.getSelectedLLMApi(),
        undefined,
    );
});

test("missing selection stays empty, deleted entries leave no stale cached profiles", () => {
    const env = setup([profile("a"), profile("b")], {
        llmSelectionMigrated: true,
        selectedLLMApiKey: "gone",
    });
    assert.equal(env.manager.getSelectedLLMApi(), undefined);
    assert.equal(env.prefs.selectedLLMApiKey, "");
    env.manager.loadLLMApisFromPrefs();
    assert.equal(env.prefs.selectedLLMApiKey, "");
    env.prefs.llmApis = "[]";
    env.manager.loadLLMApisFromPrefs();
    assert.equal(env.manager.getAllLLMApiConfigs().length, 0);
});

test("empty initial setup cannot overwrite the first explicitly selected profile", () => {
    const env = setup([]);
    env.manager.loadLLMApisFromPrefs();
    env.prefs.llmApis = JSON.stringify([profile("a", { service: "deepseek" })]);
    env.prefs.selectedLLMApiKey = "a";
    assert.equal(env.manager.getSelectedLLMApi().key, "a");
});

test("name validation allows editing self but rejects blank and duplicate names", () => {
    const { manager } = setup([]);
    const entries = [profile("a", { name: "One" })];
    assert.ok(manager.validateLLMApiName("  ", entries));
    assert.ok(manager.validateLLMApiName(" One ", entries));
    assert.equal(manager.validateLLMApiName(" One ", entries, "a"), "");
});

test("selected profile is snapshotted for requests and title suffixes", () => {
    const env = setup(
        [
            profile("a", {
                runtime: { retryCount: 0, retryInterval: 0, poolSize: 0 },
            }),
            profile("b"),
        ],
        { llmSelectionMigrated: true, selectedLLMApiKey: "a" },
    );
    const config = env.PDF2zhHelperFactory.getServerConfig();
    env.prefs.selectedLLMApiKey = "b";
    env.prefs.translationTitleSuffix = "provider";
    env.prefs.llmApis = JSON.stringify([profile("b")]);
    const body = env.PDF2zhHelperFactory.buildTaskRequestBody(
        { fileName: "x.pdf", base64: "x" },
        config,
    );
    assert.equal(body.llm_api.apiKey, "a");
    assert.equal(body.llm_api.apiUrl, "https://a.example");
    assert.equal(body.llm_api.model, "same-model");
    assert.equal("name" in body.llm_api, false);
    assert.equal("key" in body.llm_api, false);
    assert.equal(body.llm_api.extraData.openai_stream, true);
    assert.equal(body.retryCount, "0");
    assert.equal(body.retryInterval, "0");
    assert.equal(body.poolSize, "0");
    assert.equal(config.titleSnapshot.suffix, "name");
    assert.equal(env.translationTitleLabel(config.titleSnapshot), "a");
    assert.equal(env.PDF2zhHelperFactory.getServerConfig().llmApi.key, "b");
    assert.throws(
        () => env.PDF2zhHelperFactory.buildTaskRequestBody({}, {}),
        /llm-select-config/,
    );
});

test("suffix resolves name, provider, model, and empty model fallback", () => {
    const { translationTitleLabel } = setup([]);
    const snapshot = { name: "Custom", provider: "openai", model: "gpt-test" };
    for (const [suffix, expected] of [
        ["name", "Custom"],
        ["provider", "openai"],
        ["modelname", "gpt-test"],
    ]) {
        assert.equal(translationTitleLabel({ ...snapshot, suffix }), expected);
    }
    assert.equal(
        translationTitleLabel({ ...snapshot, suffix: "modelname", model: "" }),
        "openai",
    );
});

test("attachment titles use suffix and short title, with unchanged input filename", async () => {
    const imported = [];
    const { PDF2zhHelperFactory } = load(
        "pdf2zhHelper",
        {},
        {
            Zotero: {
                Attachments: {
                    importFromFile: async (args) => {
                        imported.push(args);
                        return {};
                    },
                },
            },
            PathUtils: { filename: (path) => path.split("/").pop() },
        },
    );
    PDF2zhHelperFactory.getParentItemID = () => undefined;
    PDF2zhHelperFactory.getCollections = () => [];
    const item = {
        isAttachment: () => false,
        getField: () => "Paper",
        libraryID: 1,
    };
    for (const outputMode of ["mono", "dual"]) {
        await PDF2zhHelperFactory.addAttachment({
            item,
            filePath: "/tmp/server-result.pdf",
            outputMode,
            service: "Custom",
            options: { rename: true, openAfterProcess: false },
        });
        assert.equal(imported.at(-1).title, `Paper-Custom-${outputMode}`);
        assert.equal(imported.at(-1).file, "/tmp/server-result.pdf");
    }
    item.getField = () => "";
    await PDF2zhHelperFactory.addAttachment({
        item,
        filePath: "/tmp/server-result.pdf",
        outputMode: "mono",
        service: "Custom",
        options: { rename: true },
    });
    assert.equal(imported.at(-1).title, "Custom-mono");
    await PDF2zhHelperFactory.addAttachment({
        item,
        filePath: "/tmp/server-result.pdf",
        outputMode: "mono",
        service: "Custom",
        options: { rename: false },
    });
    assert.equal(imported.at(-1).title, "server-result.pdf");
});

test("importer uses task title snapshot; historical tasks do not use current profile", async () => {
    const configs = [];
    let task = {
        taskId: "task",
        itemID: 1,
        importState: "pending",
        outputModes: ["mono"],
        service: "deepseek",
        fileName: "paper.pdf",
        resultFiles: {},
        titleSnapshot: {
            name: "Original",
            provider: "deepseek",
            model: "chat",
            suffix: "name",
        },
    };
    const { ZoteroTaskImporter } = load(
        "zoteroTaskImporter",
        {
            "./serverTaskClient": {
                ServerTaskClient: { fetchResult: async () => new Uint8Array() },
            },
            "./pdf2zhHelper": {
                PDF2zhHelperFactory: {
                    getServerConfig: () => {
                        throw new Error(
                            "Import must not read the current LLM configuration",
                        );
                    },
                    handleOutputResponse: async (_output, _item, config) =>
                        configs.push(config),
                },
            },
        },
        { Zotero: { Items: { get: () => ({}) } } },
    );
    const importer = new ZoteroTaskImporter({
        getTask: () => task,
        updateTask: (_id, patch) => Object.assign(task, patch),
    });
    await importer.importTaskOutputs("task");
    assert.equal(configs[0].titleSnapshot.name, "Original");
    task = { ...task, importState: "pending", titleSnapshot: undefined };
    await importer.importTaskOutputs("task");
    assert.equal(configs[1].titleSnapshot, undefined);
    assert.equal(configs[1].service, "deepseek");
});

test("configuration menu and CRUD preserve selection by ID", async () => {
    const prefs = { llmApis: "[]", llmSelectionMigrated: true };
    const handlers = new Map();
    const popup = {
        children: [],
        replaceChildren() {
            this.children = [];
        },
        appendChild(item) {
            this.children.push(item);
        },
    };
    const menu = {
        value: "",
        querySelector: () => popup,
        addEventListener: (type, listener) =>
            handlers.set(`menu-${type}`, listener),
    };
    const suffixMenu = {
        value: "",
        addEventListener: (type, listener) =>
            handlers.set(`suffix-${type}`, listener),
    };
    const remove = {
        addEventListener: (type, listener) =>
            handlers.set(`remove-${type}`, listener),
    };
    let indices = [];
    const doc = {
        getElementById: (id) =>
            id.endsWith("-selectedLLMApiKey")
                ? menu
                : id.endsWith("-translationTitleSuffix")
                  ? suffixMenu
                  : id.endsWith("-llmapi-remove")
                    ? remove
                    : null,
        querySelector: () => null,
        createXULElement: () => ({
            setAttribute(key, value) {
                this[key] = value;
            },
        }),
    };
    const addon = {
        data: {
            prefs: {
                window: { document: doc },
                tableHelper: {
                    treeInstance: {
                        invalidate() {},
                        selection: { selected: new Set() },
                    },
                },
            },
        },
    };
    // Use the toolkit's selected-indices API consumed by preferenceScript.
    addon.data.prefs.tableHelper.treeInstance.selection = {
        get selected() {
            return new Set(indices);
        },
    };
    let response;
    let key = 0;
    let lastDialog;
    const manager = loadManager(prefs, {
        Zotero: { Utilities: { generateObjectKey: () => `key-${++key}` } },
    });
    const mod = load(
        "preferenceScript",
        {
            "../../package.json": { config: { addonRef: "test" } },
            "./llmApiManager": manager,
            "../utils/prefs": {
                getPref: (name) => prefs[name],
                setPref: (name, value) => (prefs[name] = value),
            },
        },
        {
            addon,
            setTimeout: (callback) => callback(),
            ztoolkit: { log() {}, getGlobal: () => () => {} },
            Zotero: {
                Promise: { defer: () => ({ promise: Promise.resolve() }) },
                getMainWindow: () => ({
                    openDialog: (_url, _name, _features, args) => {
                        lastDialog = args;
                        args.result = response;
                        return { closed: true };
                    },
                }),
            },
        },
        "\nexport { bindPrefEvents, openLLMApiEditDialog, updateLLMApiMenu };",
    );
    manager.loadLLMApisFromPrefs();
    mod.bindPrefEvents();
    assert.equal(suffixMenu.value, "name");
    response = { success: true, data: profile("", { name: " First " }) };
    assert.equal(await mod.openLLMApiEditDialog(), true);
    assert.equal(prefs.selectedLLMApiKey, "key-1");
    assert.equal(popup.children[1].label, "First / same-model");
    response = {
        success: true,
        data: profile("", { name: "Second", model: "" }),
    };
    await mod.openLLMApiEditDialog();
    assert.equal(prefs.selectedLLMApiKey, "key-1");
    assert.equal(popup.children[2].label, "Second");
    response = undefined;
    assert.equal(await mod.openLLMApiEditDialog("key-1"), false);
    assert.equal(lastDialog.data.name, "First");
    assert.deepEqual(Array.from(lastDialog.existingNames), ["Second"]);
    response = {
        success: true,
        data: profile("", { name: "Renamed", model: "new-model" }),
    };
    await mod.openLLMApiEditDialog("key-1");
    assert.equal(prefs.selectedLLMApiKey, "key-1");
    assert.equal(popup.children[1].label, "Renamed / new-model");
    menu.value = "key-2";
    handlers.get("menu-command")();
    assert.equal(prefs.selectedLLMApiKey, "key-2");
    suffixMenu.value = "modelname";
    handlers.get("suffix-command")();
    assert.equal(prefs.translationTitleSuffix, "modelname");
    indices = [0];
    handlers.get("remove-command")();
    assert.equal(prefs.selectedLLMApiKey, "key-2");
    assert.equal(manager.getAllLLMApiConfigs().length, 1);
    handlers.get("remove-command")();
    assert.equal(prefs.selectedLLMApiKey, "");
    assert.equal(manager.getAllLLMApiConfigs().length, 0);
    assert.equal(popup.children.length, 1);
});

test("connection checks validate the selected profile and keep health success when selection is empty", async () => {
    const prefs = {
        llmApis: JSON.stringify([
            profile("a"),
            profile("b", { service: "deepseek", runtime: { qps: 3 } }),
        ]),
        selectedLLMApiKey: "b",
        llmSelectionMigrated: true,
        new_serverip: "http://server",
    };
    const requests = [];
    const elements = new Map();
    const doc = {
        getElementById(id) {
            if (!elements.has(id))
                elements.set(id, { setAttribute() {}, removeAttribute() {} });
            return elements.get(id);
        },
    };
    const addon = { data: { prefs: { window: { document: doc } } } };
    const manager = loadManager(prefs);
    const mod = load(
        "preferenceScript",
        {
            "../../package.json": { config: { addonRef: "test" } },
            "./llmApiManager": manager,
            "../utils/prefs": {
                getPref: (key) => prefs[key],
                setPref: (key, value) => (prefs[key] = value),
            },
            axios: {
                __esModule: true,
                default: {
                    get: async () => ({
                        status: 200,
                        data: { version: "5.5.0" },
                    }),
                    post: async (_url, body) => {
                        requests.push(body);
                        return { status: 200, data: { status: "ok" } };
                    },
                    isAxiosError: () => false,
                },
            },
        },
        {
            addon,
            setTimeout: (callback) => callback(),
            ztoolkit: {
                log() {},
                getGlobal: () => () => {},
                ProgressWindow: class {
                    createLine() {
                        return this;
                    }
                    show() {}
                    close() {}
                    changeLine() {}
                },
            },
        },
        "\nexport { checkServerConnection };",
    );
    await mod.checkServerConnection();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].service, "deepseek");
    assert.equal(requests[0].llm_api.apiKey, "b");
    assert.equal(requests[0].qps, "3");
    prefs.selectedLLMApiKey = "";
    await mod.checkServerConnection();
    assert.equal(requests.length, 1);
    assert.match(
        elements.get("zotero-prefpane-test-connectionResult").textContent,
        /llm-server-connected-select/,
    );
    assert.equal(
        elements.get("zotero-prefpane-test-serverVersion").textContent,
        "5.5.0",
    );
    assert.equal(
        elements.get("zotero-prefpane-test-checkConnection").disabled,
        false,
    );
});

test("task refresh preserves local title snapshot", () => {
    const { PDF2zhTaskManager } = load("pdf2zhTaskManager", {
        "./taskEventStream": { TaskEventStream: class {} },
        "./zoteroTaskImporter": { ZoteroTaskImporter: class {} },
    });
    const titleSnapshot = {
        name: "Submitted",
        provider: "openai",
        model: "old-model",
        suffix: "name",
    };
    const snapshot = { taskId: "one", service: "openai", status: "running" };
    PDF2zhTaskManager.upsertTask(snapshot, "http://server", {
        titleSnapshot,
        itemID: 1,
        source: "local",
        importState: "pending",
    });
    PDF2zhTaskManager.upsertTask(
        { ...snapshot, status: "completed" },
        "http://server",
    );
    assert.equal(PDF2zhTaskManager.getTasks()[0].titleSnapshot, titleSnapshot);
});
