const CLOSE_BUTTON_SIZE = 24;
const CLOSE_BUTTON_MARGIN = 6;
const CONTROL_GUTTER = CLOSE_BUTTON_SIZE + CLOSE_BUTTON_MARGIN * 2;
const CONTROL_SIDE_ORDER = ['top', 'right', 'bottom', 'left'];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getAvailableSpaces(rect, displayBounds) {
  return {
    left: Math.max(0, rect.x - displayBounds.x),
    right: Math.max(0, displayBounds.x + displayBounds.width - (rect.x + rect.width)),
    top: Math.max(0, rect.y - displayBounds.y),
    bottom: Math.max(0, displayBounds.y + displayBounds.height - (rect.y + rect.height))
  };
}

function chooseControlSide(spaces) {
  for (const side of CONTROL_SIDE_ORDER) {
    if (spaces[side] >= CONTROL_GUTTER) {
      return side;
    }
  }

  return CONTROL_SIDE_ORDER.reduce((best, side) => {
    if (!best) {
      return side;
    }
    return spaces[side] > spaces[best] ? side : best;
  }, '');
}

function getControlOrigin(rect, controlSide) {
  if (controlSide === 'right') {
    return {
      x: rect.x + rect.width,
      y: rect.y
    };
  }
  if (controlSide === 'bottom') {
    return {
      x: rect.x + rect.width - CONTROL_GUTTER,
      y: rect.y + rect.height
    };
  }
  if (controlSide === 'left') {
    return {
      x: rect.x - CONTROL_GUTTER,
      y: rect.y
    };
  }
  return {
    x: rect.x + rect.width - CONTROL_GUTTER,
    y: rect.y - CONTROL_GUTTER
  };
}

function buildOverlayBounds(rect) {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  };
}

function buildOverlayLayout(rect, displayBounds) {
  const spaces = getAvailableSpaces(rect, displayBounds);
  const controlSide = chooseControlSide(spaces);
  const controlOrigin = getControlOrigin(rect, controlSide);
  const maxX = displayBounds.x + displayBounds.width - CONTROL_GUTTER;
  const maxY = displayBounds.y + displayBounds.height - CONTROL_GUTTER;

  return {
    overlayBounds: buildOverlayBounds(rect),
    controlSide,
    controlBounds: {
      x: clamp(controlOrigin.x, displayBounds.x, maxX),
      y: clamp(controlOrigin.y, displayBounds.y, maxY),
      width: CONTROL_GUTTER,
      height: CONTROL_GUTTER
    }
  };
}

module.exports = {
  buildOverlayLayout
};
