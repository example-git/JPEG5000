const { app, action, core } = require("photoshop");
const fs = require("uxp").storage.localFileSystem;

const DESCRIPTOR_JSON_PATH = "parsed_neural_output.json";
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
    ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".psd", ".psb", ".webp"
]);

const STYLE_ALIASES = {
    "ast-hokusai": ["ast-hokusai"],
    "wave": ["wave", "wave_2048", "wave_1024"],
    "wave_2048": ["wave_2048", "wave"],
    "wave_1024": ["wave_1024", "wave"]
};

let inputFolder = null;
let outputFolder = null;
let shouldCancel = false;
let descriptorCache = null;
let descriptorLoadWarning = null;

window.addEventListener("error", event => {
    console.error("JPEG5000 window error:", event.message, event.filename, event.lineno, event.colno, event.error);
});

window.addEventListener("unhandledrejection", event => {
    console.error("JPEG5000 unhandled rejection:", event.reason);
});

try {
    action.addNotificationListener(["neuralGalleryFilters", "invokeCommand"], (event, descriptor) => {
        console.log("Neural filter event:", event);
        console.log("Neural filter descriptor:", JSON.stringify(descriptor, null, 2));
    });
} catch (error) {
    console.warn("Neural filter listener registration failed:", error.message);
}

document.addEventListener("DOMContentLoaded", () => {
    bindClick("select-input-folder-btn", selectInputFolder);
    bindClick("select-output-folder-btn", selectOutputFolder);
    bindClick("process-folder-btn", () => {
        core.executeAsModal(processFolder, { commandName: "JPEG 5000 Batch Style Transfer" });
    });
    bindClick("cancel-btn", () => {
        shouldCancel = true;
        updateProgressText("Cancel requested. Current image will finish first...");
    });
});

function bindClick(id, handler) {
    const element = document.getElementById(id);
    if (!element) {
        console.error(`Missing UI element: ${id}`);
        return;
    }
    element.addEventListener("click", handler);
}

async function selectInputFolder() {
    try {
        const folder = await fs.getFolder();
        if (!folder) {
            return;
        }
        inputFolder = folder;
        setText("input-folder-name", folder.nativePath || folder.name);
        showResult(`Input folder selected: ${folder.name}`, false);
    } catch (error) {
        showError("Failed to select input folder: " + error.message);
    }
}

async function selectOutputFolder() {
    try {
        const folder = await fs.getFolder();
        if (!folder) {
            return;
        }
        outputFolder = folder;
        setText("output-folder-name", folder.nativePath || folder.name);
        showResult(`Output folder selected: ${folder.name}`, false);
    } catch (error) {
        showError("Failed to select output folder: " + error.message);
    }
}

async function processFolder() {
    if (!inputFolder) {
        showError("Choose an input folder first.");
        return;
    }
    if (!outputFolder) {
        showError("Choose an output folder first.");
        return;
    }

    const styleName = document.getElementById("style-select").value;
    const processButton = document.getElementById("process-folder-btn");
    const cancelButton = document.getElementById("cancel-btn");
    const results = [];

    shouldCancel = false;
    processButton.disabled = true;
    cancelButton.disabled = false;
    showProgress();

    try {
        updateProgress(0, 100, "Loading Style Transfer descriptor data...");
        await loadDescriptorData();

        const imageFiles = await getImageFiles(inputFolder);
        if (imageFiles.length === 0) {
            showError("No supported images found in the input folder.");
            return;
        }

        for (let i = 0; i < imageFiles.length; i++) {
            if (shouldCancel) {
                results.push({ name: "Batch", ok: false, warning: "Cancelled by user" });
                break;
            }

            const file = imageFiles[i];
            const current = i + 1;
            updateProgress(current - 1, imageFiles.length, `Opening ${file.name} (${current}/${imageFiles.length})...`);

            try {
                const warning = await processOneFile(file, styleName, current, imageFiles.length);
                results.push({ name: file.name, ok: true, warning });
            } catch (error) {
                console.error(`Failed processing ${file.name}:`, error);
                results.push({ name: file.name, ok: false, warning: shortError(error) });
                await closeActiveDocumentNoSave().catch(closeError => console.warn("Close after failure failed:", closeError));
            }
        }

        updateProgress(imageFiles.length, imageFiles.length, "Batch complete.");
        showBatchSummary(results);
    } catch (error) {
        console.error("Batch processing failed:", error);
        showError("Batch failed: " + shortError(error));
    } finally {
        processButton.disabled = false;
        cancelButton.disabled = true;
    }
}

