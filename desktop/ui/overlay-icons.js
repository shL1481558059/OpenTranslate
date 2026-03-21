import { setBasePath } from '../../node_modules/@awesome.me/webawesome/dist-cdn/webawesome.js';

const basePath = new URL('../../node_modules/@awesome.me/webawesome/dist-cdn/', import.meta.url).href;
setBasePath(basePath);

await import('../../node_modules/@awesome.me/webawesome/dist-cdn/components/icon/icon.js');
