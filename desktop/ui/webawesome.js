import { setBasePath } from '../../node_modules/@awesome.me/webawesome/dist-cdn/webawesome.js';

const basePath = new URL('../../node_modules/@awesome.me/webawesome/dist-cdn/', import.meta.url).href;
setBasePath(basePath);

await Promise.all([
  import('../../node_modules/@awesome.me/webawesome/dist-cdn/translations/zh-cn.js'),
  import('../../node_modules/@awesome.me/webawesome/dist-cdn/components/button/button.js'),
  import('../../node_modules/@awesome.me/webawesome/dist-cdn/components/callout/callout.js'),
  import('../../node_modules/@awesome.me/webawesome/dist-cdn/components/input/input.js'),
  import('../../node_modules/@awesome.me/webawesome/dist-cdn/components/option/option.js'),
  import('../../node_modules/@awesome.me/webawesome/dist-cdn/components/select/select.js'),
  import('../../node_modules/@awesome.me/webawesome/dist-cdn/components/switch/switch.js'),
  import('../../node_modules/@awesome.me/webawesome/dist-cdn/components/textarea/textarea.js')
]);