async function processOneFile(file, styleName, current, total) {
    const warnings = [];

    await openFile(file);
    await sleep(700);

    updateProgress(current - 0.75, total, `Selecting subject in ${file.name}...`);
    try {
        await selectSubject();
    } catch (error) {
        warnings.push("Select Subject failed");
        console.warn(`Select Subject failed for ${file.name}:`, error);
    }
    await sleep(300);

    updateProgress(current - 0.5, total, `Applying Style Transfer (${styleName}) to ${file.name}...`);
    try {
        await applyStyleTransfer(styleName);
    } catch (error) {
        warnings.push(shortError(error));
        console.warn(`Style Transfer skipped for ${file.name}:`, error);
    }
    await sleep(500);

    updateProgress(current - 0.25, total, `Saving ${file.name}...`);
    await saveActiveDocumentAsPng(outputFolder, makeOutputName(file.name));
    await closeActiveDocumentNoSave();

    return warnings.join("; ");
}

async function getImageFiles(folder) {
    const entries = await folder.getEntries();
    return entries
        .filter(entry => entry && entry.isFile && SUPPORTED_IMAGE_EXTENSIONS.has(getExtension(entry.name || "")))
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

async function openFile(file) {
    const token = await fs.createSessionToken(file);
    await action.batchPlay([
        {
            _obj: "open",
            target: {
                _path: token,
                _kind: "local"
            }
        }
    ], { modalBehavior: "execute" });
}

async function selectSubject() {
    const attempts = [
        [{ _obj: "autoCutout", sampleAllLayers: false }],
        [{ _obj: "autoCutout", sampleAllLayers: true }],
        [{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "subject" } }]
    ];

    let lastError = null;
    for (const descriptor of attempts) {
        try {
            await action.batchPlay(descriptor, { modalBehavior: "execute" });
            return;
        } catch (error) {
            lastError = error;
            console.warn("Select Subject attempt failed:", error.message);
        }
    }

    throw new Error("Select Subject failed: " + (lastError ? lastError.message : "unknown"));
}

async function applyStyleTransfer(styleName) {
    const descriptor = buildStyleTransferDescriptor(styleName);
    validateExecutableStyleTransferDescriptor(descriptor);
    await action.batchPlay([descriptor], { modalBehavior: "execute" });
}

function buildStyleTransferDescriptor(styleName) {
    const executableDescriptor = findExecutableDescriptor(styleName);
    if (executableDescriptor) {
        return tuneDescriptorForStyle(executableDescriptor, styleName);
    }

    throw new Error(`No executable Style Transfer descriptor found. Saved fallback output instead. Need full neuralGalleryFilters payload for style ${styleName}.`);
}

async function loadDescriptorData() {
    if (descriptorCache) {
        return descriptorCache;
    }

    try {
        const response = await fetch(DESCRIPTOR_JSON_PATH);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        descriptorCache = await response.json();
        descriptorLoadWarning = null;
        console.log("Loaded Style Transfer descriptor data", descriptorCache);
        return descriptorCache;
    } catch (error) {
        descriptorCache = {};
        descriptorLoadWarning = `Could not load ${DESCRIPTOR_JSON_PATH}: ${error.message}`;
        console.warn(descriptorLoadWarning);
        return descriptorCache;
    }
}

function findExecutableDescriptor(styleName) {
    const candidates = [];
    walkObject(descriptorCache, value => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return;
        }

        const isNeuralFilter = value._obj === "neuralGalleryFilters";
        const hasExecutableKeys = value.NF_SPL_GRAPH && value.NF_UI_DATA;
        if (isNeuralFilter && hasExecutableKeys && descriptorMentionsStyle(value, styleName)) {
            candidates.push(value);
        }
    });

    if (candidates.length > 0) {
        return deepClone(candidates[0]);
    }

    walkObject(descriptorCache, value => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return;
        }
        if (value._obj === "neuralGalleryFilters" && value.NF_SPL_GRAPH && value.NF_UI_DATA) {
            candidates.push(value);
        }
    });

    return candidates.length > 0 ? deepClone(candidates[0]) : null;
}

function validateExecutableStyleTransferDescriptor(descriptor) {
    const requiredKeys = ["_obj", "NF_SPL_GRAPH", "NF_UI_DATA"];
    const missing = requiredKeys.filter(key => !descriptor || !descriptor[key]);
    if (missing.length > 0) {
        throw new Error("Style Transfer descriptor missing: " + missing.join(", "));
    }
    if (descriptor._obj !== "neuralGalleryFilters") {
        throw new Error("Style Transfer descriptor must use _obj: neuralGalleryFilters.");
    }
}

function tuneDescriptorForStyle(descriptor, styleName) {
    const aliases = STYLE_ALIASES[styleName] || [styleName];
    const preferredModel = aliases[0];
    const uiStyle = styleName === "wave_2048" || styleName === "wave_1024" ? "wave" : styleName;

    walkObject(descriptor, value => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return;
        }

        setIfPresent(value, "spl::style", uiStyle);
        setIfPresent(value, "style", uiStyle);

        if (typeof value["spl::modelID"] === "string") {
            value["spl::modelID"] = preferredModel;
        }
        if (typeof value.modelID === "string") {
            value.modelID = preferredModel;
        }
        if (value["spl::value"] && aliases.some(alias => String(value["spl::value"]).includes(alias))) {
            value["spl::value"] = preferredModel;
        }
    });

    return descriptor;
}

