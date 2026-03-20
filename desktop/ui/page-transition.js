const EXIT_DURATION_MS = 190;
const validDirections = new Set(['forward', 'back']);

function getPageRoot() {
  return document.querySelector('.shell') || document.querySelector('.page');
}

function getDirectionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const nav = params.get('nav');
  return validDirections.has(nav) ? nav : '';
}

export function initPageTransition() {
  const page = getPageRoot();
  const direction = getDirectionFromUrl();

  if (!page || !direction) {
    return;
  }

  page.classList.add('page-entering', `page-enter-${direction}`);
  window.requestAnimationFrame(() => {
    page.classList.add('page-enter-active');
  });

  window.setTimeout(() => {
    page.classList.remove('page-entering', `page-enter-${direction}`, 'page-enter-active');
  }, 280);
}

export async function navigateWithTransition(openPage, direction) {
  const page = getPageRoot();

  if (!page || !validDirections.has(direction)) {
    return openPage({});
  }

  if (page.dataset.transitioning === 'true') {
    return;
  }

  page.dataset.transitioning = 'true';
  page.classList.add('page-leaving', `page-leave-${direction}`);

  await new Promise((resolve) => window.setTimeout(resolve, EXIT_DURATION_MS));

  try {
    await openPage({ nav: direction });
  } catch (error) {
    page.dataset.transitioning = 'false';
    page.classList.remove('page-leaving', `page-leave-${direction}`);
    throw error;
  }
}
