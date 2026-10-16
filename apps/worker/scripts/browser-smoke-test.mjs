import { checkJavascriptSyntax } from '../services/codeChecks.js';

const delivery = [
  '### Archivo: index.html',
  '```html',
  '<!doctype html><html><head><title>Swarm browser smoke</title></head><body><main id="app">ready</main><script>document.documentElement.dataset.smoke = "ok";</script></body></html>',
  '```'
].join('\n');

const result = await checkJavascriptSyntax(delivery);
if (!result.ok || result.browserChecked !== true) {
  console.error(result.message || 'La prueba de Chromium/Xvfb no se ejecutó.');
  process.exitCode = 1;
} else {
  console.log(result.message);
}
