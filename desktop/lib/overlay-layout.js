const ACTION_BUTTON_WIDTH = 82;
const CONTROL_PADDING = 4;
const CONTROL_GAP = 4;
const CONTROL_BUTTON_COUNT = 3;
const CONTROL_WIDTH = CONTROL_PADDING * 2 + ACTION_BUTTON_WIDTH * CONTROL_BUTTON_COUNT + CONTROL_GAP * (CONTROL_BUTTON_COUNT - 1);
const CONTROL_HEIGHT = 36;
const CONTROL_SIDE_ORDER = ['top', 'bottom', 'right', 'left'];
const CONTROL_SIDE_REQUIREMENTS = {
  top: CONTROL_HEIGHT,
  right: CONTROL_WIDTH,
  bottom: CONTROL_HEIGHT,
  left: CONTROL_WIDTH
};

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
    if (spaces[side] >= CONTROL_SIDE_REQUIREMENTS[side]) {
      return side;
    }
  }

  return CONTROL_SIDE_ORDER.reduce((best, side) => {
    if (!best) {
      return side;
    }
    const bestFit = spaces[best] / CONTROL_SIDE_REQUIREMENTS[best];
    const sideFit = spaces[side] / CONTROL_SIDE_REQUIREMENTS[side];
    return sideFit > bestFit ? side : best;
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
      x: rect.x + rect.width - CONTROL_WIDTH,
      y: rect.y + rect.height
    };
  }
  if (controlSide === 'left') {
    return {
      x: rect.x - CONTROL_WIDTH,
      y: rect.y
    };
  }
  return {
    x: rect.x + rect.width - CONTROL_WIDTH,
    y: rect.y - CONTROL_HEIGHT
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
  const maxX = displayBounds.x + displayBounds.width - CONTROL_WIDTH;
  const maxY = displayBounds.y + displayBounds.height - CONTROL_HEIGHT;

  return {
    overlayBounds: buildOverlayBounds(rect),
    controlSide,
    controlBounds: {
      x: clamp(controlOrigin.x, displayBounds.x, maxX),
      y: clamp(controlOrigin.y, displayBounds.y, maxY),
      width: CONTROL_WIDTH,
      height: CONTROL_HEIGHT
    }
  };
}

module.exports = {
  buildOverlayLayout
};
