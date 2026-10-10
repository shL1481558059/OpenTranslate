import { setBasePath } from './vendor/webawesome/webawesome.js';

const basePath = new URL('./vendor/webawesome/', import.meta.url).href;
setBasePath(basePath);

await Promise.all([
  import('./vendor/webawesome/translations/zh-cn.js'),
  import('./vendor/webawesome/components/button/button.js'),
  import('./vendor/webawesome/components/callout/callout.js'),
  import('./vendor/webawesome/components/input/input.js'),
  import('./vendor/webawesome/components/option/option.js'),
  import('./vendor/webawesome/components/select/select.js'),
  import('./vendor/webawesome/components/switch/switch.js'),
  import('./vendor/webawesome/components/textarea/textarea.js')
]);
