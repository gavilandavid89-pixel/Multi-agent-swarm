import { checkJavascriptSyntax } from '../services/codeChecks.js';

const delivery = [
  '### Archivo: index.html',
  '```html',
  '<!doctype html><html><head><title>Swarm browser smoke</title></head><body><main id="app">ready</main><script>document.documentElement.dataset.smoke = "ok";</script></body></html>',
  '```'
].join('\n');

const result = await checkJavascriptSyntax(delivery);
if (!result.ok || result.browserChecked !== false || !/NO EJECUTADA dentro del Worker/.test(result.message)) {
  console.error(result.message || 'La entrega HTML no fue correctamente delegada al runner aislado.');
  process.exitCode = 1;
} else {
  console.log('PASS: el Worker no ejecuta JavaScript HTML generado; el runner aislado es responsable de Chromium/Xvfb.');
}
