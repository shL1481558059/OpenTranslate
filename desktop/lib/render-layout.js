const fs = require('node:fs');
const layout = require('./layout-engine');
const extraction = require('./extraction-text');
const { buildOverlayLayout } = require('./overlay-layout');
const { rectRelativeToBounds } = require('./geometry');

const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const blocks = layout.mapBlocks(payload.blocks, payload.items, {
  selectionRect: payload.selectionRect
});
const displayBounds = payload.displayBounds || payload.selectionRect;
const overlay = buildOverlayLayout(payload.selectionRect, displayBounds);

process.stdout.write(
  JSON.stringify({
    blocks,
    extraction: {
      sourceText: extraction.buildExtractedText(payload.blocks),
      translatedText: extraction.buildExtractedText(blocks)
    },
    overlayBounds: displayBounds,
    selectionRect: rectRelativeToBounds(payload.selectionRect, displayBounds),
    controlRect: rectRelativeToBounds(overlay.controlBounds, displayBounds),
    controlSide: overlay.controlSide
  })
);
