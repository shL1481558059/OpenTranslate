import { setBasePath } from './vendor/webawesome/webawesome.js';

const basePath = new URL('./vendor/webawesome/', import.meta.url).href;
setBasePath(basePath);

await import('./vendor/webawesome/components/icon/icon.js');
