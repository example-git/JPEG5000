```
     ██╗██████╗ ███████╗ ██████╗     ███████╗ ██████╗  ██████╗  ██████╗
     ██║██╔══██╗██╔════╝██╔════╝     ██╔════╝██╔═████╗██╔═████╗██╔═████╗
     ██║██████╔╝█████╗  ██║  ███╗    ███████╗██║██╔██║██║██╔██║██║██╔██║
██   ██║██╔═══╝ ██╔══╝  ██║   ██║    ╚════██║████╔╝██║████╔╝██║████╔╝██║
╚█████╔╝██║     ███████╗╚██████╔╝    ███████║╚██████╔╝╚██████╔╝╚██████╔╝
 ╚════╝ ╚═╝     ╚══════╝ ╚═════╝     ╚══════╝ ╚═════╝  ╚═════╝  ╚═════╝
```

> **Batch Select Subject + Neural Style Transfer**

A Photoshop UXP plugin that batch-processes an input folder of images. For each image it opens the file, runs Select Subject, applies Photoshop Neural Filters Style Transfer to the active selection, and exports a PNG with the same base filename to an output folder.

## Current Workflow

1. Load the plugin in Photoshop via UXP Developer Tool.
2. Open **Plugins > JPEG 5000**.
3. Click **Choose Input Folder**.
4. Click **Choose Output Folder**.
5. Choose a Style Transfer preset/model:
   - `ast-hokusai`
   - `wave`
   - `wave_2048`
   - `wave_1024`
6. Click **Process Folder**.

Outputs are written as `.png` files using the source base filename. For example, `portrait.jpg` becomes `portrait.png`.

## Descriptor Data

The `style-transfer` branch includes `parsed_neural_output.json` in the plugin root. The plugin loads this file at runtime and searches it for an executable `neuralGalleryFilters` descriptor.

The extracted Style Transfer identity values are:

- `internal.StyleTransfer`
- `STYLE_TRANSFER`
- `style_transfer`
- `ast-hokusai`
- `wave`
- `wave_2048`
- `wave_1024`

If `parsed_neural_output.json` is only a parsed report and does not contain a full executable `batchPlay` descriptor, the plugin will stop with a clear error. Photoshop needs the full `neuralGalleryFilters` payload, including `NF_SPL_GRAPH` and `NF_UI_DATA`, to run Neural Filters from automation.

## Requirements

- Adobe Photoshop 2023 or later.
- Neural Filters enabled.
- Style Transfer downloaded/available in Neural Filters.
- UXP file system permissions are enabled in `manifest.json`.

## Development

Project files:

```text
jpeg-5000/
├── manifest.json
├── index.html
├── index.js
├── styles.css
├── parsed_neural_output.json
├── icons/
└── README.md
```

Key functions in `index.js`:

- `processFolder()` — batch controller.
- `selectSubject()` — runs Select Subject using defensive `batchPlay` attempts.
- `applyStyleTransfer()` — applies the resolved Style Transfer descriptor.
- `buildStyleTransferDescriptor()` — finds/validates the executable descriptor data.

## Troubleshooting

- **No executable Style Transfer descriptor was found**: replace or augment `parsed_neural_output.json` with a captured `neuralGalleryFilters` descriptor object from Photoshop UXP console output.
- **Select Subject failed**: run Select > Subject manually in Photoshop and capture the exact `batchPlay` descriptor for your Photoshop version.
- **Neural Filter fails**: verify Style Transfer is downloaded and available in Photoshop's Neural Filters panel.