function descriptorMentionsStyle(descriptor, styleName) {
    const aliases = STYLE_ALIASES[styleName] || [styleName];
    let foundStyle = false;
    let foundStyleTransfer = false;

    walkObject(descriptor, value => {
        if (typeof value !== "string") {
            return;
        }
        if (aliases.includes(value)) {
            foundStyle = true;
        }
        if (value === "internal.StyleTransfer" || value === "STYLE_TRANSFER" || value === "style_transfer") {
            foundStyleTransfer = true;
        }
    });

    return foundStyle || foundStyleTransfer;
}

async function saveActiveDocumentAsPng(folder, fileName) {
    const outputFile = await folder.createFile(fileName, { overwrite: true });
    const token = await fs.createSessionToken(outputFile);

    await action.batchPlay([
        {
            _obj: "save",
            as: {
                _obj: "PNGFormat",
                PNGInterlaceType: {
                    _enum: "PNGInterlaceType",
                    _value: "PNGInterlaceNone"
                },
                PNGFilter: {
                    _enum: "PNGFilter",
                    _value: "PNGFilterAdaptive"
                },
                compression: 6
            },
            in: {
                _path: token,
                _kind: "local"
            },
            copy: true,
            lowerCase: true
        }
    ], { modalBehavior: "execute" });
}

async function closeActiveDocumentNoSave() {
    if (!app.activeDocument) {
        return;
    }

    await action.batchPlay([
        {
            _obj: "close",
            saving: {
                _enum: "yesNo",
                _value: "no"
            }
        }
    ], { modalBehavior: "execute" });
}

function setIfPresent(object, key, value) {
    if (Object.prototype.hasOwnProperty.call(object, key)) {
        object[key] = value;
    }
}

function walkObject(value, visitor, seen = new Set()) {
    if (value === null || value === undefined) {
        return;
    }
    if (typeof value !== "object") {
        visitor(value);
        return;
    }
    if (seen.has(value)) {
        return;
    }

    seen.add(value);
    visitor(value);

    if (Array.isArray(value)) {
        value.forEach(item => walkObject(item, visitor, seen));
        return;
    }

    Object.keys(value).forEach(key => walkObject(value[key], visitor, seen));
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function getExtension(fileName) {
    const dot = fileName.lastIndexOf(".");
    return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
}

function getBaseName(fileName) {
    const dot = fileName.lastIndexOf(".");
    return dot === -1 ? fileName : fileName.slice(0, dot);
}

function makeOutputName(fileName) {
    return sanitizeFilename(getBaseName(fileName)) + ".png";
}

function sanitizeFilename(name) {
    return name.replace(/[/\\?%*:|"<>]/g, "-").substring(0, 120) || "output";
}

function updateProgress(current, total, message) {
    const percentage = total <= 0 ? 0 : Math.max(0, Math.min(100, (current / total) * 100));
    const progressFill = document.getElementById("progress-fill");
    if (progressFill) {
        progressFill.style.width = percentage + "%";
    }
    updateProgressText(message);
}

function updateProgressText(message) {
    setText("status-text", message);
}

function setText(id, message) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = message;
    }
}

function showProgress() {
    document.getElementById("progress-section").classList.remove("hidden");
    document.getElementById("result-section").classList.add("hidden");
    document.getElementById("progress-fill").style.width = "0%";
}

function showResult(message, hideProgress = true) {
    const resultSection = document.getElementById("result-section");
    const resultText = document.getElementById("result-text");
    resultSection.classList.remove("hidden");
    resultText.textContent = message;
    resultText.style.backgroundColor = "#2d7d46";
    if (hideProgress) {
        document.getElementById("progress-section").classList.add("hidden");
    }
}

function showError(message) {
    const resultSection = document.getElementById("result-section");
    const resultText = document.getElementById("result-text");
    resultSection.classList.remove("hidden");
    resultText.textContent = "Error: " + message;
    resultText.style.backgroundColor = "#d13438";
    document.getElementById("progress-section").classList.add("hidden");
}

function showBatchSummary(results) {
    const successes = results.filter(result => result.ok).length;
    const failures = results.filter(result => !result.ok).length;
    const warnings = results.filter(result => result.warning).slice(0, 5);
    const warningText = warnings.length > 0
        ? " Warnings: " + warnings.map(result => `${result.name}: ${result.warning}`).join("; ")
        : "";
    const loadText = descriptorLoadWarning ? " " + descriptorLoadWarning : "";

    showResult(`Batch complete. Saved ${successes} file(s) to ${outputFolder.name}. Failed ${failures}.${loadText}${warningText}`);
}

function shortError(error) {
    const message = error && error.message ? error.message : String(error);
    if (message.includes("No executable Style Transfer")) {
        return "No executable Style Transfer descriptor; fallback PNG saved";
    }
    return message.length > 180 ? message.slice(0, 177) + "..." : message;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
