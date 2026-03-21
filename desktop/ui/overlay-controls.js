const closeBtn = document.getElementById('close');

async function closeOverlay() {
  await window.snapTranslate.closeOverlay();
}

window.snapTranslate.onOverlayControlsRender((payload) => {
  document.documentElement.dataset.controlSide = payload?.side || 'top';
});

closeBtn.addEventListener('click', closeOverlay);

window.addEventListener('keydown', async function handleKeydown(event) {
  if (event.key === 'Escape') {
    await closeOverlay();
  }
});
