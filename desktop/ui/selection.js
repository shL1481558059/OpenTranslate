const selectionEl = document.getElementById('selection');
let startClient = null;
let startScreen = null;
let lastScreen = null;

function renderRect(startPoint, endPoint) {
  const x = Math.min(startPoint.x, endPoint.x);
  const y = Math.min(startPoint.y, endPoint.y);
  const width = Math.abs(startPoint.x - endPoint.x);
  const height = Math.abs(startPoint.y - endPoint.y);

  selectionEl.style.display = 'block';
  selectionEl.style.left = `${x}px`;
  selectionEl.style.top = `${y}px`;
  selectionEl.style.width = `${width}px`;
  selectionEl.style.height = `${height}px`;
}

window.addEventListener('mousedown', (event) => {
  startClient = { x: event.clientX, y: event.clientY };
  startScreen = { x: event.screenX, y: event.screenY };
  lastScreen = { ...startScreen };
  renderRect(startClient, startClient);
});

window.addEventListener('mousemove', (event) => {
  if (!startClient) {
    return;
  }
  lastScreen = { x: event.screenX, y: event.screenY };
  renderRect(startClient, { x: event.clientX, y: event.clientY });
});

window.addEventListener('mouseup', async (event) => {
  if (!startClient || !startScreen) {
    return;
  }
  const endScreen = lastScreen || { x: event.screenX, y: event.screenY };
  const width = Math.abs(startScreen.x - endScreen.x);
  const height = Math.abs(startScreen.y - endScreen.y);
  let rect;

  if (width < 6 && height < 6) {
    rect = {
      x: startScreen.x,
      y: startScreen.y,
      width: 1,
      height: 1,
      click: true
    };
  } else {
    rect = {
      x: Math.min(startScreen.x, endScreen.x),
      y: Math.min(startScreen.y, endScreen.y),
      width,
      height
    };
  }
  startClient = null;
  startScreen = null;
  lastScreen = null;
  await window.snapTranslate.completeSelection(rect);
});

window.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape') {
    await window.snapTranslate.cancelSelection();
  }
});
